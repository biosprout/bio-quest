#!/usr/bin/env node
// Academic つむぎが作った既存問題の修正 batch を、ID と学習履歴を保ったまま適用する。
//
//   node scripts/import-question-corrections.mjs <batch.json>            # dry run（既定）
//   node scripts/import-question-corrections.mjs <batch.json> --apply    # 適用
//   optional: --report <path>   Markdown レポートを書き出す
//             --limit N         dry run で詳細表示する件数（既定 12、0 で全件）
//
// 変更できるのは q / ch / a / ex だけ。id / f / lv は変更しない。
// 問題文・選択肢・解説の内容判断はつむぎ側。ここでは一切生成・書き換えをしない。
// commit / push はしない。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  CHOICE_COUNT, FIELD_PREFIX, LEVEL_LETTER, QUESTION_KEYS, TOTAL_COUNT_PATTERNS,
  choiceStats, extractAppVer, extractFields, extractLevels, extractQuestions, gitInfo,
  itemSha256, jstIso, locateArray, nextAppVer, normalizeText, readIndexHtml, readManifest,
  repoRoot, serializeQuestion, setAppVer, syncTotalCount, tallyQuestions
} from './lib/questions.mjs';

const REQUIRED_QA_FIELDS = Object.freeze([
  'schema_checked',
  'id_and_hash_checked',
  'single_correct_answer_checked',
  'choice_parallelism_checked',
  'choice_length_cue_checked',
  'explanation_checked',
  'factual_accuracy_checked',
  'level_appropriateness_checked'
]);

const SETTABLE = Object.freeze(['q', 'ch', 'a', 'ex']);
const IMMUTABLE = Object.freeze(['id', 'f', 'lv']);
const SCRIPT_END = /<\/script/i;
const glen = s => [...String(s)].length;

function hasControlChar(value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function fail(message) { throw new Error(message); }

function parseArgs(argv) {
  const out = { batch: null, apply: false, report: null, limit: 12 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--report') out.report = argv[++i];
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
    else if (a.startsWith('-')) fail(`Unknown argument: ${a}`);
    else if (!out.batch) out.batch = a;
    else fail(`batch file は1つだけ指定してください: ${a}`);
  }
  if (!out.batch) { usage(); fail('batch file を指定してください'); }
  return out;
}

function usage() {
  console.log('Usage: node scripts/import-question-corrections.mjs <batch.json> [--apply] [--report <path>] [--limit N]');
}

function validateEnvelope(batch, batchPath) {
  if (batch.schema_version !== 1) fail('schema_version は 1 にしてください');
  if (batch.status !== 'ready') fail(`status は "ready" のものだけ取り込みます（現在: ${batch.status}）`);
  if (batch.subject !== 'bio-quest') fail(`subject は "bio-quest" にしてください（現在: ${batch.subject}）`);
  if (typeof batch.batch_id !== 'string' || !batch.batch_id.trim()) fail('batch_id は必須です');
  if (path.basename(batchPath, '.json') !== batch.batch_id) {
    fail(`batch_id とファイル名が一致しません（batch_id: ${batch.batch_id}, file: ${path.basename(batchPath)}）`);
  }
  if (Array.isArray(batch.items) && batch.items.length) {
    fail('この tool は既存問題の修正専用です。新規追加は scripts/import-question-batch.mjs を使ってください');
  }
  if (!Array.isArray(batch.updates) || !batch.updates.length) fail('updates が空です');
  if (!batch.source || batch.source.repo !== 'biosprout/bio-quest') fail('source.repo は "biosprout/bio-quest" にしてください');
  if (batch.source.branch !== 'main') fail('source.branch は "main" にしてください');
  if (typeof batch.source.commit !== 'string' || !/^[0-9a-f]{7,40}$/.test(batch.source.commit)) {
    fail('source.commit には snapshot の commit hash を入れてください');
  }
  if (!batch.qa || typeof batch.qa !== 'object') fail('qa は必須です');
  const missing = REQUIRED_QA_FIELDS.filter(f => batch.qa[f] !== true);
  if (missing.length) fail(`ready batch の QA flag が未完了です: ${missing.join(', ')}`);
}

// set を当てた後の item を作る。key 順は既定順に揃える。
function buildNext(current, set) {
  const next = {};
  for (const key of QUESTION_KEYS) next[key] = current[key];
  for (const [key, value] of Object.entries(set)) {
    next[key] = Array.isArray(value) ? value.slice() : value;
  }
  return next;
}

function validateNextItem(item, label, fieldIds, levelIds) {
  const keys = Object.keys(item);
  if (keys.join(',') !== QUESTION_KEYS.join(',')) {
    fail(`${label}: 適用後の property が ${QUESTION_KEYS.join(',')} になりません（${keys.join(',')}）`);
  }
  for (const key of ['id', 'f', 'lv', 'q', 'ex']) {
    if (typeof item[key] !== 'string' || !item[key].trim()) fail(`${label}.${key}: 空でない文字列にしてください`);
    if (hasControlChar(item[key])) fail(`${label}.${key}: 制御文字が含まれています`);
    if (SCRIPT_END.test(item[key])) fail(`${label}.${key}: "</script" を含めることはできません`);
  }
  if (!fieldIds.includes(item.f)) fail(`${label}.f: 未知の分野 "${item.f}"`);
  if (!levelIds.includes(item.lv)) fail(`${label}.lv: 未知のレベル "${item.lv}"`);
  const head = `${FIELD_PREFIX[item.f]}_${LEVEL_LETTER[item.lv]}`;
  if (!new RegExp(`^${head}([1-9][0-9]*)$`).test(item.id)) fail(`${label}.id: 分野/レベルと ID の対応が壊れています`);
  if (!Array.isArray(item.ch)) fail(`${label}.ch: 配列にしてください`);
  if (item.ch.length !== CHOICE_COUNT) fail(`${label}.ch: 選択肢は ${CHOICE_COUNT} 個です（実際: ${item.ch.length}）`);
  item.ch.forEach((c, k) => {
    if (typeof c !== 'string' || !c.trim()) fail(`${label}.ch[${k}]: 空でない文字列にしてください`);
    if (hasControlChar(c)) fail(`${label}.ch[${k}]: 制御文字が含まれています`);
    if (SCRIPT_END.test(c)) fail(`${label}.ch[${k}]: "</script" を含めることはできません`);
  });
  const norm = item.ch.map(normalizeText);
  if (new Set(norm).size !== norm.length) fail(`${label}.ch: 選択肢が重複しています`);
  if (!Number.isInteger(item.a) || item.a < 0 || item.a >= CHOICE_COUNT) {
    fail(`${label}.a: 0 以上 ${CHOICE_COUNT - 1} 以下の整数にしてください（実際: ${JSON.stringify(item.a)}）`);
  }
}

// const Q=[...] の該当行だけを差し替える。字下げと末尾カンマは元のまま残す。
function replaceLines(html, replacements) {
  const block = locateArray(html, 'Q');
  const lines = block.literal.split('\n');
  for (const { index, current, next } of replacements) {
    const lineNo = index + 1;                       // lines[0] は "["
    const raw = lines[lineNo];
    if (raw === undefined) fail(`内部エラー: 行 ${lineNo} が見つかりません（${current.id}）`);
    const indent = raw.match(/^\s*/)[0];
    const trailing = raw.trimEnd().endsWith(',') ? ',' : '';
    const expected = serializeQuestion(current).trim();
    if (raw.trim().replace(/,$/, '') !== expected) {
      fail(`内部エラー: ${current.id} の行が想定と一致しません。手で編集された可能性があります`);
    }
    lines[lineNo] = indent + serializeQuestion(next).trim() + trailing;
  }
  return html.slice(0, block.start) + lines.join('\n') + html.slice(block.end);
}

function fmtRatio(v) { return v === null || !Number.isFinite(v) ? '-' : v.toFixed(2); }

function statLine(s) {
  const tags = [];
  if (s.isLongest) tags.push('正答が単独最長');
  if (s.isShortest) tags.push('正答が単独最短');
  if (s.strong) tags.push('STRONG');
  return `[${s.lens.join(',')}] 正答長 ${s.correct} / 順位 ${s.rank} / 2位差 ${s.diff} / 比 ${fmtRatio(s.ratio)}${tags.length ? '  ' + tags.join(' ') : ''}`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = repoRoot();
  const batchPath = path.resolve(args.batch);
  const batch = JSON.parse(fs.readFileSync(batchPath, 'utf8'));
  validateEnvelope(batch, batchPath);

  const git = gitInfo(root);
  if (git.branch !== 'main') fail(`current branch が main ではありません: ${git.branch || '(detached)'}`);
  if (git.status) fail(`worktree に未 commit の変更があります:\n${git.status}`);
  const sourceCommitMatched = git.commit.startsWith(batch.source.commit);

  const htmlBefore = readIndexHtml(root);
  const manifestBefore = readManifest(root);
  const fields = extractFields(htmlBefore);
  const levels = extractLevels(htmlBefore);
  const fieldIds = fields.map(f => f[0]);
  const levelIds = Object.keys(levels);
  const current = extractQuestions(htmlBefore);
  const indexById = new Map(current.map((item, i) => [item.id, i]));
  const tallyBefore = tallyQuestions(current, fields, levels);

  if (Number.isInteger(batch.expected_count_before) && batch.expected_count_before !== tallyBefore.total) {
    fail(`expected_count_before=${batch.expected_count_before} ですが、実際は ${tallyBefore.total} 問です`);
  }

  // ---- 1. 全 update を検証（hash 不一致は1件でも batch 全体を失敗させる） ----
  const seen = new Set();
  const mismatches = [];
  const plans = [];
  batch.updates.forEach((u, i) => {
    const label = `updates[${i}]${u && typeof u.id === 'string' ? ` (${u.id})` : ''}`;
    if (!u || typeof u !== 'object' || Array.isArray(u)) fail(`${label}: object ではありません`);
    if (typeof u.id !== 'string' || !u.id.trim()) fail(`${label}: id は必須です`);
    if (seen.has(u.id)) fail(`${label}: 同じ id が batch 内に複数あります`);
    seen.add(u.id);
    if (!indexById.has(u.id)) fail(`${label}: この id は存在しません。新規追加は import-question-batch.mjs を使ってください`);
    if (typeof u.expected_item_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(u.expected_item_sha256)) {
      fail(`${label}: expected_item_sha256（64桁hex）は必須です`);
    }
    if (!u.set || typeof u.set !== 'object' || Array.isArray(u.set)) fail(`${label}.set: object にしてください`);
    const setKeys = Object.keys(u.set);
    if (!setKeys.length) fail(`${label}.set: 空です`);
    const bad = setKeys.filter(k => !SETTABLE.includes(k));
    if (bad.length) {
      const immutable = bad.filter(k => IMMUTABLE.includes(k));
      if (immutable.length) {
        fail(`${label}.set: ${immutable.join(', ')} は変更できません。`
          + `id は学習履歴の key、f/lv の変更は別の migration operation が必要です`);
      }
      fail(`${label}.set: 未知の field ${bad.join(', ')}（変更できるのは ${SETTABLE.join(', ')}）`);
    }

    const idx = indexById.get(u.id);
    const cur = current[idx];
    const actual = itemSha256(cur);
    if (actual !== u.expected_item_sha256) {
      mismatches.push({ id: u.id, expected: u.expected_item_sha256, actual });
      return;
    }
    const next = buildNext(cur, u.set);
    validateNextItem(next, label, fieldIds, levelIds);
    const changed = SETTABLE.filter(k => JSON.stringify(cur[k]) !== JSON.stringify(next[k]));
    plans.push({ index: idx, id: u.id, current: cur, next, changed, reasons: Array.isArray(u.reasons) ? u.reasons : [] });
  });

  if (mismatches.length) {
    console.error(`ERROR: item hash が一致しません（${mismatches.length} 件）。batch 全体を取り込みません。`);
    for (const m of mismatches) {
      console.error(`  ${m.id}\n    expected ${m.expected}\n    actual   ${m.actual}`);
    }
    console.error('  snapshot を更新して batch を作り直してください。');
    process.exit(1);
  }

  const noop = plans.filter(p => !p.changed.length);
  if (noop.length === plans.length) fail('すべての update が現状と同じ内容です');

  // 修正後に問題文が他と完全一致しないか
  const qMap = new Map();
  const after = current.map((item, i) => {
    const p = plans.find(x => x.index === i);
    return p ? p.next : item;
  });
  for (const item of after) {
    const key = normalizeText(item.q);
    if (qMap.has(key)) fail(`修正後に問題文が完全一致します: ${qMap.get(key)} と ${item.id}`);
    qMap.set(key, item.id);
  }

  const tallyAfter = tallyQuestions(after, fields, levels);
  if (tallyAfter.total !== tallyBefore.total) fail('内部エラー: correction で問題数が変化しました');

  const appVerBefore = extractAppVer(htmlBefore);
  const appVerAfter = nextAppVer(appVerBefore);

  // ---- 2. dry-run レポート ----
  const beforeStats = plans.map(p => choiceStats(p.current));
  const afterStats = plans.map(p => choiceStats(p.next));
  const cnt = arr => ({
    longest: arr.filter(s => s.isLongest).length,
    shortest: arr.filter(s => s.isShortest).length,
    strong: arr.filter(s => s.strong).length
  });
  const bAgg = cnt(beforeStats);
  const aAgg = cnt(afterStats);

  console.log(JSON.stringify({
    status: args.apply ? 'applying' : 'dry_run_ok',
    batch_id: batch.batch_id,
    head: git.commit,
    source_commit_matched: sourceCommitMatched,
    total: tallyBefore.total,
    updates: plans.length,
    no_change: noop.map(p => p.id),
    changed_fields: Object.fromEntries(SETTABLE.map(k => [k, plans.filter(p => p.changed.includes(k)).length])),
    app_ver: `${appVerBefore} -> ${appVerAfter}`,
    choice_cue: {
      before: bAgg, after: aAgg,
      note: '対象 update 内での件数。全体統計は audit-question-quality.mjs で確認する'
    }
  }, null, 2));

  if (!sourceCommitMatched) {
    console.log(`\n  ! source.commit ${batch.source.commit} は HEAD ${git.commit.slice(0, 7)} と違いますが、`
      + '対象 item の hash はすべて一致したので続行できます。');
  }

  const limit = args.limit === 0 ? plans.length : args.limit;
  console.log(`\n=== 変更内容（${Math.min(limit, plans.length)} / ${plans.length} 件）===`);
  plans.slice(0, limit).forEach((p, i) => {
    const bs = beforeStats[plans.indexOf(p)] || choiceStats(p.current);
    const as = afterStats[plans.indexOf(p)] || choiceStats(p.next);
    console.log(`\n--- ${p.id}  ${p.current.f}/${p.current.lv}  変更: ${p.changed.join(', ') || '(なし)'}`
      + `${p.reasons.length ? '  reasons: ' + p.reasons.join(', ') : ''}`);
    if (p.changed.includes('q')) {
      console.log(`  Q before: ${p.current.q}`);
      console.log(`  Q after : ${p.next.q}`);
    } else {
      console.log(`  Q       : ${p.current.q}`);
    }
    if (p.changed.includes('ch') || p.changed.includes('a')) {
      console.log('  選択肢 before:');
      p.current.ch.forEach((c, k) => console.log(`    ${k === p.current.a ? '*' : ' '}${k} ${c}  (${glen(c)})`));
      console.log('  選択肢 after :');
      p.next.ch.forEach((c, k) => console.log(`    ${k === p.next.a ? '*' : ' '}${k} ${c}  (${glen(c)})`));
      console.log(`  正答 before: ${p.current.ch[p.current.a]}`);
      console.log(`  正答 after : ${p.next.ch[p.next.a]}`);
    }
    console.log(`  長さ before: ${statLine(bs)}`);
    console.log(`  長さ after : ${statLine(as)}`);
    if (p.changed.includes('ex')) {
      console.log(`  解説 before: ${p.current.ex}`);
      console.log(`  解説 after : ${p.next.ex}`);
    }
  });
  if (plans.length > limit) console.log(`\n  （残り ${plans.length - limit} 件は --limit 0 で表示、または --report を使う）`);

  let validatorOutput = '';
  if (!args.apply) {
    console.log('\nDRY RUN OK  --apply を付けると index.html を書き換えます');
  } else {
    const backup = new Map([
      [path.join(root, 'index.html'), htmlBefore],
      [path.join(root, 'manifest.json'), manifestBefore]
    ]);
    try {
      // 書き込み直前に、現在のファイルから hash を取り直して再確認する
      const fresh = readIndexHtml(root);
      if (fresh !== htmlBefore) fail('実行中に index.html が変化しました');
      const freshItems = extractQuestions(fresh);
      for (const p of plans) {
        const actual = itemSha256(freshItems[p.index]);
        const expected = itemSha256(p.current);
        if (actual !== expected) fail(`適用直前の再確認で hash が変化しました: ${p.id}`);
      }

      let html = replaceLines(fresh, plans.filter(p => p.changed.length));
      html = setAppVer(html, appVerAfter);
      let manifest = manifestBefore;
      for (const pattern of TOTAL_COUNT_PATTERNS) {
        if (pattern.file === 'index.html') html = syncTotalCount(html, pattern, tallyAfter.total).text;
        else manifest = syncTotalCount(manifest, pattern, tallyAfter.total).text;
      }
      fs.writeFileSync(path.join(root, 'index.html'), html, 'utf8');
      if (manifest !== manifestBefore) fs.writeFileSync(path.join(root, 'manifest.json'), manifest, 'utf8');

      const validator = spawnSync(process.execPath, ['scripts/validate-content.mjs'], { cwd: root, encoding: 'utf8' });
      validatorOutput = [validator.stdout, validator.stderr].filter(Boolean).join('\n');
      if (validator.status !== 0) fail(`validator が失敗しました:\n${validatorOutput}`);

      // 適用結果が意図どおりか、書き戻したファイルから読み直して確認する
      const applied = extractQuestions(readIndexHtml(root));
      if (applied.length !== current.length) fail('適用後に問題数が変化しました');
      for (const p of plans) {
        if (itemSha256(applied[p.index]) !== itemSha256(p.next)) fail(`適用結果が期待と違います: ${p.id}`);
      }
      const untouched = current.filter((_, i) => !plans.some(p => p.index === i));
      const appliedUntouched = applied.filter((_, i) => !plans.some(p => p.index === i));
      for (let i = 0; i < untouched.length; i += 1) {
        if (itemSha256(untouched[i]) !== itemSha256(appliedUntouched[i])) {
          fail(`対象外の問題が変化しました: ${untouched[i].id}`);
        }
      }

      const modified = spawnSync('git', ['-C', root, 'diff', '--name-only'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
      const unexpected = modified.filter(f => !['index.html', 'manifest.json'].includes(f));
      if (unexpected.length) fail(`想定外のファイルが変更されました: ${unexpected.join(', ')}`);

      console.log('\nAPPLY OK');
      console.log(validatorOutput.trim());
      console.log(`\nchanged: ${modified.join(', ')}`);
      console.log('commit と push はしていません。git diff を確認してください。');
    } catch (error) {
      for (const [file, text] of backup.entries()) fs.writeFileSync(file, text, 'utf8');
      throw new Error(`取込に失敗したため index.html / manifest.json を元に戻しました。\n${error.message}`);
    }
  }

  if (args.report) {
    const L = [];
    L.push(`# ${batch.batch_id} correction report`);
    L.push('');
    L.push(`- Repo: biosprout/bio-quest / branch ${git.branch} / HEAD \`${git.commit}\``);
    L.push(`- source.commit: \`${batch.source.commit}\`${sourceCommitMatched ? '（一致）' : '（不一致・item hash は全件一致）'}`);
    L.push(`- Applied: ${args.apply ? 'yes' : 'no（dry run）'}  /  ${jstIso()}`);
    L.push(`- 対象 ${plans.length} 件、総問題数 ${tallyBefore.total}（変化なし）`);
    L.push(`- APP_VER: ${appVerBefore} -> ${args.apply ? appVerAfter : appVerAfter + '（dry run では未書き込み）'}`);
    L.push('');
    L.push('## 選択肢長の手がかり（対象 update 内）');
    L.push('');
    L.push('| 指標 | before | after |');
    L.push('| --- | ---: | ---: |');
    L.push(`| 正答が単独最長 | ${bAgg.longest} | ${aAgg.longest} |`);
    L.push(`| 正答が単独最短 | ${bAgg.shortest} | ${aAgg.shortest} |`);
    L.push(`| strong flag | ${bAgg.strong} | ${aAgg.strong} |`);
    L.push('');
    L.push('## 各 item');
    for (let i = 0; i < plans.length; i += 1) {
      const p = plans[i];
      const bs = beforeStats[i], as = afterStats[i];
      L.push('');
      L.push(`### \`${p.id}\`  ${p.current.f} / ${p.current.lv}`);
      L.push('');
      L.push(`- 変更 field: ${p.changed.join(', ') || '(なし)'}`);
      if (p.reasons.length) L.push(`- reasons: ${p.reasons.join(', ')}`);
      L.push(`- 選択肢長: before [${bs.lens.join(', ')}] -> after [${as.lens.join(', ')}]`);
      L.push(`- 正答の長さ順位: ${bs.rank} -> ${as.rank}、2位差 ${bs.diff} -> ${as.diff}、比 ${fmtRatio(bs.ratio)} -> ${fmtRatio(as.ratio)}`);
      L.push(`- strong flag: ${bs.strong ? 'yes' : 'no'} -> ${as.strong ? 'yes' : 'no'}`);
      L.push('');
      L.push('| | before | after |');
      L.push('| --- | --- | --- |');
      L.push(`| 問題文 | ${p.current.q.replace(/\|/g, '/')} | ${p.next.q.replace(/\|/g, '/')} |`);
      for (let k = 0; k < CHOICE_COUNT; k += 1) {
        const b = `${k === p.current.a ? '**' : ''}${p.current.ch[k].replace(/\|/g, '/')}${k === p.current.a ? '**' : ''}`;
        const a2 = `${k === p.next.a ? '**' : ''}${p.next.ch[k].replace(/\|/g, '/')}${k === p.next.a ? '**' : ''}`;
        L.push(`| 選択肢 ${k} | ${b} | ${a2} |`);
      }
      L.push(`| 正答 | ${p.current.ch[p.current.a].replace(/\|/g, '/')} | ${p.next.ch[p.next.a].replace(/\|/g, '/')} |`);
      L.push(`| 解説 | ${p.current.ex.replace(/\|/g, '/')} | ${p.next.ex.replace(/\|/g, '/')} |`);
    }
    if (validatorOutput) {
      L.push('', '## validator', '', '```text', validatorOutput.trim(), '```');
    }
    L.push('');
    const rp = path.resolve(args.report);
    fs.mkdirSync(path.dirname(rp), { recursive: true });
    fs.writeFileSync(rp, L.join('\n') + '\n');
    console.log(`report: ${rp}`);
  }
}

try { main(); } catch (error) { console.error(`ERROR: ${error.message}`); process.exit(1); }
