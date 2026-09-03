// bio-quest の教材データ（index.html 内の const Q=[...]）を読み書きする共有ライブラリ。
//
// source of truth は index.html そのもの。JSON への移行はしない。
// ここでは「抽出」「検証用の正規化」「元と同じ書式での再直列化」だけを提供する。

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const QUESTION_KEYS = Object.freeze(['id', 'f', 'lv', 'q', 'ch', 'a', 'ex']);
export const CHOICE_COUNT = 4;

// 分野 id -> ID prefix（index.html の FIELDS と対応。CONTENT_SPEC.md 参照）
export const FIELD_PREFIX = Object.freeze({
  cell: 'c', meta: 'm', gene: 'g', mol: 'mo', body: 'b', plant: 'p', eco: 'e', evo: 'v'
});

// レベル id -> ID の1文字
export const LEVEL_LETTER = Object.freeze({ easy: 'e', std: 's', hard: 'h', ibo: 'i' });

// 総問題数がベタ書きされている箇所（表示文言）。見つからない場合は警告扱いにする。
export const TOTAL_COUNT_PATTERNS = Object.freeze([
  { file: 'index.html', re: /(水準まで)(\d+)(問)/, label: '使い方ガイドの導入文' },
  { file: 'manifest.json', re: /(、)(\d+)(問の生物クイズ)/, label: 'manifest description' }
]);

export function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function readIndexHtml(root = repoRoot()) {
  return fs.readFileSync(path.join(root, 'index.html'), 'utf8');
}

export function readManifest(root = repoRoot()) {
  return fs.readFileSync(path.join(root, 'manifest.json'), 'utf8');
}

// index.html 内の `const NAME=[ ... \n];` を1つ切り出す
export function locateArray(html, name) {
  const marker = `\nconst ${name}=[`;
  const at = html.indexOf(marker);
  if (at < 0) throw new Error(`index.html に "const ${name}=[" が見つかりません`);
  const start = at + marker.length - 1;            // '[' の位置
  const close = html.indexOf('\n];', start);
  if (close < 0) throw new Error(`const ${name} の閉じ "];" が見つかりません`);
  const end = close + 2;                            // ']' の直後
  return { start, end, literal: html.slice(start, end) };
}

function evalLiteral(literal, what) {
  try {
    return vm.runInNewContext(`(${literal})`, Object.create(null), { timeout: 5000 });
  } catch (error) {
    throw new Error(`${what} の解析に失敗しました: ${error.message}`);
  }
}

export function extractQuestions(html) {
  return evalLiteral(locateArray(html, 'Q').literal, 'const Q');
}

export function extractFields(html) {
  return evalLiteral(locateArray(html, 'FIELDS').literal, 'const FIELDS');
}

export function extractLevels(html) {
  const m = html.match(/\nconst LV=(\{.*?\});\n/s);
  if (!m) throw new Error('index.html に "const LV={...};" が見つかりません');
  return evalLiteral(m[1], 'const LV');
}

export function extractFieldIcons(html) {
  const m = html.match(/\nconst FICON=(\{.*?\});\n/s);
  if (!m) throw new Error('index.html に "const FICON={...};" が見つかりません');
  return evalLiteral(m[1], 'const FICON');
}

export function extractAppVer(html) {
  const m = html.match(/\nconst APP_VER='([^']+)';/);
  if (!m) throw new Error("index.html に \"const APP_VER='...'\" が見つかりません");
  return m[1];
}

// correction batch 用の item hash。
// id,f,lv,q,ch,a,ex を CONTENT_SPEC の既定順に並べた object を JSON.stringify して sha256 を取る。
// つむぎは snapshot の questions.json に入っている item_sha256 をそのまま使えばよい。
export function itemSha256(item) {
  const canonical = {};
  for (const key of QUESTION_KEYS) canonical[key] = item[key];
  return crypto.createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

// 重複判定用の正規化（全角半角・空白の揺れを吸収する）
export function normalizeText(value) {
  return String(value).normalize('NFKC').replace(/\s+/g, ' ').trim();
}

// JS の single quote 文字列リテラルへ変換する（index.html の既存書式に合わせる）
export function jsString(value) {
  return `'${String(value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')}'`;
}

export function serializeQuestion(item) {
  const ch = item.ch.map(jsString).join(',');
  return `  {id:${jsString(item.id)},f:${jsString(item.f)},lv:${jsString(item.lv)},`
    + `q:${jsString(item.q)},ch:[${ch}],a:${item.a},ex:${jsString(item.ex)}}`;
}

// const Q=[...] の中身を、既存 index.html と同じ「1問1行」書式で組み立てる
export function serializeQuestions(items) {
  return `[\n${items.map(serializeQuestion).join(',\n')}\n]`;
}

// 既存行を一切書き換えずに、const Q=[...] の末尾へ新しい問題を追記する。
// diff を「追加した行だけ」に保つため、import ではこちらを使う。
export function appendQuestions(html, items) {
  if (!items.length) return html;
  const block = locateArray(html, 'Q');
  if (!block.literal.endsWith('\n]')) throw new Error('const Q の末尾が想定の書式ではありません');
  const insertAt = block.end - 2;
  const added = `,\n${items.map(serializeQuestion).join(',\n')}`;
  return html.slice(0, insertAt) + added + html.slice(insertAt);
}

export function replaceQuestions(html, items) {
  const block = locateArray(html, 'Q');
  return html.slice(0, block.start) + serializeQuestions(items) + html.slice(block.end);
}

// Asia/Tokyo の ISO 8601 文字列（例: 2026-09-03T12:34:56+09:00）
export function jstIso(date = new Date()) {
  const f = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
  return `${f.format(date).replace(' ', 'T')}+09:00`;
}

export function jstDateStamp(date = new Date()) {
  return jstIso(date).slice(0, 10).replace(/-/g, '');
}

// APP_VER: YYYYMMDD + 連番の英小文字。同日に複数回更新するときは b, c, ... と進める。
// アプリの checkUpdate() はこの文字列の変化で「新しいバージョンがあります」を出すため、
// 問題を追加したら必ず更新する。
export function nextAppVer(current, now = new Date()) {
  const today = jstDateStamp(now);
  const m = /^([0-9]{8})([a-z]*)$/.exec(current || '');
  if (!m || m[1] !== today || !m[2]) return `${today}a`;
  const suffix = m[2];
  const last = suffix[suffix.length - 1];
  if (last !== 'z') return `${today}${suffix.slice(0, -1)}${String.fromCharCode(last.charCodeAt(0) + 1)}`;
  return `${today}${suffix}a`;
}

export function setAppVer(html, version) {
  if (!/^[0-9a-z]+$/.test(version)) throw new Error(`APP_VER に使えない文字が含まれています: ${version}`);
  const replaced = html.replace(/(\nconst APP_VER=')[^']+(';)/, `$1${version}$2`);
  if (replaced === html) throw new Error('APP_VER の更新に失敗しました');
  return replaced;
}

// 表示文言の総問題数を実データに合わせる。戻り値 { text, updated, found }
export function syncTotalCount(text, pattern, total) {
  const m = pattern.re.exec(text);
  if (!m) return { text, updated: false, found: false, before: null };
  const before = Number(m[2]);
  if (before === total) return { text, updated: false, found: true, before };
  return { text: text.replace(pattern.re, `$1${total}$3`), updated: true, found: true, before };
}

// 選択肢長の手がかり分析。audit と correction importer で同じしきい値を使う。
export const STRONG_DIFF = 4;
export const STRONG_RATIO = 1.20;

export function choiceStats(item) {
  const glen = s => [...String(s)].length;
  const lens = item.ch.map(glen);
  const max = Math.max(...lens);
  const min = Math.min(...lens);
  const uniqueLongest = lens.filter(l => l === max).length === 1;
  const uniqueShortest = lens.filter(l => l === min).length === 1;
  const correct = lens[item.a];
  const others = lens.filter((_, i) => i !== item.a);
  const secondHigh = Math.max(...others);
  const secondLow = Math.min(...others);
  const rank = lens.filter(l => l > correct).length + 1;
  const isLongest = uniqueLongest && correct === max;
  const isShortest = uniqueShortest && correct === min;
  const diff = correct - secondHigh;
  const ratio = secondHigh > 0 ? correct / secondHigh : null;
  const strong = isLongest && (diff >= STRONG_DIFF || (ratio !== null && ratio >= STRONG_RATIO));
  return { lens, correct, rank, uniqueLongest, uniqueShortest, isLongest, isShortest, secondHigh, secondLow, diff, ratio, strong };
}

export function tallyQuestions(items, fields, levels) {
  const fieldIds = fields.map(([id]) => id);
  const levelIds = Object.keys(levels);
  const byField = Object.fromEntries(fieldIds.map(id => [id, 0]));
  const byLevel = Object.fromEntries(levelIds.map(id => [id, 0]));
  const byFieldLevel = Object.fromEntries(
    fieldIds.map(id => [id, Object.fromEntries(levelIds.map(lv => [lv, 0]))])
  );
  for (const item of items) {
    if (byField[item.f] !== undefined) byField[item.f] += 1;
    if (byLevel[item.lv] !== undefined) byLevel[item.lv] += 1;
    if (byFieldLevel[item.f] && byFieldLevel[item.f][item.lv] !== undefined) byFieldLevel[item.f][item.lv] += 1;
  }
  return { total: items.length, byField, byLevel, byFieldLevel };
}

// 分野 x レベルごとの「次に使う ID」。欠番は埋めず、最大の数値 +1 を返す
export function nextIds(items, fields, levels) {
  const out = {};
  for (const [fieldId] of fields) {
    const prefix = FIELD_PREFIX[fieldId];
    if (!prefix) continue;
    out[fieldId] = {};
    for (const levelId of Object.keys(levels)) {
      const letter = LEVEL_LETTER[levelId];
      if (!letter) continue;
      const head = `${prefix}_${letter}`;
      let max = 0;
      for (const item of items) {
        const m = new RegExp(`^${head}(\\d+)$`).exec(item.id);
        if (m) max = Math.max(max, Number(m[1]));
      }
      out[fieldId][levelId] = `${head}${max + 1}`;
    }
  }
  return out;
}

export function gitInfo(root = repoRoot()) {
  const run = args => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' }).stdout.trim();
  return { branch: run(['branch', '--show-current']), commit: run(['rev-parse', 'HEAD']), status: run(['status', '--porcelain']) };
}
