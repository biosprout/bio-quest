// BIO QUEST 学習状態・復習スケジューラの検証（ヘッドレス Chromium、タイムゾーン Asia/Tokyo）
// 使い方: node test-learn.mjs [index.html を配信している URL]
// 前提: playwright が解決できること（`npm i -D playwright` するか、PLAYWRIGHT_PATH にインストール先を指定）
// 例: npx http-server -p 8098 . &  →  node scripts/test-learn.mjs http://127.0.0.1:8098/index.html
// 実端末の localStorage には触れない（ヘッドレスブラウザの中だけで完結する）
const pw = await import(process.env.PLAYWRIGHT_PATH || 'playwright');
const { chromium } = pw.default || pw;
const URL = process.argv[2] || 'http://127.0.0.1:8098/index.html';

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  if (!cond) console.log('  ✗', name, detail ? JSON.stringify(detail) : '');
  else console.log('  ✓', name);
}
const JST = (s) => new Date(s + '+09:00');   // 'YYYY-MM-DDTHH:MM:SS' を JST として解釈

const browser = await chromium.launch();
const ctx = await browser.newContext({ timezoneId: 'Asia/Tokyo', viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));
page.on('dialog', d => d.accept());
await page.clock.install({ time: JST('2026-09-08T21:00:00') });

const st = () => page.evaluate(() => JSON.parse(localStorage.getItem(STORE_KEY)));
const setTime = (s) => page.clock.setSystemTime(JST(s));
const learnOf = (id) => page.evaluate((id) => learnOf(id), id);
const dayNum = () => page.evaluate(() => dayNum());
const dailyInfo = () => page.evaluate(() => {
  const d = daily(); const m = new Map(Q.map(q => [q.id, q]));
  const qs = d.ids.map(i => m.get(i));
  return { d, n: d.ids.length, uniq: new Set(d.ids).size,
    fresh: qs.filter(q => !state.stats[q.id] && !learnOf(q.id)).length,
    due: qs.filter(q => { const L = learnOf(q.id); return L && L.due != null && L.due <= dayNum(); }).length,
    fill: qs.filter(q => (state.stats[q.id] || learnOf(q.id)) && !(learnOf(q.id) && learnOf(q.id).due != null && learnOf(q.id).due <= dayNum())).length,
    weak: qs.filter(q => isWeakQ(q)).length };
});
// 今日の10問を最後まで解く。decide(q, i) が true なら正解を選ぶ
async function playDaily(decide, opts = {}) {
  await page.evaluate(() => startDaily());
  for (let guard = 0; guard < 50; guard++) {
    const info = await page.evaluate(() => (g.i < g.list.length) ? { i: g.i, n: g.list.length, id: g.list[g.i].id, a: g.list[g.i].a } : null);
    if (!info) break;
    const ok = decide(info, info.i);
    await page.evaluate(({ k }) => answer(k), { k: ok ? info.a : (info.a + 1) % 4 });
    if (opts.stopAfter != null && info.i + 1 >= opts.stopAfter) return;   // 中断（次へ を押さない）
    await page.evaluate(() => next());
  }
}
async function playMode(field, decide, ta) {
  await page.evaluate(({ f, ta }) => startQuiz(f, ta), { f: field, ta: !!ta });
  for (let guard = 0; guard < 50; guard++) {
    const info = await page.evaluate(() => (g.i < g.list.length) ? { i: g.i, id: g.list[g.i].id, a: g.list[g.i].a } : null);
    if (!info) break;
    await page.evaluate(({ k }) => answer(k), { k: decide(info) ? info.a : (info.a + 1) % 4 });
    await page.evaluate(() => next());
  }
}

await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => typeof Q !== 'undefined' && document.querySelector('.daily'));
const QINFO = await page.evaluate(() => Q.map(q => ({ id: q.id, f: q.f, lv: q.lv })));
const today0 = await dayNum();

console.log('\n[1] 初回（未挑戦しかない日）: 未挑戦10問になる');
{
  const di = await dailyInfo();
  check('10問・重複なし', di.n === 10 && di.uniq === 10, di);
  check('全部が未挑戦', di.fresh === 10, di);
  const s = await st();
  check('state.learn が作られている（v:1, q:{}）', s.learn && s.learn.v === 1 && s.learn.q && Object.keys(s.learn.q).length === 0, s.learn);
}

console.log('\n[2] 全問正解 → 挑戦済み(s=1)、次回は翌日');
let day0ids;
{
  day0ids = (await dailyInfo()).d.ids.slice();
  await playDaily(() => true);
  const s = await st();
  const Ls = day0ids.map(id => s.learn.q[id]);
  check('10件の記録', Ls.every(Boolean) && Object.keys(s.learn.q).length === 10);
  check('cd=1, k=0, s=1, due=今日+1', Ls.every(L => L.cd === 1 && L.k === 0 && L.s === 1 && L.due === today0 + 1 && L.ld === today0 && L.lcd === today0 && L.n === 1), Ls[0]);
  check('stats は従来どおり c=1', day0ids.every(id => s.stats[id].c === 1 && s.stats[id].w === 0));
  check('今日のぶん完了 dailyDone=1', s.dailyDone === 1 && s.daily.fin === true);
}

console.log('\n[3] 同日にもう一度全問正解 → 段は進まない（n だけ増える）');
{
  await playDaily(() => true);
  const s = await st();
  const Ls = day0ids.map(id => s.learn.q[id]);
  check('cd=1, k=0, due 変わらず, n=2', Ls.every(L => L.cd === 1 && L.k === 0 && L.due === today0 + 1 && L.n === 2), Ls[0]);
  check('dailyDone は増えない（同日の再挑戦）', s.dailyDone === 1);
}

console.log('\n[4] 同日に1問まちがえる → 段を戻す（k=-1）、翌日に再確認');
{
  const target = day0ids[0];
  await page.evaluate((id) => { const q = Q.find(q => q.id === id); g = { list: [q], i: 0, score: 0, miss: [], answered: false, combo: 0, maxCombo: 0, ta: false, t: 0, timer: null, field: 'all' }; renderQuiz(); }, target);
  await page.evaluate(() => answer((g.list[0].a + 1) % 4));
  const L = await learnOf(target);
  check('k=-1, lp=1, lr=0, due=翌日, s=1', L.k === -1 && L.lp === 1 && L.lr === 0 && L.due === today0 + 1 && L.s === 1 && L.cd === 1, L);
  // 二重呼び出し防止: 同じ問題で answer() をもう一度呼んでも記録されない
  await page.evaluate(() => answer(g.list[0].a));
  const L2 = await learnOf(target);
  check('answer() の二重呼び出しは無視される（n 変わらず）', L2.n === L.n, { before: L.n, after: L2.n });
}

console.log('\n[5] JST の日付境界: 23:59:30 → 翌 00:00:30 で学習日が変わる（UTC では同じ日）');
{
  await setTime('2026-09-08T23:59:30');
  const dA = await dayNum();
  await setTime('2026-09-09T00:00:30');
  const dB = await dayNum();
  check('dayNum が 1 増える', dB === dA + 1 && dA === today0, { dA, dB, today0 });
  const utcSame = new Date('2026-09-08T23:59:30+09:00').getUTCDate() === new Date('2026-09-09T00:00:30+09:00').getUTCDate();
  check('（参考）UTC では同じ日付である', utcSame);
  check('todayStr も切り替わる', (await page.evaluate(() => todayStr())) === '2026-09-09');
}

console.log('\n[6] 翌日: 復習が10問ある → 未挑戦2 + 復習8（まちがえた問題が先頭側）');
const today1 = today0 + 1;
{
  await page.evaluate(() => renderHome());
  const di = await dailyInfo();
  check('新しい日のセット', di.d.d === '2026-09-09' && di.n === 10 && di.uniq === 10, di);
  check('未挑戦2・復習8', di.fresh === 2 && di.due === 8, di);
  check('まちがえた問題（k=-1）が含まれる', di.d.ids.includes(day0ids[0]));
  const s = await st();
  check('dueToday=10 のうち8つが選ばれている', (await page.evaluate(() => learnSummary())).dueToday === 10);
}

console.log('\n[7] 翌日に正解 → 別日再確認(s=2)、次回は +3 日。まちがえた問題は k=0 で翌日');
{
  const di = await dailyInfo();
  await playDaily(() => true);
  const s = await st();
  const lapsed = s.learn.q[day0ids[0]];
  check('まちがえた問題: 別日正解で cd=2, k=0, due=+1, s=2', lapsed.cd === 2 && lapsed.k === 0 && lapsed.due === today1 + 1 && lapsed.s === 2, lapsed);
  const normal = di.d.ids.filter(id => id !== day0ids[0] && day0ids.includes(id)).map(id => s.learn.q[id]);
  check('ほかの復習: cd=2, k=1, due=+3, s=2', normal.length === 7 && normal.every(L => L.cd === 2 && L.k === 1 && L.due === today1 + 3 && L.s === 2), normal[0]);
  const fresh = di.d.ids.filter(id => !day0ids.includes(id)).map(id => s.learn.q[id]);
  check('新規2問: cd=1, k=0, s=1', fresh.length === 2 && fresh.every(L => L.cd === 1 && L.k === 0 && L.s === 1));
  check('実績: first / perfect などは従来どおり付く', s.ach.includes('first') && s.ach.includes('perfect'));
}

console.log('\n[8] 定着の目安まで: +3日, +7日 の正解で k=2→3, cd=4, s=3。その後まちがえると s=2 に戻る');
{
  const id = day0ids[1];   // day0 ok, day1 ok (k=1, due day1+3)
  const one = async (dayStr, ok) => {
    await setTime(dayStr);
    await page.evaluate((id) => { const q = Q.find(q => q.id === id); g = { list: [q], i: 0, score: 0, miss: [], answered: false, combo: 0, maxCombo: 0, ta: false, t: 0, timer: null, field: 'all' }; renderQuiz(); }, id);
    await page.evaluate(({ ok }) => answer(ok ? g.list[0].a : (g.list[0].a + 1) % 4), { ok });
    return learnOf(id);
  };
  let L = await one('2026-09-12T20:00:00', true);   // day1+3
  check('+3日: cd=3, k=2, due=+7, s=2', L.cd === 3 && L.k === 2 && L.due === today1 + 3 + 7 && L.s === 2, L);
  L = await one('2026-09-19T20:00:00', true);       // +7
  check('+7日: cd=4, k=3(14日), s=3 定着の目安', L.cd === 4 && L.k === 3 && L.s === 3 && L.due === today1 + 10 + 14, L);
  L = await one('2026-09-20T20:00:00', false);
  check('まちがえる → k=-1, due=翌日, s=2 に戻る（cd は保持）', L.k === -1 && L.s === 2 && L.cd === 4 && L.lp === 1, L);
  // 期限前に別モードで正解しても段は進む（分野別クイズ等も復習として数える）
  L = await one('2026-09-21T20:00:00', true);
  check('翌日正解 → k=0, due=+1（再学習は翌日にもう一度）', L.k === 0 && L.cd === 5 && L.s === 2, L);
  const s = await st();
  check('実績が取り消されていない（ach 数が減っていない）', s.ach.includes('first') && s.ach.includes('perfect'));
}

console.log('\n[9] 中断と再開: 3問解いてリロード → 「あと7問」から続き、記録は1回ずつ');
{
  await setTime('2026-10-01T09:00:00');
  await page.evaluate(() => renderHome());
  const before = await dailyInfo();
  await playDaily(() => true, { stopAfter: 3 });          // 3問目は「次へ」を押さずに中断
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => typeof Q !== 'undefined' && document.querySelector('.daily'));
  const card = await page.evaluate(() => document.querySelector('.daily .dbd p').textContent);
  check('カードに「あと 7 問」', card.includes('あと 7 問'), card);
  const after = await dailyInfo();
  check('同じセットが保持されている', JSON.stringify(after.d.ids) === JSON.stringify(before.d.ids) && after.d.ok.length === 3);
  const s = await st();
  const dnum = await dayNum();
  const three = after.d.ok.map(id => s.learn.q[id]);
  check('3問の記録は今日1回ずつ（ld=今日, 二重記録なし）', three.every(L => L.ld === dnum) && three.every(L => L.n >= 1));
  const nBefore = three.map(L => L.n);
  await playDaily(() => true);
  const s2 = await st();
  check('再開後、残り7問だけ解いて完了', s2.daily.fin === true && s2.daily.ok.length === 10);
  check('先に解いた3問の n は増えていない', after.d.ok.every((id, i) => s2.learn.q[id].n === nBefore[i]));
}

console.log('\n[10] 保存/復元: export に learn と dailyDone が入り、復元できる。旧形式（learn なし）も復元できる');
{
  const exp = await page.evaluate(() => JSON.parse(exportProgress()));
  check('v=2, d.learn, d.dailyDone あり', exp.v === 2 && exp.d.learn && exp.d.learn.q && typeof exp.d.dailyDone === 'number', Object.keys(exp.d));
  const nTracked = Object.keys(exp.d.learn.q).length;
  // 旧形式 v1 を読み込む
  const v1 = { v: 1, ver: 'x', d: { xp: 100, stats: { [QINFO[0].id]: { c: 2, w: 1 } }, ach: ['first'], cards: [], best: {}, streak: { day: '', count: 0 }, taBest: 0, cardMile: 0 } };
  await page.evaluate(() => renderBackup());
  await page.evaluate((t) => { document.getElementById('impText').value = t; importProgress(); }, JSON.stringify(v1));
  let s = await st();
  check('v1 復元: learn は空で作り直され、エラーなし', s.learn && Object.keys(s.learn.q).length === 0 && s.xp === 100 && Object.keys(s.stats).length === 1, s.learn);
  // v2 を読み戻す
  await page.evaluate(() => renderBackup());
  await page.evaluate((t) => { document.getElementById('impText').value = t; importProgress(); }, JSON.stringify(exp));
  s = await st();
  check('v2 復元: learn が戻る', Object.keys(s.learn.q).length === nTracked && s.dailyDone === exp.d.dailyDone, { got: Object.keys(s.learn.q).length, want: nTracked });
}

console.log('\n[11] 旧履歴の移行（learn なしの既存 state を読み込む）: 一斉に期限超過にしない・繰り返し安全・実績不変');
{
  // 旧形式: stats のみ。d あり/なし、苦手あり を混ぜる。learn キーなし
  const ids = QINFO.map(q => q.id);
  const stats = {};
  ids.slice(0, 300).forEach((id, i) => {
    const rec = { c: 1 + (i % 4), w: (i % 7 === 0) ? 3 : (i % 5 === 0 ? 1 : 0) };   // i%7==0 → 苦手(c<=w)
    if (i % 3 !== 0) rec.d = today0 - 20 - (i % 15);                                  // 2/3 に旧 d、1/3 は日時なし
    stats[id] = rec;
  });
  const legacy = { stats, best: {}, xp: 5000, maxCombo: 12, ach: ['first', 'perfect', 'solve100', 'lv5', 'lv10'], streak: { day: '2026-09-07', count: 3 },
    taBest: 18, cards: ['x'], cardCount: { x: 1 }, cardMile: 3, dailyDone: 12, stat: { day: '2026-09-07', dayQ: 10, fields: ['cell'], peakWeak: 0 } };
  await page.waitForTimeout(400);   // 直前の回答が予約した保存タイマーを先に流す（テスト側の都合）
  await page.evaluate((t) => localStorage.setItem(STORE_KEY, JSON.stringify(t)), legacy);
  await setTime('2026-09-08T21:00:00');
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => typeof Q !== 'undefined' && document.querySelector('.daily'));
  const s1 = await st();
  const sum = await page.evaluate(() => learnSummary());
  check('learn が空で作られ、旧 stats は 300 件そのまま', Object.keys(s1.learn.q).length === 0 && Object.keys(s1.stats).length === 300 && JSON.stringify(s1.stats) === JSON.stringify(stats));
  check('期限超過ゼロ（旧問題を一斉に due にしない）', sum.dueToday === 0 && sum.legacyOnly === 300 && sum.seen === 300 && sum.unseen === ids.length - 300, sum);
  check('実績・XP・クリア数・カード・streak が不変', JSON.stringify(s1.ach) === JSON.stringify(legacy.ach) && s1.xp === 5000 && s1.dailyDone === 12 && s1.cardMile === 3 && s1.streak.count === 3);
  const cleared = await page.evaluate(() => Object.keys(state.stats).length);
  const homeCleared = await page.evaluate(() => document.querySelector('.ring .in b').textContent);
  check('ホームの「クリア」数は 300 のまま', cleared === 300 && homeCleared === '300', homeCleared);
  const di = await dailyInfo();
  const weakTotal = await page.evaluate(() => weak().length);
  check('今日の10問 = 未挑戦5 + 既出の再確認5（復習は0）', di.fresh === 5 && di.due === 0 && di.fill === 5 && di.uniq === 10, di);
  check('再確認は苦手が優先される', di.weak === Math.min(5, weakTotal), { picked: di.weak, weakTotal });
  // 繰り返し読み込んでも変わらない
  const j1 = JSON.stringify(s1);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => typeof Q !== 'undefined' && document.querySelector('.daily'));
  const s2 = await st();
  check('2回目の読み込みで state が変わらない（冪等）', JSON.stringify({ ...s2, daily: null }) === JSON.stringify({ ...JSON.parse(j1), daily: null }));
  // 旧問題を解くと mig:1 の記録ができ、stats も従来どおり増える
  const legacyId = di.d.ids.find(id => stats[id]);
  const cBefore = stats[legacyId].c;
  await page.evaluate((id) => { const q = Q.find(q => q.id === id); g = { list: [q], i: 0, score: 0, miss: [], answered: false, combo: 0, maxCombo: 0, ta: false, t: 0, timer: null, field: 'all' }; renderQuiz(); }, legacyId);
  await page.evaluate(() => answer(g.list[0].a));
  const s3 = await st();
  const L = s3.learn.q[legacyId];
  check('旧問題の初回正解: mig=1, cd=1, k=0, due=翌日, s=1（別日正解は捏造しない）', L.mig === 1 && L.cd === 1 && L.k === 0 && L.due === today0 + 1 && L.s === 1, L);
  check('stats.c は +1', s3.stats[legacyId].c === cBefore + 1);
}

console.log('\n[12] 対象不足: 未挑戦が尽きた／復習が多すぎる場合');
{
  // 全問に旧記録 → 未挑戦0。復習0 → 再確認10
  const ids = QINFO.map(q => q.id);
  const stats = {}; ids.forEach((id, i) => { stats[id] = { c: 2, w: 0, d: today0 - 10 }; });
  await page.waitForTimeout(400);
  await page.evaluate((t) => localStorage.setItem(STORE_KEY, JSON.stringify(t)), { stats, best: {}, xp: 1, ach: [], streak: { day: '', count: 0 } });
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => typeof Q !== 'undefined' && document.querySelector('.daily'));
  let di = await dailyInfo();
  check('未挑戦0・復習0 → 既出の再確認10', di.fresh === 0 && di.due === 0 && di.fill === 10 && di.uniq === 10, di);
  // 復習が 12 問ある日 → 未挑戦は最低2、復習8
  await page.evaluate((n) => { state.stats = {}; state.learn = { v: 1, since: '2026-09-01', q: {} }; const t = dayNum();
    Q.slice(0, n).forEach((q, i) => { state.stats[q.id] = { c: 1, w: 0, d: t - 2 }; state.learn.q[q.id] = { s: 1, n: 1, cd: 1, k: 0, ld: t - 2, lcd: t - 2, la: 0, lr: 1, due: t - 1, lp: 0 }; });
    state.daily = null; save(); }, 12);
  await page.evaluate(() => renderHome());
  di = await dailyInfo();
  check('復習12 → 未挑戦2 + 復習8', di.fresh === 2 && di.due === 8 && di.uniq === 10, di);
  // 復習が 6 問 → 未挑戦4 + 復習6
  await page.evaluate((n) => { state.stats = {}; state.learn = { v: 1, since: '2026-09-01', q: {} }; const t = dayNum();
    Q.slice(0, n).forEach((q, i) => { state.stats[q.id] = { c: 1, w: 0, d: t - 2 }; state.learn.q[q.id] = { s: 1, n: 1, cd: 1, k: 0, ld: t - 2, lcd: t - 2, la: 0, lr: 1, due: t - 1, lp: 0 }; });
    state.daily = null; save(); }, 6);
  await page.evaluate(() => renderHome());
  di = await dailyInfo();
  check('復習6 → 未挑戦4 + 復習6', di.fresh === 4 && di.due === 6 && di.uniq === 10, di);
  // 復習3 → 未挑戦5 + 復習3 + 再確認2（再確認は due でない既出）
  await page.evaluate(() => { state.stats = {}; state.learn = { v: 1, since: '2026-09-01', q: {} }; const t = dayNum();
    Q.slice(0, 3).forEach(q => { state.stats[q.id] = { c: 1, w: 0, d: t - 2 }; state.learn.q[q.id] = { s: 1, n: 1, cd: 1, k: 0, ld: t - 2, lcd: t - 2, la: 0, lr: 1, due: t - 1, lp: 0 }; });
    Q.slice(3, 9).forEach(q => { state.stats[q.id] = { c: 1, w: 0, d: t - 2 }; state.learn.q[q.id] = { s: 1, n: 1, cd: 1, k: 1, ld: t - 2, lcd: t - 2, la: 0, lr: 1, due: t + 5, lp: 0 }; });
    state.daily = null; save(); });
  await page.evaluate(() => renderHome());
  di = await dailyInfo();
  check('復習3 → 未挑戦5 + 復習3 + 再確認2', di.fresh === 5 && di.due === 3 && di.fill === 2 && di.uniq === 10, di);
  // 難易度しぼり込み: ibo で未挑戦が3問しかない → 3 + 再確認7
  await page.evaluate(() => { state.stats = {}; state.learn = { v: 1, since: '2026-09-01', q: {} }; const t = dayNum();
    const ibo = Q.filter(q => q.lv === 'ibo'); ibo.slice(3).forEach(q => { state.stats[q.id] = { c: 1, w: 0, d: t - 30 }; });
    state.daily = null; curLv = 'ibo'; save(); });
  await page.evaluate(() => renderHome());
  di = await dailyInfo();
  const allIbo = await page.evaluate(() => { const m = new Map(Q.map(q => [q.id, q])); return state.daily.ids.every(id => m.get(id).lv === 'ibo'); });
  check('IBO級のみ・未挑戦3 + 再確認7', allIbo && di.fresh === 3 && di.fill === 7 && di.uniq === 10 && di.d.lv === 'ibo', di);
  await page.evaluate(() => { curLv = 'all'; });
}

console.log('\n[13] 他モード（分野別・タイムアタック）の回答も記録され、達成は従来どおり');
{
  await page.waitForTimeout(400);
  await page.evaluate(() => { localStorage.removeItem(STORE_KEY); });
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => typeof Q !== 'undefined' && document.querySelector('.daily'));
  await playMode('cell', () => true);
  const s = await st();
  check('分野別10問 → learn 10件、stats 10件', Object.keys(s.learn.q).length === 10 && Object.keys(s.stats).length === 10);
  check('best/実績は従来どおり', s.best['cell_all'] === 10 && s.ach.includes('first') && s.ach.includes('perfect'));
}

console.log('\n[14] 更新チェック: APP_VER が新しい');
{
  const ver = await page.evaluate(() => APP_VER);
  check('APP_VER=20260908a', ver === '20260908a', ver);
}

check('ページエラーなし', pageErrors.length === 0, pageErrors);
await browser.close();

const fail = results.filter(r => !r.ok);
console.log(`\n=== ${results.length - fail.length}/${results.length} passed ===`);
if (fail.length) { console.log('FAILED:'); fail.forEach(f => console.log(' -', f.name, f.detail ? JSON.stringify(f.detail) : '')); process.exit(1); }
