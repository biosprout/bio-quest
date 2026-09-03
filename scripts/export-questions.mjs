#!/usr/bin/env node
// index.html に埋め込まれている全問題を machine-readable な JSON として書き出す。
// Academic つむぎ用 snapshot（05_current_snapshot/bio-quest/questions.json）の生成に使う。
//
// 使い方:
//   node scripts/export-questions.mjs                 # 標準出力
//   node scripts/export-questions.mjs --out <path>    # ファイルへ出力

import fs from 'node:fs';
import path from 'node:path';
import {
  CHOICE_COUNT, FIELD_PREFIX, LEVEL_LETTER, QUESTION_KEYS,
  extractAppVer, extractFields, extractLevels, extractQuestions,
  gitInfo, jstIso, nextIds, readIndexHtml, repoRoot, tallyQuestions
} from './lib/questions.mjs';

function parseArgs(argv) {
  const out = { out: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') out.out = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: node scripts/export-questions.mjs [--out <path>]');
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = repoRoot();
  const html = readIndexHtml(root);
  const fields = extractFields(html);
  const levels = extractLevels(html);
  const questions = extractQuestions(html);
  const git = gitInfo(root);
  const tally = tallyQuestions(questions, fields, levels);

  const doc = {
    schema_version: 1,
    app: 'bio-quest',
    repo: 'biosprout/bio-quest',
    branch: git.branch,
    commit: git.commit,
    worktree_clean: git.status === '',
    app_version: extractAppVer(html),
    captured_at: jstIso(),
    source_of_truth: 'index.html の const Q=[...]（JSON は読み取り専用の写し）',
    question_schema: {
      keys: [...QUESTION_KEYS],
      choice_count: CHOICE_COUNT,
      answer: 'a は ch の 0 始まり index。表示時に選択肢はシャッフルされるが a は元の並び順を指す'
    },
    fields: fields.map(([id, name]) => ({ id, name, id_prefix: FIELD_PREFIX[id] || null })),
    levels: Object.entries(levels).map(([id, v]) => ({ id, name: v.n, note: v.d, id_letter: LEVEL_LETTER[id] || null })),
    counts: { total: tally.total, by_field: tally.byField, by_level: tally.byLevel, by_field_level: tally.byFieldLevel },
    next_id: nextIds(questions, fields, levels),
    items: questions
  };

  const text = `${JSON.stringify(doc, null, 2)}\n`;
  if (!args.out) { process.stdout.write(text); return; }
  // Drive の mount 上に一時ファイルを残さないよう、直接書き出す。
  // 更新中の読み取り防止は _SNAPSHOT_READY.json の status で行う（SNAPSHOT_SPEC.md 参照）。
  const target = path.resolve(args.out);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text, 'utf8');
  console.log(`questions.json: ${target} (${doc.counts.total} 問, commit ${doc.commit.slice(0, 7)})`);
}

try { main(); } catch (error) { console.error(`ERROR: ${error.message}`); process.exit(1); }
