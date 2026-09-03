#!/usr/bin/env node
// bio-quest の教材データ（index.html 内の const Q=[...]）を検証する。
// 使い方: node scripts/validate-content.mjs
// 終了コード: 0 = OK（warning があっても 0）、1 = error あり

import {
  CHOICE_COUNT, FIELD_PREFIX, LEVEL_LETTER, QUESTION_KEYS, TOTAL_COUNT_PATTERNS,
  extractAppVer, extractFieldIcons, extractFields, extractLevels, extractQuestions,
  locateArray, normalizeText, readIndexHtml, readManifest, repoRoot, serializeQuestions, tallyQuestions
} from './lib/questions.mjs';

const errors = [];
const warnings = [];
const err = message => errors.push(message);
const warn = message => warnings.push(message);

const SCRIPT_END = /<\/script/i;

function hasControlChar(value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function checkString(value, label) {
  if (typeof value !== 'string') { err(`${label}: 文字列ではありません`); return false; }
  if (!value.trim()) { err(`${label}: 空です`); return false; }
  if (hasControlChar(value)) err(`${label}: 制御文字が含まれています`);
  // index.html の script タグ内に直接埋め込むため、"</script" があるとページが壊れる
  if (SCRIPT_END.test(value)) err(`${label}: "</script" を含めることはできません`);
  return true;
}

function main() {
  const root = repoRoot();
  const html = readIndexHtml(root);
  const manifestText = readManifest(root);

  const fields = extractFields(html);
  const levels = extractLevels(html);
  const icons = extractFieldIcons(html);
  const questions = extractQuestions(html);
  const appVer = extractAppVer(html);

  const fieldIds = fields.map(entry => entry[0]);
  const levelIds = Object.keys(levels);
  if (new Set(fieldIds).size !== fieldIds.length) err('FIELDS: 分野 id が重複しています');
  for (const [id, name] of fields) {
    if (!FIELD_PREFIX[id]) err(`FIELDS: 分野 "${id}" の ID prefix が scripts/lib/questions.mjs に定義されていません`);
    if (!icons[id]) warn(`FICON: 分野 "${id}" のアイコンがありません（代替アイコンが表示されます）`);
    if (typeof name !== 'string' || !name.trim()) err(`FIELDS: 分野 "${id}" の表示名が空です`);
  }
  const prefixes = fieldIds.map(id => FIELD_PREFIX[id]).filter(Boolean);
  if (new Set(prefixes).size !== prefixes.length) err('FIELD_PREFIX: ID prefix が重複しています');
  for (const id of levelIds) {
    if (!LEVEL_LETTER[id]) err(`LV: レベル "${id}" の ID 文字が scripts/lib/questions.mjs に定義されていません`);
  }

  const seenIds = new Map();
  const seenQuestions = new Map();
  questions.forEach((item, index) => {
    const label = `Q[${index}]${item && typeof item.id === 'string' ? ` (${item.id})` : ''}`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) { err(`${label}: object ではありません`); return; }

    const keys = Object.keys(item);
    if (keys.join(',') !== QUESTION_KEYS.join(',')) {
      err(`${label}: property は ${QUESTION_KEYS.join(',')} の順で過不足なく持つ必要があります（実際: ${keys.join(',') || '(なし)'}）`);
    }

    if (checkString(item.id, `${label}.id`)) {
      if (seenIds.has(item.id)) err(`${label}: ID が重複しています（Q[${seenIds.get(item.id)}] と同じ）`);
      else seenIds.set(item.id, index);
    }

    const fieldOk = typeof item.f === 'string' && fieldIds.includes(item.f);
    if (!fieldOk) err(`${label}.f: 未知の分野 "${item.f}"（有効: ${fieldIds.join(', ')}）`);
    const levelOk = typeof item.lv === 'string' && levelIds.includes(item.lv);
    if (!levelOk) err(`${label}.lv: 未知のレベル "${item.lv}"（有効: ${levelIds.join(', ')}）`);

    if (fieldOk && levelOk && typeof item.id === 'string') {
      const expected = new RegExp(`^${FIELD_PREFIX[item.f]}_${LEVEL_LETTER[item.lv]}([1-9][0-9]*)$`);
      if (!expected.test(item.id)) {
        err(`${label}.id: 分野/レベルと一致しません。"${FIELD_PREFIX[item.f]}_${LEVEL_LETTER[item.lv]}<番号>" にしてください`);
      }
    }

    checkString(item.q, `${label}.q`);
    checkString(item.ex, `${label}.ex`);

    if (!Array.isArray(item.ch)) {
      err(`${label}.ch: 配列ではありません`);
    } else {
      if (item.ch.length !== CHOICE_COUNT) err(`${label}.ch: 選択肢は ${CHOICE_COUNT} 個です（実際: ${item.ch.length}）`);
      item.ch.forEach((choice, k) => checkString(choice, `${label}.ch[${k}]`));
      const normalized = item.ch.filter(c => typeof c === 'string').map(normalizeText);
      if (new Set(normalized).size !== normalized.length) err(`${label}.ch: 選択肢が重複しています`);
      if (!Number.isInteger(item.a) || item.a < 0 || item.a >= item.ch.length) {
        err(`${label}.a: 0 以上 ${item.ch.length - 1} 以下の整数にしてください（実際: ${JSON.stringify(item.a)}）`);
      }
    }

    if (typeof item.q === 'string' && item.q.trim()) {
      const key = normalizeText(item.q);
      if (seenQuestions.has(key)) err(`${label}: 問題文が Q[${seenQuestions.get(key)}] と完全一致しています`);
      else seenQuestions.set(key, index);
    }
  });

  const tally = tallyQuestions(questions, fields, levels);
  for (const fieldId of fieldIds) {
    for (const levelId of levelIds) {
      if (tally.byFieldLevel[fieldId][levelId] === 0) {
        err(`${fieldId} / ${levelId}: 問題が 0 件です。アプリでこの分野×レベルを選ぶと出題できません`);
      }
    }
  }

  const original = locateArray(html, 'Q').literal.split('\n');
  const rebuilt = serializeQuestions(questions).split('\n');
  let indentOnly = 0;
  if (original.length !== rebuilt.length) {
    err('const Q の再直列化で行数が変わりました。1問1行の書式を崩さないでください');
  } else {
    for (let i = 0; i < original.length; i += 1) {
      if (original[i] === rebuilt[i]) continue;
      if (original[i].trim() === rebuilt[i].trim()) { indentOnly += 1; continue; }
      err(`const Q の ${i + 1} 行目が正規の書式と一致しません（scripts/lib/questions.mjs の serializeQuestion 参照）`);
    }
  }
  if (indentOnly) warn(`const Q に字下げが 2 スペースでない行が ${indentOnly} 行あります（動作には影響しません）`);

  for (const pattern of TOTAL_COUNT_PATTERNS) {
    const text = pattern.file === 'index.html' ? html : manifestText;
    const m = pattern.re.exec(text);
    if (!m) { warn(`${pattern.file}: ${pattern.label} の問題数表記が見つかりません（文言が変わった可能性）`); continue; }
    if (Number(m[2]) !== tally.total) {
      warn(`${pattern.file}: ${pattern.label} が ${m[2]}問 のままです（実データ ${tally.total}問）。次の batch 取込時に自動更新されます`);
    }
  }

  const pad = (s, n) => String(s).padStart(n);
  console.log(`bio-quest content validation  (APP_VER ${appVer})`);
  console.log(`  field ${levelIds.map(l => pad(l, 7)).join('')}${pad('total', 8)}`);
  for (const [fieldId, name] of fields) {
    const row = levelIds.map(l => pad(tally.byFieldLevel[fieldId][l], 7)).join('');
    console.log(`  ${fieldId.padEnd(6)}${row}${pad(tally.byField[fieldId], 8)}   ${name}`);
  }
  console.log(`  ALL   ${levelIds.map(l => pad(tally.byLevel[l], 7)).join('')}${pad(tally.total, 8)}`);

  for (const message of warnings) console.log(`  ! ${message}`);
  if (errors.length) {
    console.error(`NG  error ${errors.length} 件`);
    for (const message of errors) console.error(`  - ${message}`);
    process.exit(1);
  }
  console.log(`OK  ${tally.total} 問 / ${fieldIds.length} 分野 x ${levelIds.length} レベル、warning ${warnings.length} 件`);
}

try {
  main();
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  process.exit(1);
}
