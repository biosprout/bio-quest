#!/usr/bin/env node
// 既存問題の品質 audit。選択肢長の手がかりと、解説の要確認候補を機械的に洗い出す。
//
//   node scripts/audit-question-quality.mjs                     # index.html の全問題
//   node scripts/audit-question-quality.mjs --batch <file.json> # batch の items を対象に
//   node scripts/audit-question-quality.mjs --md <out.md>       # Markdown レポートを書き出す
//   node scripts/audit-question-quality.mjs --json <out.json>
//   node scripts/audit-question-quality.mjs --limit 40          # 一覧の表示件数（既定 60、0 で全件）
//
// このツールは判定するだけで、問題文・選択肢・解説を書き換えない。
// flag は Academic つむぎのレビュー優先順位づけにだけ使う。

import fs from 'node:fs';
import path from 'node:path';
import {
  STRONG_DIFF, STRONG_RATIO, choiceStats, extractFields, extractLevels, extractQuestions,
  gitInfo, itemSha256, jstIso, readIndexHtml, repoRoot
} from './lib/questions.mjs';

// strong flag のしきい値は scripts/lib/questions.mjs（CONTENT_SPEC と揃える）
// 解説 audit のしきい値
const EX_SHORT = 30;

// 強い限定語。「正常に」「非常に」のような部分一致と、「〜常に…とは限らない」のような
// 否定を伴う正しい用法は誤検出になるため、後段の findAbsolutes で除外する。
const ABSOLUTE_WORDS = ['必ず', '常に', '完全に', 'のみ', '例外なく', 'すべての', '絶対に', '100%'];
const ABSOLUTE_PREFIX_EXCLUDE = { '常に': ['正', '非', '通'] };
const NEGATION_AFTER = ['ない', '限らない', 'わけではない', 'とは言えない', 'とは限ら'];

// 語が「限定を主張している」ときだけ拾う
function findAbsolutes(text) {
  const hits = [];
  for (const word of ABSOLUTE_WORDS) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(word, from);
      if (at < 0) break;
      from = at + word.length;
      const before = at > 0 ? text[at - 1] : '';
      const excl = ABSOLUTE_PREFIX_EXCLUDE[word];
      if (excl && excl.includes(before)) continue;                 // 正常に / 非常に / 通常に
      const tail = text.slice(from, from + 30);
      if (NEGATION_AFTER.some(n => tail.includes(n))) continue;    // 〜とは限らない
      hits.push(word);
      break;
    }
  }
  return hits;
}
const HEDGE_WORDS = ['主に', '一般に', '多くの場合', '通常', '典型的', 'ことが多い', '場合が多い', 'おおむね', 'とされる', '傾向がある'];
const CAUSAL_WORDS = ['ため', 'ので', 'よって', 'により', 'から', '理由', '機構', '機序', '過程', 'ことで', '結果'];
// 問題文が対象や条件を限定している合図
const SCOPE_WORDS = ['ヒト', '哺乳類', '両生類', '鳥類', '魚類', '爬虫類', '被子植物', '裸子植物', 'コケ', 'シダ',
  '原核', '真核', '古細菌', '細菌', '菌類', '安静時', '初期', '成熟', 'C3', 'C4', 'CAM', 'temperate', '温帯', '寒冷'];

function parseArgs(argv) {
  const out = { batch: null, md: null, json: null, limit: 60 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--batch') out.batch = argv[++i];
    else if (a === '--md') out.md = argv[++i];
    else if (a === '--json') out.json = argv[++i];
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/audit-question-quality.mjs [--batch <file>] [--md <out>] [--json <out>] [--limit N]');
      process.exit(0);
    } else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

const glen = s => [...String(s)].length;   // Unicode コードポイント数
const has = (text, words) => words.some(w => text.includes(w));

const analyseChoices = choiceStats;

function analyseExplanation(item) {
  const ex = String(item.ex);
  const q = String(item.q);
  const answer = String(item.ch[item.a]);
  const flags = [];
  if (glen(ex) < EX_SHORT) flags.push('short_explanation');
  const strippedAnswer = answer.replace(/[（(].*?[）)]/g, '');
  if (ex.includes(strippedAnswer) && glen(ex) < glen(answer) * 2.5 && !has(ex, CAUSAL_WORDS)) {
    flags.push('restates_answer_only');
  }
  const absolutes = findAbsolutes(ex);
  if (absolutes.length) flags.push('absolute_wording');
  if (/[0-9]/.test(ex) && /(%|％|個|回|倍|分|秒|時間|日|年|世紀|mol|kJ|mmHg|mL|nm|kDa|℃|pH)/.test(ex)) {
    flags.push('numeric_claim');
  }
  if (has(q, SCOPE_WORDS) && !has(ex, HEDGE_WORDS)) flags.push('scope_generalization_candidate');
  return { flags, absolutes };
}

function binomial(n, k, p = 0.25) {
  const mean = n * p;
  const sd = Math.sqrt(n * p * (1 - p));
  return { expected: mean, sd, z: sd > 0 ? (k - mean) / sd : 0 };
}

function summarise(items, label) {
  const rows = items.map(item => ({ item, c: analyseChoices(item), e: analyseExplanation(item) }));
  const uniqueLongest = rows.filter(r => r.c.uniqueLongest).length;
  const correctLongest = rows.filter(r => r.c.isLongest).length;
  const uniqueShortest = rows.filter(r => r.c.uniqueShortest).length;
  const correctShortest = rows.filter(r => r.c.isShortest).length;
  const strong = rows.filter(r => r.c.strong).length;
  return {
    label,
    n: items.length,
    uniqueLongest, correctLongest, longStat: binomial(uniqueLongest, correctLongest),
    uniqueShortest, correctShortest, shortStat: binomial(uniqueShortest, correctShortest),
    strong,
    rows
  };
}

function groupBy(rows, key) {
  const out = new Map();
  for (const r of rows) {
    const k = r.item[key];
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(r);
  }
  return out;
}

function groupStats(rows) {
  const uniqueLongest = rows.filter(r => r.c.uniqueLongest).length;
  const correctLongest = rows.filter(r => r.c.isLongest).length;
  return { n: rows.length, uniqueLongest, correctLongest, strong: rows.filter(r => r.c.strong).length,
    stat: binomial(uniqueLongest, correctLongest) };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = repoRoot();
  let items, sourceLabel, meta;

  let beforeItems = null;   // correction batch のときだけ、修正前の同じ問題群
  if (args.batch) {
    const batch = JSON.parse(fs.readFileSync(path.resolve(args.batch), 'utf8'));
    if (Array.isArray(batch.updates) && batch.updates.length) {
      // correction batch: 現行データに set を当てた「修正後」を対象にする
      const currentById = new Map(extractQuestions(readIndexHtml(root)).map(q => [q.id, q]));
      beforeItems = [];
      items = batch.updates.map(u => {
        const cur = currentById.get(u.id);
        if (!cur) throw new Error(`batch の id が現行データにありません: ${u.id}`);
        beforeItems.push(cur);
        return { ...cur, ...(u.set || {}) };
      });
      sourceLabel = `${batch.batch_id || path.basename(args.batch)} (correction 適用後)`;
      meta = { kind: 'correction_batch', batch_id: batch.batch_id, updates: batch.updates.length };
    } else {
      items = Array.isArray(batch.items) ? batch.items
        : (batch.changes || []).flatMap(c => c.items || []);
      if (!items.length) throw new Error('batch に items も updates もありません');
      sourceLabel = batch.batch_id || path.basename(args.batch);
      meta = { kind: 'batch', batch_id: batch.batch_id };
    }
  } else {
    const html = readIndexHtml(root);
    items = extractQuestions(html);
    const git = gitInfo(root);
    sourceLabel = `index.html (commit ${git.commit.slice(0, 7)})`;
    meta = { kind: 'repo', commit: git.commit, branch: git.branch, worktree_clean: git.status === '' };
  }

  const s = summarise(items, sourceLabel);
  const fieldOrder = args.batch ? [...new Set(items.map(i => i.f))] : extractFields(readIndexHtml(root)).map(f => f[0]);
  const levelOrder = args.batch ? [...new Set(items.map(i => i.lv))] : Object.keys(extractLevels(readIndexHtml(root)));

  const byField = groupBy(s.rows, 'f');
  const byLevel = groupBy(s.rows, 'lv');

  const pad = (v, n) => String(v).padStart(n);
  const fx = v => (Number.isFinite(v) ? v.toFixed(2) : '-');

  console.log(`BIO QUEST quality audit  ${sourceLabel}`);
  console.log(`  対象 ${s.n} 問`);
  console.log();
  console.log('  [選択肢長]');
  console.log(`    単独最長の選択肢がある問題      ${pad(s.uniqueLongest, 4)}`);
  console.log(`    うち正答が単独最長              ${pad(s.correctLongest, 4)}  (${(s.correctLongest / (s.n || 1) * 100).toFixed(1)}% of all)`);
  console.log(`    ランダム期待 (U/4)              ${pad(s.longStat.expected.toFixed(2), 4)}   z = ${fx(s.longStat.z)}`);
  console.log(`    strong flag                     ${pad(s.strong, 4)}`);
  console.log(`    単独最短の選択肢がある問題      ${pad(s.uniqueShortest, 4)}`);
  console.log(`    うち正答が単独最短              ${pad(s.correctShortest, 4)}   期待 ${s.shortStat.expected.toFixed(2)}  z = ${fx(s.shortStat.z)}`);
  console.log();
  console.log('  [level 別]  問数 / 正答が単独最長 / strong');
  for (const lv of levelOrder) {
    const g = byLevel.get(lv); if (!g) continue;
    const st = groupStats(g);
    console.log(`    ${lv.padEnd(6)}${pad(st.n, 5)}${pad(st.correctLongest, 7)} (${(st.correctLongest / st.n * 100).toFixed(1)}%)${pad(st.strong, 7)}`);
  }
  console.log();
  console.log('  [field 別]  問数 / 正答が単独最長 / strong');
  for (const f of fieldOrder) {
    const g = byField.get(f); if (!g) continue;
    const st = groupStats(g);
    console.log(`    ${f.padEnd(6)}${pad(st.n, 5)}${pad(st.correctLongest, 7)} (${(st.correctLongest / st.n * 100).toFixed(1)}%)${pad(st.strong, 7)}`);
  }

  if (beforeItems) {
    const b = summarise(beforeItems, 'before');
    const line = (t, x) => `    ${t.padEnd(22)}${pad(x.correctLongest, 5)}${pad(x.uniqueLongest, 8)}${pad(x.longStat.expected.toFixed(2), 9)}${pad(fx(x.longStat.z), 8)}${pad(x.strong, 9)}${pad(x.correctShortest, 9)}`;
    console.log();
    console.log('  [修正前後の比較]  正答が単独最長 / 単独最長あり / 期待 / z / strong / 正答が単独最短');
    console.log(line('修正前', b));
    console.log(line('修正後', s));
    const bex = b.rows.filter(r => r.e.flags.length).length;
    const aex = s.rows.filter(r => r.e.flags.length).length;
    console.log(`    ${'解説 flag ありの問題'.padEnd(18)}${pad(bex, 5)} -> ${aex}`);
  }

  const exFlagCounts = {};
  for (const r of s.rows) for (const f of r.e.flags) exFlagCounts[f] = (exFlagCounts[f] || 0) + 1;
  console.log();
  console.log('  [解説 review queue]  自動判定は誤りの断定ではない');
  for (const [k, v] of Object.entries(exFlagCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k.padEnd(32)}${pad(v, 4)}`);
  }
  const anyEx = s.rows.filter(r => r.e.flags.length).length;
  console.log(`    ${'解説 flag が1つ以上'.padEnd(28)}${pad(anyEx, 4)}`);

  const strongRows = s.rows.filter(r => r.c.strong)
    .sort((a, b) => (b.c.diff - a.c.diff) || (b.c.ratio - a.c.ratio));
  const limit = args.limit === 0 ? strongRows.length : args.limit;
  console.log();
  console.log(`  [strong flag 上位 ${Math.min(limit, strongRows.length)} / ${strongRows.length}]`);
  console.log(`    ${'id'.padEnd(9)}${'f'.padEnd(7)}${'lv'.padEnd(6)}${pad('正答', 5)}${pad('2位', 5)}${pad('差', 4)}${pad('比', 6)}  問題文`);
  for (const r of strongRows.slice(0, limit)) {
    console.log(`    ${r.item.id.padEnd(9)}${r.item.f.padEnd(7)}${r.item.lv.padEnd(6)}${pad(r.c.correct, 5)}${pad(r.c.secondHigh, 5)}${pad(r.c.diff, 4)}${pad(fx(r.c.ratio), 6)}  ${r.item.q.slice(0, 40)}`);
  }

  const detail = s.rows.map(r => ({
    id: r.item.id, f: r.item.f, lv: r.item.lv,
    sha256: itemSha256(r.item),
    choice_lengths: r.c.lens,
    answer_index: r.item.a,
    answer_length: r.c.correct,
    answer_rank: r.c.rank,
    unique_longest_exists: r.c.uniqueLongest,
    answer_is_unique_longest: r.c.isLongest,
    answer_is_unique_shortest: r.c.isShortest,
    diff_to_second: r.c.diff,
    ratio_to_second: r.c.ratio === null ? null : Number(r.c.ratio.toFixed(3)),
    strong_flag: r.c.strong,
    explanation_length: glen(r.item.ex),
    explanation_flags: r.e.flags,
    absolute_words: r.e.absolutes,
    q: r.item.q
  }));

  if (args.json) {
    const out = {
      schema_version: 1, generated_at: jstIso(), source: { label: sourceLabel, ...meta },
      thresholds: { strong_diff: STRONG_DIFF, strong_ratio: STRONG_RATIO, short_explanation: EX_SHORT },
      summary: {
        n: s.n,
        unique_longest_exists: s.uniqueLongest, answer_unique_longest: s.correctLongest,
        random_expected: Number(s.longStat.expected.toFixed(2)), z: Number(s.longStat.z.toFixed(2)),
        strong_flag: s.strong,
        unique_shortest_exists: s.uniqueShortest, answer_unique_shortest: s.correctShortest,
        shortest_expected: Number(s.shortStat.expected.toFixed(2)), shortest_z: Number(s.shortStat.z.toFixed(2)),
        explanation_flags: exFlagCounts, items_with_explanation_flag: anyEx
      },
      by_level: Object.fromEntries(levelOrder.filter(l => byLevel.has(l)).map(l => [l, groupStats(byLevel.get(l))])),
      by_field: Object.fromEntries(fieldOrder.filter(f => byField.has(f)).map(f => [f, groupStats(byField.get(f))])),
      items: detail
    };
    fs.mkdirSync(path.dirname(path.resolve(args.json)), { recursive: true });
    fs.writeFileSync(path.resolve(args.json), JSON.stringify(out, null, 2) + '\n');
    console.log(`\n  wrote: ${path.resolve(args.json)}`);
  }

  if (args.md) {
    const L = [];
    L.push('# BIO QUEST quality audit');
    L.push('');
    L.push(`対象: ${sourceLabel}  /  ${s.n} 問  /  生成 ${jstIso()}`);
    L.push('');
    L.push('`node scripts/audit-question-quality.mjs` の出力。機械判定であり、誤りの断定ではない。');
    L.push('長さは Unicode コードポイント数。ランダム期待は「単独最長が存在する問題数 / 4」。');
    L.push('');
    L.push('## 選択肢長');
    L.push('');
    L.push('| 指標 | 値 |');
    L.push('| --- | ---: |');
    L.push(`| 問数 | ${s.n} |`);
    L.push(`| 単独最長の選択肢がある問題 | ${s.uniqueLongest} |`);
    L.push(`| 正答が単独最長 | ${s.correctLongest} |`);
    L.push(`| ランダム期待 | ${s.longStat.expected.toFixed(2)} |`);
    L.push(`| z | ${fx(s.longStat.z)} |`);
    L.push(`| strong flag | ${s.strong} |`);
    L.push(`| 正答が単独最短 | ${s.correctShortest} （期待 ${s.shortStat.expected.toFixed(2)}, z ${fx(s.shortStat.z)}） |`);
    L.push('');
    L.push('## level 別');
    L.push('');
    L.push('| level | 問数 | 正答が単独最長 | strong |');
    L.push('| --- | ---: | ---: | ---: |');
    for (const lv of levelOrder) {
      const g = byLevel.get(lv); if (!g) continue;
      const st = groupStats(g);
      L.push(`| ${lv} | ${st.n} | ${st.correctLongest} (${(st.correctLongest / st.n * 100).toFixed(1)}%) | ${st.strong} |`);
    }
    L.push('');
    L.push('## field 別');
    L.push('');
    L.push('| field | 問数 | 正答が単独最長 | strong |');
    L.push('| --- | ---: | ---: | ---: |');
    for (const f of fieldOrder) {
      const g = byField.get(f); if (!g) continue;
      const st = groupStats(g);
      L.push(`| ${f} | ${st.n} | ${st.correctLongest} (${(st.correctLongest / st.n * 100).toFixed(1)}%) | ${st.strong} |`);
    }
    L.push('');
    L.push('## 解説 review queue');
    L.push('');
    L.push('| flag | 件数 | 意味 |');
    L.push('| --- | ---: | --- |');
    const meanings = {
      short_explanation: `${EX_SHORT} 文字未満`,
      restates_answer_only: '正答の言い換えに近く、理由や機序の語がない',
      absolute_wording: '必ず / 常に / 完全に / のみ など強い限定語を含む',
      numeric_claim: '数値と単位を含み、事実確認が要る',
      scope_generalization_candidate: '問題文が生物群や条件を限定しているのに、解説に限定語がない'
    };
    for (const [k, v] of Object.entries(exFlagCounts).sort((a, b) => b[1] - a[1])) {
      L.push(`| \`${k}\` | ${v} | ${meanings[k] || ''} |`);
    }
    L.push(`| **1つ以上** | **${anyEx}** | |`);
    L.push('');
    L.push('## strong flag 一覧');
    L.push('');
    L.push('正答が単独最長で、2位より 4 文字以上長い、または 1.20 倍以上長いもの。');
    L.push('');
    L.push('| id | field | level | 正答長 | 2位長 | 差 | 比 | 解説flag | 問題文 |');
    L.push('| --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- |');
    for (const r of strongRows) {
      L.push(`| \`${r.item.id}\` | ${r.item.f} | ${r.item.lv} | ${r.c.correct} | ${r.c.secondHigh} | ${r.c.diff} | ${fx(r.c.ratio)} | ${r.e.flags.join(', ') || '-'} | ${r.item.q.replace(/\|/g, '/')} |`);
    }
    L.push('');
    fs.mkdirSync(path.dirname(path.resolve(args.md)), { recursive: true });
    fs.writeFileSync(path.resolve(args.md), L.join('\n') + '\n');
    console.log(`  wrote: ${path.resolve(args.md)}`);
  }
}

try { main(); } catch (error) { console.error(`ERROR: ${error.message}`); process.exit(1); }
