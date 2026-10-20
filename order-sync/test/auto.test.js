'use strict';
// 自動執行：在 vm 裡跑 Rules/Shopify/Sheets/Main/Auto，Shopify、排程、寄信用假的
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { FakeSheet, FakeBook } = require('./fake-sheets.js');

const SRC = path.join(__dirname, '..', 'src');

function world(orders, { stepMs = 1000 } = {}) {
  const hdr = { A: ' Order #', B: 'Date', C: 'Platform', D: 'Item Name' };
  const ca = new FakeSheet('2026已出貨 CA', 11, [hdr]);
  const books = {
    MAIN: new FakeBook('MAIN', [ca, new FakeSheet('2026已出貨 INT', 12, [hdr]), new FakeSheet('預購', 13, [{ A: ' ' }, { A: 'PO#' }]), new FakeSheet('訂貨', 14, [{ A: 'Item', B: 'UPC' }])]),
    POPW: new FakeBook('POPW', [new FakeSheet('PO/PW', 21, [{ E: 'Order Number' }])])
  };
  const settings = new FakeSheet('設定', 1, [{ A: '設定', B: '值' }, { A: 'SHOPIFY_STORE', B: 'x.myshopify.com' }, { A: 'MAIN_SHEET_ID', B: 'MAIN' },
    { A: 'POPW_SHEET_ID', B: 'POPW' }, { A: 'ALERT_EMAIL', B: 'me@example.com' }]);
  const log = new FakeSheet('紀錄', 2, [{ A: '時間', B: '單號' }]);
  log.appendRow = function (r) { const n = this.getLastRow() + 1; r.forEach((v, i) => { this.cell(n, i + 1).v = v; }); };
  const control = new FakeBook('CTRL', [settings, log, new FakeSheet('原單資料', 3, [{ A: '單號' }])]);
  control.getUrl = () => 'https://example.com/ctrl';

  const props = {}, cache = {}, mails = [], alerts = [];
  let triggers = [];
  let clock = 0;
  const builder = (handler) => {
    const t = { handler, getHandlerFunction: () => handler };
    const b = { timeBased: () => b, everyDays: () => b, atHour: (h) => { t.hour = h; return b; }, nearMinute: () => b, inTimezone: () => b,
      after: (ms) => { t.after = ms; return b; }, create: () => { triggers.push(t); return t; } };
    return b;
  };
  class FakeDate extends Date { static now() { clock += stepMs; return clock; } }
  const ctx = {
    console, JSON, Math, Number, String, Object, Array, RegExp, isNaN, isFinite, Error, Date: FakeDate,
    SpreadsheetApp: {
      openById: (id) => books[id], getActiveSpreadsheet: () => control,
      getUi: () => ({ alert: (m) => alerts.push(m), prompt: () => ({ getSelectedButton: () => 'OK', getResponseText: () => '2026-10-13' }), ButtonSet: { OK_CANCEL: 1 }, Button: { OK: 'OK' } })
    },
    Utilities: {
      formatDate: (d, tz, f) => { const p = (n) => ('0' + n).slice(-2); return f === 'yyyy' ? String(d.getFullYear()) : d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); },
      parseDate: (s) => new Date(s.replace(' ', 'T') + '-07:00'),
      computeDigest: (a, s) => [...require('crypto').createHash('md5').update(s).digest()], base64Encode: (b) => Buffer.from(b).toString('base64'),
      DigestAlgorithm: { MD5: 'md5' }, Charset: { UTF_8: 'utf8' }, sleep() {}
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} }) },
    MailApp: { sendEmail: (...a) => mails.push(a) },
    Session: { getActiveUser: () => ({ getEmail: () => '' }), getScriptTimeZone: () => 'America/Vancouver' },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] || null, setProperty: (k, v) => { props[k] = String(v); }, setProperties: (o) => Object.assign(props, o) }) },
    CacheService: { getScriptCache: () => ({ get: (k) => cache[k] || null, put: (k, v) => { cache[k] = v; }, remove: (k) => { delete cache[k]; } }) },
    ScriptApp: { getProjectTriggers: () => triggers.slice(), deleteTrigger: (t) => { triggers = triggers.filter((x) => x !== t); }, newTrigger: builder },
    module: undefined
  };
  vm.createContext(ctx);
  for (const f of ['Rules.js', 'Shopify.js', 'Sheets.js', 'Main.js', 'Auto.js']) vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), ctx, { filename: f });
  const lists = [];
  ctx.shopifyListUpdated = (from, to, oldBefore) => {
    lists.push({ from: from.toISOString(), oldBefore: oldBefore.toISOString() });
    return orders.filter((o) => new Date(o.updatedAt) >= from).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).map((o) => ({
      name: o.name, createdAt: o.createdAt, updatedAt: o.updatedAt, cancelled: false, test: false,
      old: new Date(o.createdAt) < oldBefore, newPayment: !!o.paidAt && new Date(o.paidAt) >= oldBefore
    }));
  };
  ctx.shopifyFetchOrder = (n) => orders.find((o) => o.name === n) || null;
  return { ctx, props, mails, alerts, ca, log, lists, get triggers() { return triggers; } };
}

function order(name, created, updated, over) {
  return Object.assign({
    name, date: '2026-10-13', createdAt: created, updatedAt: updated, source: 'web', financialStatus: 'paid', cancelled: false, email: 'a@example.com',
    country: 'CA', shippingTitle: 'Flat Rate Shipping', shippingCharged: 14.99,
    lines: [{ name: 'Figure ' + name, qty: 1, unitPrice: 50, discount: 0, sku: '1', barcode: '', requiresShipping: true }],
    payments: [{ createdAt: created, gateway: 'shopify_payments', amount: 64.99, fee: 2 }]
  }, over);
}

test('自動執行：寫入可寫入的單、需確認的寄信、舊單略過、進度往前；再跑一次不重複', () => {
  const orders = [
    order('CA1D', '2026-10-13T10:00:00Z', '2026-10-13T10:01:00Z'),
    order('CA2D', '2026-10-13T11:00:00Z', '2026-10-13T11:01:00Z', { cancelled: false, financialStatus: 'partially_refunded' }),
    order('CA0D', '2026-10-01T10:00:00Z', '2026-10-13T12:00:00Z')
  ];
  const w = world(orders);
  w.ctx.autoEnable();
  assert.deepEqual(w.triggers.map((t) => [t.handler, t.hour]), [['autoRun', 9], ['autoRun', 21]]);
  assert.equal(w.props.AUTO_CURSOR, '2026-10-13T07:00:00.000Z');
  w.ctx.autoRun();
  const last = JSON.parse(w.props.AUTO_LAST);
  assert.deepEqual(last.written.map((x) => x.name), ['CA1D']);
  assert.deepEqual(last.attention.map((x) => [x.name, x.status]), [['CA2D', 'warn']]);
  assert.equal(last.skipped, 1); // CA0D：舊單，沒有新付款
  assert.equal(w.ca.get('A2').v, 'CA1D');
  assert.equal(w.mails.length, 1);
  assert.match(w.mails[0][1], /寫入 1 張，1 張要人工處理/);
  assert.match(w.mails[0][2], /CA2D［需確認］/);
  assert.equal(w.props.AUTO_CURSOR, w.props.AUTO_WINDOW_START);
  // 下一次排程：沒有新的更新 → 不寫、不寄信
  w.ctx.autoRun();
  assert.equal(w.ca.getLastRow(), 2);
  assert.equal(w.mails.length, 1);
});

test('自動執行：時間不夠時停在下一張、排 1 分鐘後繼續，這一輪的起點不變，最後只寄一封信', () => {
  const orders = [1, 2, 3, 4].map((i) => order('CA' + i + 'D', '2026-10-13T1' + i + ':00:00Z', '2026-10-13T1' + i + ':01:00Z'));
  // 舊單：上一輪之前下單、這一輪中間才更新，而且這一輪才付款 → 要處理
  orders.push(order('CA9D', '2026-10-12T10:00:00Z', '2026-10-13T18:00:00Z', { paidAt: '2026-10-13T18:00:00Z' }));
  const w = world(orders, { stepMs: 100000 });
  w.ctx.autoEnable();
  w.ctx.autoRun();
  assert.equal(w.props.AUTO_WINDOW_START, '2026-10-13T07:00:00.000Z');
  assert.notEqual(w.props.AUTO_CURSOR, w.props.AUTO_WINDOW_START);
  assert.deepEqual(w.triggers.filter((t) => t.handler === 'autoContinue').map((t) => t.after), [60000]);
  assert.equal(w.mails.length, 0);
  let guard = 0;
  while (w.triggers.some((t) => t.handler === 'autoContinue') && guard++ < 10) w.ctx.autoContinue();
  const last = JSON.parse(w.props.AUTO_LAST);
  assert.deepEqual(last.written.map((x) => x.name), ['CA1D', 'CA2D', 'CA3D', 'CA4D', 'CA9D']);
  // 後面幾段查詢的「舊單」起點還是這一輪的起點
  assert.ok(w.lists.length > 1);
  assert.deepEqual([...new Set(w.lists.map((l) => l.oldBefore))], ['2026-10-13T07:00:00.000Z']);
  assert.equal(w.mails.length, 1);
  assert.match(w.mails[0][1], /寫入 5 張/);
  assert.equal(w.props.AUTO_CURSOR, w.props.AUTO_WINDOW_START);
});

test('自動執行：AUTO_HOURS 格式不對會提醒，不建立排程', () => {
  const w = world([]);
  const n = w.ctx.SpreadsheetApp.getActiveSpreadsheet().getSheetByName('設定');
  n.cell(n.getLastRow() + 1, 1).v = 'AUTO_HOURS';
  n.cell(n.getLastRow(), 2).v = '9,25';
  w.ctx.autoEnable();
  assert.match(w.alerts[0], /AUTO_HOURS/);
  assert.equal(w.triggers.length, 0);
});
