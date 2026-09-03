#!/usr/bin/env node
// Academic つむぎが作った新規問題 batch を index.html の const Q=[...] へ追記する。
//
// 使い方:
//   node scripts/import-question-batch.mjs <batch-file>            # dry run（既定・書き込まない）
//   node scripts/import-question-batch.mjs <batch-file> --apply    # 実際に追記する
//   optional: --allow-stale  source.commit が HEAD と違っても続行する
//             --report <path>  Markdown の取込レポートを書き出す
//
// このツールは問題文・選択肢・解説を書き換えない。生物学的な内容判断はつむぎ側の担当。
// commit / push はしない（田中が diff を確認して push する）。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  CHOICE_COUNT, FIELD_PREFIX, LEVEL_LETTER, QUESTION_KEYS, TOTAL_COUNT_PATTERNS,
  appendQuestions, extractAppVer, extractFields, extractLevels, extractQuestions,
  gitInfo, jstIso, nextAppVer, nextIds, normalizeText, readIndexHtml, readManifest,
  repoRoot, setAppVer, syncTotalCount, tallyQuestions
} from './lib/questions.mjs';

const REQUIRED_QA_FIELDS = Object.freeze([
  'schema_checked',
  'id_unique_against_current_data',
  'exact_question_duplicate_checked',
  'semantic_duplicate_checked',
  'single_correct_answer_checked',
  'distractor_quality_checked',
  'explanation_checked',
  'factual_accuracy_checked',
  'level_appropriateness_checked'
]);

const SCRIPT_END = /<\/script/i;

function hasControlChar(value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function parseArgs(argv) {
  const out = { batch: null, apply: false, allowStale: false, report: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') out.apply = true;
    else if (arg === '--allow-stale') out.allowStale = true;
    else if (arg === '--report') out.report = argv[++i];
    else if (arg === '--help' || arg === '-h') { usage(); process.exit(0); }
    else if (arg.startsWith('-')) throw new Error(`Unknown argument: ${arg}`);
    else if (!out.batch) out.batch = arg;
    else throw new Error(`batch file は1つだけ指定してください: ${arg}`);
  }
  if (!out.batch) { usage(); throw new Error('batch file を指定してください'); }
  return out;
}

function usage() {
  console.log('Usage: node scripts/import-question-batch.mjs <batch-file> [--apply] [--allow-stale] [--report <path>]');
}

function fail(message) { throw new Error(message); }

// batch の items を取り出す。canonical は top-level items。
// BioSprout 共通 schema の changes[] 形式でも受け付ける。
function collectItems(batch) {
  if (Array.isArray(batch.items)) return { items: batch.items, expectedBefore: batch.expected_count_before ?? null };
  if (Array.isArray(batch.changes)) {
    const items = [];
    let expectedBefore = null;
    for (const [i, change] of batch.changes.entries()) {
      if (!change || typeof change !== 'object') fail(`changes[${i}]: object ではありません`);
      if (change.operation !== 'append_items') fail(`changes[${i}].operation は "append_items" だけ対応しています`);
      const target = change.target_file ?? change.target;
      if (target && !['index.html', 'questions', 'Q'].includes(target)) {
        fail(`changes[${i}]: bio-quest の追記先は index.html の const Q だけです（指定: ${target}）`);
      }
      if (!Array.isArray(change.items) || !change.items.length) fail(`changes[${i}].items が空です`);
      if (Number.isInteger(change.expected_count_before)) expectedBefore = change.expected_count_before;
      items.push(...change.items);
    }
    return { items, expectedBefore };
  }
  return fail('batch に items（新規問題の配列）がありません');
}

function validateEnvelope(batch, batchPath) {
  if (batch.schema_version !== 1) fail('schema_version は 1 にしてください');
  if (batch.status !== 'ready') fail(`status は "ready" のものだけ取り込みます（現在: ${batch.status}）`);
  if (batch.subject !== 'bio-quest') fail(`subject は "bio-quest" にしてください（現在: ${batch.subject}）`);
  if (typeof batch.batch_id !== 'string' || !batch.batch_id.trim()) fail('batch_id は必須です');
  if (path.basename(batchPath, '.json') !== batch.batch_id) {
    fail(`batch_id とファイル名が一致しません（batch_id: ${batch.batch_id}, file: ${path.basename(batchPath)}）`);
  }
  if (!batch.source || typeof batch.source !== 'object') fail('source は必須です');
  if (batch.source.repo !== 'biosprout/bio-quest') fail(`source.repo は "biosprout/bio-quest" にしてください（現在: ${batch.source.repo}）`);
  if (batch.source.branch !== 'main') fail('source.branch は "main" にしてください');
  if (typeof batch.source.commit !== 'string' || !/^[0-9a-f]{7,40}$/.test(batch.source.commit)) {
    fail('source.commit には snapshot の commit hash を入れてください');
  }
  if (!batch.qa || typeof batch.qa !== 'object') fail('qa は必須です');
  const missing = REQUIRED_QA_FIELDS.filter(field => batch.qa[field] !== true);
  if (missing.length) fail(`ready batch の QA flag が未完了です: ${missing.join(', ')}`);
}

function validateItems(items, existing, fields, levels) {
  const fieldIds = fields.map(entry => entry[0]);
  const levelIds = Object.keys(levels);
  const seenIds = new Map();
  const seenQuestions = new Map();
  const warnings = [];

  items.forEach((item, index) => {
    const label = `items[${index}]${item && typeof item.id === 'string' ? ` (${item.id})` : ''}`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail(`${label}: object ではありません`);

    const keys = Object.keys(item);
    if (keys.join(',') !== QUESTION_KEYS.join(',')) {
      fail(`${label}: property は ${QUESTION_KEYS.join(',')} の順で過不足なく持たせてください（実際: ${keys.join(',') || '(なし)'}）`);
    }

    for (const key of ['id', 'f', 'lv', 'q', 'ex']) {
      if (typeof item[key] !== 'string' || !item[key].trim()) fail(`${label}.${key}: 空でない文字列にしてください`);
      if (hasControlChar(item[key])) fail(`${label}.${key}: 制御文字が含まれています`);
      if (SCRIPT_END.test(item[key])) fail(`${label}.${key}: "</script" を含めることはできません`);
    }

    if (!fieldIds.includes(item.f)) fail(`${label}.f: 未知の分野 "${item.f}"（有効: ${fieldIds.join(', ')}）`);
    if (!levelIds.includes(item.lv)) fail(`${label}.lv: 未知のレベル "${item.lv}"（有効: ${levelIds.join(', ')}）`);

    const head = `${FIELD_PREFIX[item.f]}_${LEVEL_LETTER[item.lv]}`;
    const m = new RegExp(`^${head}([1-9][0-9]*)$`).exec(item.id);
    if (!m) fail(`${label}.id: "${head}<番号>" の形式にしてください`);
    if (existing.maxNumber[head] !== undefined && Number(m[1]) <= existing.maxNumber[head]) {
      warnings.push(`${label}.id: 既存の最大番号 ${head}${existing.maxNumber[head]} 以下の番号です（欠番を埋めていないか確認）`);
    }

    if (existing.ids.has(item.id)) fail(`${label}: ID "${item.id}" は既に存在します`);
    if (seenIds.has(item.id)) fail(`${label}: ID "${item.id}" が batch 内で重複しています`);
    seenIds.set(item.id, index);

    if (!Array.isArray(item.ch)) fail(`${label}.ch: 配列にしてください`);
    if (item.ch.length !== CHOICE_COUNT) fail(`${label}.ch: 選択肢は ${CHOICE_COUNT} 個です（実際: ${item.ch.length}）`);
    item.ch.forEach((choice, k) => {
      if (typeof choice !== 'string' || !choice.trim()) fail(`${label}.ch[${k}]: 空でない文字列にしてください`);
      if (hasControlChar(choice)) fail(`${label}.ch[${k}]: 制御文字が含まれています`);
      if (SCRIPT_END.test(choice)) fail(`${label}.ch[${k}]: "</script" を含めることはできません`);
    });
    const normalizedChoices = item.ch.map(normalizeText);
    if (new Set(normalizedChoices).size !== normalizedChoices.length) fail(`${label}.ch: 選択肢が重複しています`);
    if (!Number.isInteger(item.a) || item.a < 0 || item.a >= CHOICE_COUNT) {
      fail(`${label}.a: 0 以上 ${CHOICE_COUNT - 1} 以下の整数にしてください（実際: ${JSON.stringify(item.a)}）`);
    }

    const qKey = normalizeText(item.q);
    if (existing.questions.has(qKey)) fail(`${label}: 問題文が既存の ${existing.questions.get(qKey)} と完全一致しています`);
    if (seenQuestions.has(qKey)) fail(`${label}: 問題文が batch 内の items[${seenQuestions.get(qKey)}] と完全一致しています`);
    seenQuestions.set(qKey, index);
  });

  return warnings;
}

function buildReport(summary) {
  const lines = [
    `# ${summary.batchId} import report`,
    '',
    `- App: bio-quest（智穂子専用）`,
    `- Repo: biosprout/bio-quest`,
    `- Branch: ${summary.branch}`,
    `- HEAD: ${summary.head}`,
    `- source.commit: ${summary.sourceCommit}${summary.sourceCommitMatched ? '（一致）' : '（不一致・--allow-stale で続行）'}`,
    `- Applied: ${summary.applied ? 'yes' : 'no（dry run）'}`,
    `- Imported at: ${summary.at}`,
    '',
    `## 件数`,
    '',
    `- 総問題数: ${summary.before} -> ${summary.after}（+${summary.added}）`,
    `- APP_VER: ${summary.appVerBefore} -> ${summary.appVerAfter}`,
    '',
    '| field | level | added | after |',
    '| --- | --- | ---: | ---: |'
  ];
  for (const row of summary.perCombo) {
    lines.push(`| ${row.field} | ${row.level} | ${row.added} | ${row.after} |`);
  }
  lines.push('', '## 追加した ID', '', summary.ids.map(id => `\`${id}\``).join(', '), '');
  lines.push('## 自動チェック', '');
  lines.push(`- schema / ID 重複 / 完全一致問題 / 選択肢数 / answer index / field・level: ${summary.applied ? 'passed' : 'passed（dry run）'}`);
  lines.push(`- validator: ${summary.applied ? 'passed' : 'dry run では未実行'}`);
  lines.push(`- 内容の生物学的正確さ・意味的重複: つむぎの QA と田中の確認に委ねる`);
  if (summary.warnings.length) {
    lines.push('', '## warning', '');
    for (const w of summary.warnings) lines.push(`- ${w}`);
  }
  if (summary.validatorOutput) {
    lines.push('', '### validator output', '', '```text', summary.validatorOutput.trim(), '```');
  }
  return `${lines.join('\n')}\n`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = repoRoot();
  const batchPath = path.resolve(args.batch);
  const batch = JSON.parse(fs.readFileSync(batchPath, 'utf8'));

  validateEnvelope(batch, batchPath);
  const { items, expectedBefore } = collectItems(batch);
  if (!Array.isArray(items) || !items.length) fail('items が空です');

  const git = gitInfo(root);
  if (git.branch !== 'main') fail(`current branch が main ではありません: ${git.branch || '(detached)'}`);
  if (git.status) fail(`worktree に未 commit の変更があります。先に整理してください:\n${git.status}`);
  const sourceCommitMatched = git.commit.startsWith(batch.source.commit);
  if (!sourceCommitMatched && !args.allowStale) {
    fail(`source.commit ${batch.source.commit} が HEAD ${git.commit} と違います。最新 snapshot で再確認してから --allow-stale で再実行してください`);
  }

  const htmlBefore = readIndexHtml(root);
  const manifestBefore = readManifest(root);
  const fields = extractFields(htmlBefore);
  const levels = extractLevels(htmlBefore);
  const current = extractQuestions(htmlBefore);
  const tallyBefore = tallyQuestions(current, fields, levels);

  if (expectedBefore !== null && expectedBefore !== tallyBefore.total) {
    fail(`expected_count_before=${expectedBefore} ですが、実際は ${tallyBefore.total} 問です。snapshot を更新して batch を作り直してください`);
  }

  const existing = {
    ids: new Set(current.map(item => item.id)),
    questions: new Map(current.map(item => [normalizeText(item.q), item.id])),
    maxNumber: {}
  };
  for (const item of current) {
    const m = /^([a-z]+_[a-z])([1-9][0-9]*)$/.exec(item.id);
    if (!m) continue;
    existing.maxNumber[m[1]] = Math.max(existing.maxNumber[m[1]] || 0, Number(m[2]));
  }

  const warnings = validateItems(items, existing, fields, levels);

  const merged = [...current, ...items];
  const tallyAfter = tallyQuestions(merged, fields, levels);
  const perCombo = [];
  for (const [fieldId] of fields) {
    for (const levelId of Object.keys(levels)) {
      const added = tallyAfter.byFieldLevel[fieldId][levelId] - tallyBefore.byFieldLevel[fieldId][levelId];
      if (added) perCombo.push({ field: fieldId, level: levelId, added, after: tallyAfter.byFieldLevel[fieldId][levelId] });
    }
  }

  const appVerBefore = extractAppVer(htmlBefore);
  const appVerAfter = nextAppVer(appVerBefore);

  const summary = {
    batchId: batch.batch_id,
    branch: git.branch,
    head: git.commit,
    sourceCommit: batch.source.commit,
    sourceCommitMatched,
    applied: args.apply,
    at: jstIso(),
    before: tallyBefore.total,
    after: tallyAfter.total,
    added: items.length,
    appVerBefore,
    appVerAfter: args.apply ? appVerAfter : `${appVerAfter}（dry run では未書き込み）`,
    ids: items.map(item => item.id),
    perCombo,
    warnings,
    validatorOutput: ''
  };

  console.log(JSON.stringify({
    status: args.apply ? 'applying' : 'dry_run_ok',
    batch_id: summary.batchId,
    head: summary.head,
    source_commit_matched: sourceCommitMatched,
    total_before: summary.before,
    total_after: summary.after,
    added: summary.added,
    app_ver: `${appVerBefore} -> ${appVerAfter}`,
    ids: summary.ids,
    per_combo: perCombo,
    warnings
  }, null, 2));

  if (!args.apply) {
    console.log('\nDRY RUN OK  --apply を付けると index.html へ追記します');
  } else {
    const backup = new Map([
      [path.join(root, 'index.html'), htmlBefore],
      [path.join(root, 'manifest.json'), manifestBefore]
    ]);
    try {
      let html = appendQuestions(htmlBefore, items);
      html = setAppVer(html, appVerAfter);
      let manifest = manifestBefore;
      for (const pattern of TOTAL_COUNT_PATTERNS) {
        if (pattern.file === 'index.html') {
          const r = syncTotalCount(html, pattern, tallyAfter.total);
          html = r.text;
          if (!r.found) warnings.push(`index.html: ${pattern.label} の問題数表記が見つかりませんでした（手で確認してください）`);
        } else {
          const r = syncTotalCount(manifest, pattern, tallyAfter.total);
          manifest = r.text;
          if (!r.found) warnings.push(`manifest.json: ${pattern.label} の問題数表記が見つかりませんでした（手で確認してください）`);
        }
      }
      fs.writeFileSync(path.join(root, 'index.html'), html, 'utf8');
      if (manifest !== manifestBefore) fs.writeFileSync(path.join(root, 'manifest.json'), manifest, 'utf8');

      const validator = spawnSync(process.execPath, ['scripts/validate-content.mjs'], { cwd: root, encoding: 'utf8' });
      summary.validatorOutput = [validator.stdout, validator.stderr].filter(Boolean).join('\n');
      if (validator.status !== 0) fail(`validator が失敗しました:\n${summary.validatorOutput}`);

      const modified = spawnSync('git', ['-C', root, 'diff', '--name-only'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).sort();
      const allowed = new Set(['index.html', 'manifest.json']);
      const unexpected = modified.filter(file => !allowed.has(file));
      if (unexpected.length) fail(`想定外のファイルが変更されました: ${unexpected.join(', ')}`);

      console.log('\nAPPLY OK');
      console.log(summary.validatorOutput.trim());
      console.log(`\nchanged: ${modified.join(', ')}`);
      console.log('commit と push はしていません。git diff を確認してください。');
    } catch (error) {
      for (const [file, text] of backup.entries()) fs.writeFileSync(file, text, 'utf8');
      throw new Error(`取込に失敗したため index.html / manifest.json を元に戻しました。\n${error.message}`);
    }
  }

  for (const w of warnings) console.log(`  ! ${w}`);

  if (args.report) {
    const reportPath = path.resolve(args.report);
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, buildReport(summary), 'utf8');
    console.log(`report: ${reportPath}`);
  }
}

try { main(); } catch (error) { console.error(`ERROR: ${error.message}`); process.exit(1); }
