'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Rules = require('../src/Rules.js');
// Sheets.js 在 Apps Script 裡和 Rules.js 共用全域變數
global.rulesUpcKey = Rules.rulesUpcKey;
global.RULES_COLORS = Rules.RULES_COLORS;
const { SheetsSession, sheetsNewPaidFormula_ } = require('../src/Sheets.js');
const { FakeSheet, FakeBook, installFake } = require('./fake-sheets.js');

function setup() {
  const shippedRows = [
    { A: ' Order #', B: 'Date', C: 'Platform', D: 'Item Name', J: 'QTY', K: 'Sales Price', L: 'Shipping Charged', M: 'Shipping Cost', N: 'Platform Fee', O: 'Paypal Fee' },
    { A: 'CA100D', B: new Date(2026, 9, 1), C: 'Shopify', D: 'Old', J: 1, K: 10, L: 14.99, M: 5, N: 0.5, O: 0, bg: { M: '#ffff00' } },
    { A: 'CA52681D-1', B: new Date(2026, 9, 5), C: 'Shopify', D: 'Gen', J: 1, K: 84.99, L: 0, M: '', N: 8.33, O: 0, bg: { M: '#ff9900' } }
  ];
  const ca = new FakeSheet('2026已出貨 CA', 11, shippedRows);
  for (let r = 4; r <= 8; r++) ca.setRow(r, { bg: { M: '#ffff00' } }); // 預先上好黃色的空白列
  const int = new FakeSheet('2026已出貨 INT', 12, [shippedRows[0]]);
  const pre = new FakeSheet('預購', 13, [
    { A: '  ' },
    { A: 'PO#', B: 'Status', C: 'Date', D: 'Item Name', I: 'UPC', L: 'QTY', M: 'Price', N: 'Paid', O: 'Remain' },
    { A: 'CA46701D', B: '', C: new Date(2026, 5, 3), D: 'Rocketboy Platea', I: 4573343560693, J: '=IFERROR(VLOOKUP(I3, 訂貨!B:L,8, FALSE()),"")', K: '=IFERROR(VLOOKUP(I3, 訂貨!B:L,10, FALSE()),"")', L: 1, M: 359.99, N: 72, O: '=M3*L3-N3' },
    { A: 'CA5D', B: 'backorder', C: new Date(2026, 8, 1), D: 'Kenshin', I: 4934054055661, J: '=IFERROR(VLOOKUP(I4, 訂貨!B:L,8, FALSE()),"")', K: '=IFERROR(VLOOKUP(I4, 訂貨!B:L,10, FALSE()),"")', L: 1, M: 204.99, N: '=100+4.99', O: '---' }
  ]);
  pre.get('N4').v = 104.99;
  const ordering = new FakeSheet('訂貨', 14, [
    { A: 'Item', B: 'UPC', C: 'PO Deadline', D: 'PO Qty', E: 'Total Ordered' },
    { A: 'legend' },
    { A: 'Existing', B: 45557611514, C: new Date(2026, 9, 1), D: '=SUMIF(預購!I:I,B3,預購!L:L)', E: '=J3+N3+R3+V3' },
    { D: '=SUMIF(預購!I:I,B4,預購!L:L)', E: '=J4+N4+R4+V4' },
    { D: '=SUMIF(預購!I:I,B5,預購!L:L)', E: '=J5+N5+R5+V5' }
  ]);
  const main = new FakeBook('MAIN', [ca, int, pre, ordering]);
  const popwTab = new FakeSheet('PO/PW', 21, [
    { B: 'Transferred', C: 'Type', D: 'Invoice Sent', E: 'Order Number' },
    { C: 'PW', D: new Date(2026, 9, 10), E: 'CA52825D', F: 'RX-78-2', G: 4573102655271, H: '=TODAY()', I: 1, J: 'x@example.com',
      L: '=IF(ISBLANK(D2), "", D2 + 52)', M: '=IF(ISBLANK(D2), "", D2 + 60)', P: '=MIN(M2,12)', Q: '=SUMIF(J:J, J2, P:P)' }
  ]);
  const popw = new FakeBook('POPW', [popwTab]);
  const y2025 = new FakeBook('Y2025', [new FakeSheet('2025已出貨 CA', 31, [shippedRows[0], { A: 'CA35000D', C: 'Shopify' }])]);
  installFake({ MAIN: main, POPW: popw, Y2025: y2025 });
  const settings = { MAIN_SHEET_ID: 'MAIN', POPW_SHEET_ID: 'POPW', YEAR_SHEET_2025: 'Y2025', TIMEZONE: 'America/Vancouver', M_DEFAULT_COLOR: '#ffff00' };
  return { ca, int, pre, ordering, popwTab, y2025, settings };
}

const baseOrder = (over) => Object.assign({
  name: 'CA53000D', date: '2026-10-14', source: 'web', financialStatus: 'paid', email: 'c@example.com', country: 'CA',
  shippingTitle: 'Flat Rate Shipping', shippingCharged: 14.99, payments: [{ createdAt: 'x', gateway: 'shopify_payments', amount: 1, fee: 1.5 }], lines: []
}, over);
const L = (name, unitPrice, over) => Object.assign({ name, qty: 1, unitPrice, discount: 0, sku: '1234567890123', barcode: '', requiresShipping: true }, over);

function run(order, settings, originals) {
  const session = new SheetsSession(settings, (b) => (originals || {})[b] || null);
  const plan = Rules.planOrder(order, session.context(order), {});
  if (!plan.errors.length) session.resolve(plan);
  return { session, plan };
}

test('現貨：寫在最後一筆資料的下一列（不是預先上色的空白列之後），合併 D:G，M 欄上色', () => {
  const { ca, settings } = setup();
  const { session, plan } = run(baseOrder({ lines: [L('A', 10), L('B', 20)] }), settings);
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.actions.map((a) => a.target.row), [4, 5]);
  const written = session.execute(plan);
  assert.equal(written.length, 2);
  assert.equal(ca.get('A4').v, 'CA53000D-1');
  assert.ok(ca.get('B4').v instanceof Date);
  assert.equal(ca.get('L4').v, 14.99);
  assert.equal(ca.get('M4').bg, '#ffff00');
  assert.equal(ca.get('A5').v, 'CA53000D-2');
  assert.equal(ca.get('M5').bg, '#cccccc');
  assert.ok(ca.merges.some((m) => m.row === 4 && m.col === 4 && m.cols === 4));
  assert.match(written[0].url, /#gid=11&range=A4$/);
});

test('同一個單號已經記錄過 → 錯誤，不寫入', () => {
  const { settings } = setup();
  const { plan } = run(baseOrder({ name: 'CA100D', lines: [L('A', 10)] }), settings);
  assert.match(plan.errors.join(), /已經記錄在「2026已出貨 CA」第 2 列/);
});

test('預購：新增一列、複製 J/K 公式、訂金 O 欄公式；訂貨表 UPC 已有就不新增、沒有就寫到第一個空白列並保留公式', () => {
  const { pre, ordering, settings } = setup();
  const order = baseOrder({
    shippingCharged: 0,
    lines: [
      L('DIGIVICE - Pay a 20% non-refundable deposit', 12, { sku: '045557611514', requiresShipping: false }),
      L('New Figure - Pay in full', 99.99, { sku: '4570000000001', requiresShipping: false, description: 'Pre-Order Deadline: 2026-11-13' })
    ]
  });
  const { session, plan } = run(order, settings);
  assert.deepEqual(plan.errors, []);
  const ens = plan.actions.filter((a) => a.op === 'ensureOrdering');
  assert.equal(ens[0].skip, true);
  assert.equal(ens[1].target.row, 4);
  session.execute(plan);
  assert.equal(pre.get('A5').v, 'CA53000D-1');
  assert.equal(pre.get('M5').v, 59.99);
  assert.equal(pre.get('N5').v, 12);
  assert.equal(pre.get('J5').f, '=IFERROR(VLOOKUP(I5, 訂貨!B:L,8, FALSE()),"")');
  assert.equal(pre.get('O5').f, '=M5*L5-N5');
  assert.equal(pre.get('O6').v, '---');
  assert.equal(ordering.get('A4').v, 'New Figure');
  assert.equal(ordering.get('B4').v, 4570000000001);
  assert.ok(ordering.get('C4').v instanceof Date);
  assert.equal(ordering.get('D4').f, '=SUMIF(預購!I:I,B4,預購!L:L)');
});

test('PW：POPW 分頁新增一列並複製公式', () => {
  const { popwTab, ca, settings } = setup();
  const order = baseOrder({ shippingTitle: 'Do not Ship. Store at my Private Warehouse for now (60-day free storage)', shippingCharged: 0, lines: [L('Figure', 29.99)] });
  const { session, plan } = run(order, settings);
  session.execute(plan);
  assert.equal(ca.get('M4').bg, '#ff9900');
  assert.equal(popwTab.get('E3').v, 'CA53000D');
  assert.equal(popwTab.get('C3').bg, '#cccccc');
  assert.equal(popwTab.get('J3').v, 'c@example.com');
  assert.equal(popwTab.get('M3').f, '=IF(ISBLANK(D3), "", D3 + 60)');
  assert.equal(popwTab.get('H3').f, '=TODAY()');
});

test('POPW：更新預購 B=Y、N 改成公式、整列標綠；已出貨用原單日期', () => {
  const { pre, ca, settings } = setup();
  const order = baseOrder({ name: 'CA53093D', source: 'shopify_draft_order', lines: [L('CA46701D\tRocketboy Platea\t(4573343560693)\t2026-09-23', 287.99, { sku: '' })] });
  const { session, plan } = run(order, settings);
  assert.deepEqual(plan.errors, []);
  session.execute(plan);
  assert.equal(pre.get('B3').v, 'Y');
  assert.equal(pre.get('N3').f, '=72+287.99');
  assert.equal(pre.get('A3').bg, '#93c47d');
  assert.equal(pre.get('O3').bg, '#93c47d');
  assert.equal(ca.get('A4').v, 'CA46701D');
  assert.equal(ca.get('B4').v.getMonth(), 5);
  assert.equal(ca.get('C4').v, 'PO-Shopify');
});

test('POPW：原本是公式的 N 欄接著加；backorder 寫 Shopify', () => {
  const { pre, ca, settings } = setup();
  const order = baseOrder({ name: 'CA53094D', source: 'shopify_draft_order', lines: [L('CA5D\tKenshin\t(4934054055661)\t2026-10-08', 100, { sku: '' })] });
  const { session, plan } = run(order, settings);
  session.execute(plan);
  assert.equal(pre.get('N4').f, '=100+4.99+100');
  assert.equal(pre.get('A4').bg, '#93c47d'); // 104.99 + 100 = 204.99 = 應付
  assert.equal(ca.get('C4').v, 'Shopify');
});

test('POPW：PW 存放的現貨出貨 → 改原本那一列的 L、O', () => {
  const { ca, settings } = setup();
  const order = baseOrder({ name: 'CA53055D', source: 'shopify_draft_order', payments: [{ createdAt: 'x', gateway: 'paypal', amount: 16.79, fee: 0.79 }], lines: [L('CA52681D-1\tGen\t(4580828665163)\t2026-10-07', 0, { sku: '' })] });
  const { session, plan } = run(order, settings);
  assert.deepEqual(plan.errors, []);
  session.execute(plan);
  assert.equal(ca.get('L3').v, 14.99);
  assert.equal(ca.get('O3').v, 0.79);
});

test('2025 年的分頁從年份檔讀', () => {
  const { y2025, settings } = setup();
  const s = new SheetsSession(settings);
  const ref = s.shippedSheet(2025, 'CA');
  assert.equal(ref.file, 'year2025');
  assert.equal(ref.sheet, y2025.getSheetByName('2025已出貨 CA'));
  assert.equal(s.shippedSheet(2023, 'CA'), null);
});

test('N 欄公式', () => {
  assert.equal(sheetsNewPaidFormula_(78, 311.99), '=78+311.99');
  assert.equal(sheetsNewPaidFormula_('=20+10', 5), '=20+10+5');
  assert.equal(sheetsNewPaidFormula_('', 5), 5);
});
