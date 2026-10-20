'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { planOrder, rulesAllocate, rulesCleanName, classifyPlan } = require('../src/Rules.js');

const GRAY = '#cccccc', CYAN = '#00ffff', ORANGE = '#ff9900', BLUE = '#4a86e8', GREEN = '#93c47d';

function order(over) {
  return Object.assign({
    name: 'CA1000D', date: '2026-10-14', source: 'web', financialStatus: 'paid', cancelled: false, email: 'a@example.com',
    country: 'CA', shippingTitle: 'Flat Rate Shipping', shippingCharged: 14.99, lines: [],
    payments: [{ createdAt: '2026-10-14T10:00:00Z', gateway: 'shopify_payments', amount: 100, fee: 3.2 }]
  }, over);
}
const line = (name, unitPrice, over) => Object.assign({ name, qty: 1, unitPrice, discount: 0, sku: '4500000000001', barcode: '', requiresShipping: true }, over);
const ops = (plan, op) => plan.actions.filter((a) => a.op === op);

test('現貨線上單：多件編號、運費和手續費記第一項、第二項起 M 灰底', () => {
  const p = planOrder(order({
    lines: [
      line('Damage & Loss Insurance - $5.00 (Coverage up to $400 for every $5. Package theft is not covered)', 5, { sku: '', requiresShipping: false }),
      line('Nendoroid A', 79.99),
      line('Nendoroid B', 74.99, { qty: 2 })
    ]
  }));
  assert.deepEqual(p.errors, []);
  const rows = ops(p, 'appendShipped');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].label, '2026已出貨 CA');
  assert.deepEqual(rows[0].values, { A: 'CA1000D-1', B: '2026-10-14', C: 'Shopify', D: 'Nendoroid A', J: 1, K: 79.99, L: 19.99, M: '', N: 3.2, O: 0 });
  assert.deepEqual(rows[0].colors, {});
  assert.deepEqual(rows[1].values, { A: 'CA1000D-2', B: '2026-10-14', C: 'Shopify', D: 'Nendoroid B', J: 2, K: 149.98, L: 0, M: 0, N: 0, O: 0 });
  assert.equal(rows[1].colors.M, GRAY);
});

test('單一商品不加 -1；服務費不佔編號', () => {
  const p = planOrder(order({ lines: [line('Gift Wrapping - $9.99 (Per Item)', 9.99, { sku: '', requiresShipping: false }), line('Figure', 100)] }));
  const rows = ops(p, 'appendShipped');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].values.A, 'CA1000D');
  assert.equal(rows[0].values.L, 24.98);
});

test('自取：每列 M=0 青色（第二項也是青色不是灰色）', () => {
  const p = planOrder(order({ shippingTitle: 'Vancouver (Renfrew)', shippingCharged: 0, lines: [line('A', 10), line('B', 20)] }));
  const rows = ops(p, 'appendShipped');
  assert.deepEqual(rows.map((r) => [r.values.M, r.colors.M]), [[0, CYAN], [0, CYAN]]);
});

test('PW：已出貨 M 留空橘色，另外新增 POPW 分頁（C=PW 灰底）', () => {
  const p = planOrder(order({
    shippingTitle: 'Do not Ship. Store at my Private Warehouse for now (60-day free storage)', shippingCharged: 0,
    lines: [line('Figure A', 29.99, { sku: '4533564054814' }), line('Figure B', 29.99, { sku: '4582733467696' })]
  }));
  const rows = ops(p, 'appendShipped');
  assert.deepEqual(rows.map((r) => [r.values.M, r.colors.M]), [['', ORANGE], ['', ORANGE]]);
  const pw = ops(p, 'appendPW');
  assert.equal(pw.length, 2);
  assert.deepEqual(pw[0].values, { C: 'PW', D: '2026-10-14', E: 'CA1000D-1', F: 'Figure A', G: 4533564054814, I: 1, J: 'a@example.com' });
  assert.equal(pw[0].colors.C, GRAY);
});

test('POS：Platform=Store、M=0、不上灰底', () => {
  const p = planOrder(order({ source: 'pos', shippingTitle: '', shippingCharged: 0, country: '', lines: [line('A', 10), line('B', 20)] }));
  const rows = ops(p, 'appendShipped');
  assert.deepEqual(rows.map((r) => [r.values.C, r.values.M, r.colors.M]), [['Store', 0, undefined], ['Store', 0, undefined]]);
});

test('INT：還沒報運費、還沒付清都是「等待中」；付清後 N=第一筆付款手續費、O=補運費那筆的手續費', () => {
  const lines = [line('Figure', 289.99)];
  const notQuoted = planOrder(order({ country: 'AU', shippingTitle: 'International Shipping', shippingCharged: 0, lines }));
  assert.equal(classifyPlan(notQuoted), 'waiting');
  assert.ok(notQuoted.errors.length, '逐筆模式也不能寫入');
  const pending = planOrder(order({ country: 'AU', shippingTitle: 'International Shipping', financialStatus: 'partially_paid', shippingCharged: 66, lines }));
  assert.equal(classifyPlan(pending), 'waiting');
  const hawaii = planOrder(order({ country: 'US', shippingTitle: 'Shipping (Hawaii)', financialStatus: 'partially_paid', shippingCharged: 24.99, lines }));
  assert.equal(classifyPlan(hawaii), 'waiting');
  const paid = planOrder(order({
    country: 'AU', shippingTitle: 'International Shipping', shippingCharged: 66, lines,
    payments: [
      { createdAt: '2026-10-07T10:00:00Z', gateway: 'paypal', amount: 324.79, fee: 17.41 },
      { createdAt: '2026-10-09T10:00:00Z', gateway: 'shopify_payments', amount: 73.92, fee: 2.54 }
    ]
  }));
  assert.deepEqual(paid.errors, []);
  const r = ops(paid, 'appendShipped')[0];
  assert.equal(r.label, '2026已出貨 INT');
  assert.deepEqual([r.values.L, r.values.N, r.values.O], [66, 17.41, 2.54]);
});

test('美國寄送寫到 CA 分頁', () => {
  const p = planOrder(order({ country: 'US', shippingTitle: 'US Tracked Shipping', shippingCharged: 24.99, lines: [line('A', 100)] }));
  assert.equal(ops(p, 'appendShipped')[0].region, 'CA');
});

test('現貨＋預購混合：現貨先編號，手續費全額記在第一項現貨', () => {
  const p = planOrder(order({
    shippingCharged: 14.99,
    payments: [{ createdAt: 'x', gateway: 'shopify_payments', amount: 300, fee: 10 }],
    lines: [
      line('TRIGUN FigZero 1/6 Vash the Stampede - Pay in full', 219.99, { requiresShipping: false, sku: '4895250821286' }),
      line('POP UP PARADE Bomb', 79.99),
      line('Bandai MG Destiny', 94.99)
    ]
  }));
  const rows = ops(p, 'appendShipped');
  assert.deepEqual(rows.map((r) => r.values.A), ['CA1000D-1', 'CA1000D-2']);
  const pre = ops(p, 'appendPreorder');
  assert.equal(pre[0].values.A, 'CA1000D-3');
  assert.equal(pre[0].values.D, 'TRIGUN FigZero 1/6 Vash the Stampede');
  assert.deepEqual(rows.map((r) => r.values.N), [10, 0]);
  assert.equal(ops(p, 'saveOriginal')[0].values.D, 10);
  assert.equal(pre[0].values.B, '');
});

test('預購訂金：M = 訂金×5−0.01，N = 已付，有折扣兩邊都扣', () => {
  const p = planOrder(order({
    shippingCharged: 0,
    lines: [
      line('Figma 600 Guyver I: Ultimate Edition (Reissue) - Pay a 20% non-refundable deposit', 32, { requiresShipping: false, discount: 5 }),
      line('Hatsune Miku METAL BUILD - Pay a 20% non-refundable deposit', 90, { requiresShipping: false })
    ]
  }));
  const pre = ops(p, 'appendPreorder');
  assert.deepEqual([pre[0].values.M, pre[0].values.N, pre[0].deposit], [154.99, 27, true]);
  assert.deepEqual([pre[1].values.M, pre[1].values.N], [449.99, 90]);
  assert.equal(ops(p, 'appendShipped').length, 0);
});

test('訂金換算不是 .99 結尾會警告', () => {
  const p = planOrder(order({ shippingCharged: 0, lines: [line('X - Pay a 20% non-refundable deposit', 15.1, { requiresShipping: false })] }));
  assert.match(p.warnings.join(), /不是 \.99/);
});

test('預購 qty>1：M 是單價、N 是總額', () => {
  const p = planOrder(order({ shippingCharged: 0, lines: [line('Y - Pay in full (Early Bee Price)', 98.99, { qty: 2, requiresShipping: false })] }));
  assert.deepEqual([ops(p, 'appendPreorder')[0].values.M, ops(p, 'appendPreorder')[0].values.N, ops(p, 'appendPreorder')[0].values.L], [98.99, 197.98, 2]);
});

test('只有預購且有付運費：B=shipping paid 藍色；只有保險不算', () => {
  const withShipping = planOrder(order({
    source: 'pos', shippingCharged: 0, shippingTitle: '',
    lines: [line('Nendoroid Kamui - Pay in full', 89.99, { requiresShipping: false }), line('Flat Rate Shipping', 14.99, { sku: '' })]
  }));
  const a = ops(withShipping, 'appendPreorder')[0];
  assert.equal(a.values.B, 'shipping paid');
  assert.equal(a.colors.B, BLUE);
  const insuranceOnly = planOrder(order({
    shippingCharged: 0, shippingTitle: '',
    lines: [line('Damage & Loss Insurance - $5.00 (Coverage up to $400 for every $5. Package theft is not covered)', 5, { sku: '', requiresShipping: false }), line('Rias - Pay in full (Early Bee Price)', 503.99, { requiresShipping: false })]
  }));
  assert.equal(ops(insuranceOnly, 'appendPreorder')[0].values.B, '');
});

test('backorder：B=backorder，品名去掉 [Backorder]，也會檢查訂貨表', () => {
  const p = planOrder(order({ shippingCharged: 0, lines: [line('[Backorder] ARTFX J Kenshin Himura', 204.99, { requiresShipping: false, sku: '4934054055661' })] }));
  const a = ops(p, 'appendPreorder')[0];
  assert.deepEqual([a.values.B, a.values.D, a.values.M, a.values.N], ['backorder', 'ARTFX J Kenshin Himura', 204.99, 204.99]);
  assert.equal(ops(p, 'ensureOrdering')[0].values.A, 'ARTFX J Kenshin Himura');
});

test('訂貨：從商品敘述讀 Pre-Order Deadline；UPC 開頭的 0 不影響比對', () => {
  const p = planOrder(order({
    shippingCharged: 0,
    lines: [line('DIGIVICE - Pay a 20% non-refundable deposit', 12, { requiresShipping: false, sku: '', barcode: '045557611514', description: '<p>Pre-Order Deadline: 2026-10-23</p>' })]
  }));
  const o = ops(p, 'ensureOrdering')[0];
  assert.deepEqual(o.values, { A: 'DIGIVICE', B: 45557611514, C: '2026-10-23' });
  assert.equal(o.key, '45557611514');
});

test('不記錄禮物卡、Duties；記在 notes', () => {
  const p = planOrder(order({ lines: [line('Gift Card - $50 CAD', 50, { sku: '', requiresShipping: false }), line('Duties (US)', 11.25, { sku: '', requiresShipping: false })] }));
  assert.equal(p.actions.length, 0);
  assert.equal(p.notes.length, 2);
});

test('已取消的單不處理', () => {
  assert.ok(planOrder(order({ cancelled: true, lines: [line('A', 1)] })).errors.length);
});

test('讀不到手續費：N 欄留空並警告', () => {
  const p = planOrder(order({ payments: [{ createdAt: 'x', gateway: 'shopify_payments', amount: 10, fee: null }], lines: [line('A', 10)] }));
  assert.equal(ops(p, 'appendShipped')[0].values.N, '');
  assert.match(p.warnings.join(), /讀不到手續費/);
});

test('折扣分配：比例分攤，差額放最後一項', () => {
  assert.deepEqual(rulesAllocate(10, [79.99, 74.99]), [5.16, 4.84]);
  assert.deepEqual(rulesAllocate(3.44, [12.99, 12.99, 42.99]), [0.65, 0.65, 2.14]);
});

test('品名清理', () => {
  assert.equal(rulesCleanName('Nendoroid No.1762 Miles Edgeworth (Reissue) - Pay in full (Early Bee Price)'), 'Nendoroid No.1762 Miles Edgeworth (Reissue)');
  assert.equal(rulesCleanName('[Backorder] Bandai HGUC Nightingale'), 'Bandai HGUC Nightingale');
});

// ---- POPW 出貨單 ----

function draft(over) {
  return order(Object.assign({ name: 'CA2000D', source: 'shopify_draft_order', payments: [{ createdAt: 'x', gateway: 'shopify_payments', amount: 342.37, fee: 2.56 }] }, over));
}
const popwLine = (code, name, upc, price) => line(code + '\t' + name + '\t(' + upc + ')\t2026-10-08', price, { sku: '' });

function ctxWith({ preorders = {}, shipped = {}, originals = {}, baseShipped = {} }) {
  return {
    findPreorder: (code) => preorders[code] || null,
    findShipped: (code) => shipped[code] || null,
    findOriginal: (base) => originals[base] || null,
    baseShipped: (base) => !!baseShipped[base]
  };
}

test('POPW：付尾款後預購 B=Y、N 加上金額、應付=已付標綠；已出貨用原單日期、PO-Shopify', () => {
  const ctx = ctxWith({
    preorders: { CA46701D: { row: 3011, B: '', C: '2026-06-03', D: 'Rocketboy Platea', I: 4573343560693, L: 1, M: 359.99, N: 72, Nvalue: 72 } },
    originals: {
      CA46701D: order({ name: 'CA46701D', date: '2026-06-03', shippingCharged: 0, payments: [{ createdAt: 'x', gateway: 'shopify_payments', amount: 80.64, fee: 2.6 }],
        lines: [line('Damage & Loss Insurance - $5.00 (Coverage up to $400 for every $5. Package theft is not covered)', 5, { sku: '', requiresShipping: false }), line('Rocketboy Platea - Pay a 20% non-refundable deposit', 72, { sku: '4573343560693', requiresShipping: false })] })
    }
  });
  const p = planOrder(draft({ lines: [popwLine('CA46701D', 'Rocketboy Platea', '4573343560693', 287.99)] }), ctx);
  assert.deepEqual(p.errors, []);
  const s = ops(p, 'appendShipped')[0];
  // 原單只有這一個預購商品：保險 $5 全部算它的，原單手續費也全部算它的
  assert.deepEqual(s.values, { A: 'CA46701D', B: '2026-06-03', C: 'PO-Shopify', D: 'Rocketboy Platea', J: 1, K: 359.99, L: 19.99, M: '', N: 2.6, O: 2.56 });
  const u = ops(p, 'updatePreorder')[0];
  assert.deepEqual([u.row, u.addPaid, u.paidAfter, u.diff, u.rowColor], [3011, 287.99, 359.99, 0, GREEN]);
});

test('POPW：應付和已付對不起來 → 標橘色並警告', () => {
  const ctx = ctxWith({ preorders: { CA1D: { row: 5, B: '', C: '2026-03-01', D: 'X', I: 1, L: 1, M: 100, N: 20, Nvalue: 20 } } });
  const p = planOrder(draft({ lines: [popwLine('CA1D', 'X', '1', 70)] }), ctx);
  const u = ops(p, 'updatePreorder')[0];
  assert.equal(u.diff, 10);
  assert.equal(u.rowColor, ORANGE);
  assert.match(p.warnings.join(), /差 \$10/);
});

test('POPW：多個原單一起出貨，運費和手續費只記第一項，第二項 M 灰底；backorder 原單寫 Shopify', () => {
  const ctx = ctxWith({
    preorders: {
      CA1D: { row: 5, B: '', C: '2026-03-01', D: 'X', I: 1, L: 1, M: 100, N: 100, Nvalue: 100 },
      'CA2D-2': { row: 6, B: 'backorder', C: '2026-04-01', D: 'Y', I: 2, L: 1, M: 50, N: 50, Nvalue: 50 }
    }
  });
  const p = planOrder(draft({ shippingCharged: 14.99, lines: [popwLine('CA1D', 'X', '1', 0), popwLine('CA2D-2', 'Y', '2', 0)] }), ctx);
  const rows = ops(p, 'appendShipped');
  assert.deepEqual(rows.map((r) => [r.values.C, r.values.L, r.values.M, r.colors.M, r.values.O]), [['PO-Shopify', 14.99, '', undefined, 2.56], ['Shopify', 0, 0, GRAY, 0]]);
});

test('POPW：原單是 2025 年 → 寫到 2025 已出貨；寄國外 → INT', () => {
  const ctx = ctxWith({ preorders: { CA35889D: { row: 9, B: '', C: '2025-09-01', D: 'Anakin', I: 1, L: 1, M: 679.99, N: 0, Nvalue: 0 } } });
  const p = planOrder(draft({ country: 'DE', shippingTitle: 'International Shipping - Germany', shippingCharged: 285, lines: [popwLine('CA35889D', 'Anakin', '1', 679.99)] }), ctx);
  const s = ops(p, 'appendShipped')[0];
  assert.deepEqual([s.year, s.region, s.label], [2025, 'INT', '2025已出貨 INT（POPW）']);
});

test('POPW：原單的保險平分給每個預購商品；不管哪個先出貨，每一項都加自己那一份', () => {
  const ins = (n) => line('Damage & Loss Insurance - $5.00 (Coverage up to $400 for every $5. Package theft is not covered)', 5, { qty: n, sku: '', requiresShipping: false });
  const orig = order({ name: 'CA9D', shippingCharged: 0, payments: [], lines: [
    ins(1), line('P1 - Pay in full', 50, { sku: '11', requiresShipping: false }),
    line('P2 - Pay in full', 60, { sku: '22', requiresShipping: false }), line('P3 - Pay in full', 70, { sku: '33', requiresShipping: false })] });
  const preorders = {
    'CA9D-1': { row: 1, B: '', C: '2026-01-01', D: 'P1', I: 11, L: 1, M: 50, N: 50, Nvalue: 50 },
    'CA9D-2': { row: 2, B: '', C: '2026-01-01', D: 'P2', I: 22, L: 1, M: 60, N: 60, Nvalue: 60 },
    'CA9D-3': { row: 3, B: '', C: '2026-01-01', D: 'P3', I: 33, L: 1, M: 70, N: 70, Nvalue: 70 }
  };
  const together = planOrder(draft({ shippingCharged: 14.99, lines: [popwLine('CA9D-1', 'P1', '11', 0), popwLine('CA9D-2', 'P2', '22', 0)] }), ctxWith({ preorders, originals: { CA9D: orig } }));
  // $5 ÷ 3 個預購商品 = 1.67、1.67、1.66；第一項另外加出貨單運費
  assert.deepEqual(ops(together, 'appendShipped').map((r) => r.values.L), [16.66, 1.67]);
  const later = planOrder(draft({ shippingCharged: 0, lines: [popwLine('CA9D-3', 'P3', '33', 0)] }), ctxWith({ preorders, originals: { CA9D: orig }, baseShipped: { CA9D: true } }));
  assert.deepEqual(ops(later, 'appendShipped').map((r) => r.values.L), [1.66]);
});

test('POPW：原單預付的運費只在第一個出貨的商品加一次', () => {
  const orig = order({ name: 'CA8D', source: 'pos', shippingCharged: 0, payments: [], lines: [
    line('Flat Rate Shipping', 14.99, { sku: '' }),
    line('P1 - Pay in full', 50, { sku: '11', requiresShipping: false }), line('P2 - Pay in full', 60, { sku: '22', requiresShipping: false })] });
  const preorders = {
    'CA8D-1': { row: 1, B: 'shipping paid', C: '2026-01-01', D: 'P1', I: 11, L: 1, M: 50, N: 50, Nvalue: 50 },
    'CA8D-2': { row: 2, B: 'shipping paid', C: '2026-01-01', D: 'P2', I: 22, L: 1, M: 60, N: 60, Nvalue: 60 }
  };
  const first = planOrder(draft({ shippingCharged: 0, lines: [popwLine('CA8D-1', 'P1', '11', 0)] }), ctxWith({ preorders, originals: { CA8D: orig } }));
  assert.deepEqual(ops(first, 'appendShipped').map((r) => r.values.L), [14.99]);
  const second = planOrder(draft({ shippingCharged: 0, lines: [popwLine('CA8D-2', 'P2', '22', 0)] }), ctxWith({ preorders, originals: { CA8D: orig }, baseShipped: { CA8D: true } }));
  assert.deepEqual(ops(second, 'appendShipped').map((r) => r.values.L), [0]);
});

test('POPW：同一張原單的商品照編號從小到大寫入；不同原單照出貨單上的先後；運費和手續費記在第一項', () => {
  const preorders = {
    'CA48358D-2': { row: 2, B: '', C: '2026-07-01', D: 'Two', I: 2, L: 1, M: 20, N: 20, Nvalue: 20 },
    'CA48358D-3': { row: 3, B: '', C: '2026-07-01', D: 'Three', I: 3, L: 1, M: 30, N: 30, Nvalue: 30 },
    'CA40000D': { row: 4, B: '', C: '2026-01-01', D: 'Older', I: 4, L: 1, M: 40, N: 40, Nvalue: 40 }
  };
  const p = planOrder(draft({ shippingCharged: 14.99, lines: [popwLine('CA48358D-3', 'Three', '3', 0), popwLine('CA48358D-2', 'Two', '2', 0), popwLine('CA40000D', 'Older', '4', 0)] }), ctxWith({ preorders }));
  const rows = ops(p, 'appendShipped');
  assert.deepEqual(rows.map((r) => r.values.A), ['CA48358D-2', 'CA48358D-3', 'CA40000D']);
  assert.deepEqual(rows.map((r) => [r.values.L, r.values.O]), [[14.99, 2.56], [0, 0], [0, 0]]);
});

test('現貨＋預購混合，原單有保險：現貨那一列只記運費，保險平分給預購商品出貨時記', () => {
  const ins = line('Damage & Loss Insurance - $5.00 (Coverage up to $400 for every $5. Package theft is not covered)', 5, { sku: '', requiresShipping: false });
  const orig = order({ name: 'CA52654D', shippingCharged: 14.99, payments: [{ createdAt: 'x', gateway: 'shopify_payments', amount: 200, fee: 6 }], lines: [
    ins, line('Stock A', 50), line('Pre B - Pay in full', 60, { sku: '22', requiresShipping: false }), line('Pre C - Pay in full', 70, { sku: '33', requiresShipping: false })] });
  const created = planOrder(orig);
  const stockRow = ops(created, 'appendShipped')[0];
  assert.equal(stockRow.values.L, 14.99);
  // 手續費全額記在第一項現貨
  assert.equal(stockRow.values.N, 6);
  const preorders = { 'CA52654D-2': { row: 9, B: '', C: '2026-10-05', D: 'Pre B', I: 22, L: 1, M: 60, N: 60, Nvalue: 60 } };
  const ctx = Object.assign(ctxWith({ preorders, originals: { CA52654D: orig }, baseShipped: { CA52654D: true } }), {
    shippedCandidates: (base) => (base === 'CA52654D' ? [{ code: 'CA52654D-1', N: 6 }] : [])
  });
  const popw = planOrder(draft({ shippingCharged: 0, lines: [popwLine('CA52654D-2', 'Pre B', '22', 0)] }), ctx);
  const r = ops(popw, 'appendShipped')[0];
  assert.equal(r.values.L, 2.5);
  assert.equal(r.values.N, 0);
});

test('POPW：PW 商品出貨，已出貨那一列 L 欄已經有運費 → 已登記', () => {
  const ctx = ctxWith({ shipped: { 'CA52471D': { file: 'main', tab: '2026已出貨 CA', row: 10100, L: 19.99, O: 0.8 } } });
  const p = planOrder(draft({ shippingCharged: 14.99, lines: [popwLine('CA52471D', 'X', '1', 0)] }), ctx);
  assert.equal(classifyPlan(p), 'done');
  assert.equal(ops(p, 'updateShipped').length, 0);
  // 只有保險（$5 < 運費 $14.99）→ 還沒處理
  const ctx2 = ctxWith({ shipped: { 'CA52471D': { file: 'main', tab: '2026已出貨 CA', row: 10100, L: 5, O: 0 } } });
  const p2 = planOrder(draft({ shippingCharged: 14.99, lines: [popwLine('CA52471D', 'X', '1', 0)] }), ctx2);
  assert.equal(ops(p2, 'updateShipped')[0].set.L, 19.99);
});

test('POPW：清單摘要列出原單號', () => {
  const ctx = ctxWith({ preorders: { CA1D: { row: 5, B: '', C: '2026-03-01', D: 'X', I: 1, L: 1, M: 100, N: 100, Nvalue: 100 } } });
  assert.match(planOrder(draft({ lines: [popwLine('CA1D', 'X', '1', 0)] }), ctx).summary, /POPW 出貨 1 項（CA1D）/);
});

test('POPW：PW 存放的現貨出貨 → 修改原本已出貨那一列的 L 和 O', () => {
  const ctx = ctxWith({ shipped: { 'CA52681D-1': { file: 'main', tab: '2026已出貨 CA', row: 10250, L: 0, O: 0 }, 'CA52681D-2': { file: 'main', tab: '2026已出貨 CA', row: 10251, L: 0, O: 0 } } });
  const p = planOrder(draft({ payments: [{ createdAt: 'x', gateway: 'paypal', amount: 16.79, fee: 0.79 }], lines: [popwLine('CA52681D-1', 'Gen', '1', 0), popwLine('CA52681D-2', 'Sonic', '2', 0)] }), ctx);
  const u = ops(p, 'updateShipped');
  assert.equal(u.length, 1);
  assert.deepEqual([u[0].row, u[0].set], [10250, { L: 14.99, O: 0.79 }]);
});

test('POPW：找不到原單號 → 錯誤', () => {
  const p = planOrder(draft({ lines: [popwLine('CA99D', 'X', '1', 0)] }), ctxWith({}));
  assert.match(p.errors.join(), /找不到/);
});

test('POPW：自取 → M=0 青色；Duties 不記', () => {
  const ctx = ctxWith({ preorders: { CA1D: { row: 5, B: '', C: '2026-03-01', D: 'X', I: 1, L: 1, M: 100, N: 100, Nvalue: 100 } } });
  const p = planOrder(draft({ shippingTitle: 'Vancouver (Renfrew)', shippingCharged: 0, lines: [popwLine('CA1D', 'X', '1', 0), line('Duties (US)', 11.25, { sku: '', requiresShipping: false })] }), ctx);
  const r = ops(p, 'appendShipped')[0];
  assert.deepEqual([r.values.L, r.values.M, r.colors.M], [0, 0, CYAN]);
});

// ---- 批次清單的狀態 ----

test('classifyPlan：已登記／部分已登記／錯誤／需確認／可寫入／不用記錄', () => {
  const a = (op, key) => ({ op, key });
  assert.equal(classifyPlan({ actions: [a('appendShipped', 'x-1'), a('appendShipped', 'x-2')], errors: ['d1', 'd2'], warnings: [], duplicates: ['x-1', 'x-2'] }), 'done');
  assert.equal(classifyPlan({ actions: [a('appendShipped', 'x-1'), a('appendPreorder', 'x-2')], errors: ['d1'], warnings: [], duplicates: ['x-1'] }), 'partial');
  assert.equal(classifyPlan({ actions: [a('appendShipped', 'x')], errors: ['d1', 'other'], warnings: [], duplicates: ['x'] }), 'partial');
  // POPW：已出貨那一列已存在，預購表的修改也算已處理
  assert.equal(classifyPlan({ actions: [a('appendShipped', 'y'), a('updatePreorder', 'y')], errors: ['d'], warnings: [], duplicates: ['y'] }), 'done');
  assert.equal(classifyPlan({ actions: [], errors: ['INT 還沒付清'], warnings: [] }), 'error');
  assert.equal(classifyPlan({ actions: [a('appendShipped')], errors: [], warnings: ['w'] }), 'warn');
  assert.equal(classifyPlan({ actions: [a('appendShipped')], errors: [], warnings: [] }), 'ready');
  assert.equal(classifyPlan({ actions: [{ op: 'ensureOrdering', skip: true }], errors: [], warnings: [] }), 'nothing');
});

// ---- 原單資料（預購單記錄時存，出貨時讀） ----

test('預購單記錄時，存每個預購商品分到的保險、手續費、預付運費', () => {
  const ins = line('Damage & Loss Insurance - $5.00 (Coverage up to $400 for every $5. Package theft is not covered)', 5, { sku: '', requiresShipping: false });
  const p = planOrder(order({
    shippingCharged: 14.99, payments: [{ createdAt: 'x', gateway: 'shopify_payments', amount: 100, fee: 4 }],
    lines: [ins, line('P1 - Pay a 20% non-refundable deposit', 20, { sku: '11', requiresShipping: false }), line('P2 - Pay in full', 60, { sku: '22', requiresShipping: false })]
  }));
  const saved = ops(p, 'saveOriginal');
  assert.equal(saved.length, 2);
  // D＝整張原單的手續費（記在第一個出貨的商品），G＝全額
  assert.deepEqual(saved[0].values, { A: 'CA1000D-1', B: 'CA1000D', C: 2.5, D: 4, E: 14.99, F: '2026-10-14', G: '全額' });
  assert.deepEqual([saved[1].values.C, saved[1].values.D, saved[1].values.E], [2.5, 4, 14.99]);
});

test('原單手續費全額記在第一個出貨的商品：同一張出貨單第二項、之後的出貨單記 0；舊規則存的照比例', () => {
  const preorders = {
    'CA7D-1': { row: 1, B: '', C: '2026-10-01', D: 'P1', I: 11, L: 1, M: 50, N: 50, Nvalue: 50 },
    'CA7D-2': { row: 2, B: '', C: '2026-10-01', D: 'P2', I: 22, L: 1, M: 60, N: 60, Nvalue: 60 },
    'CA7D-3': { row: 3, B: '', C: '2026-10-01', D: 'P3', I: 33, L: 1, M: 70, N: 70, Nvalue: 70 }
  };
  const savedFull = { extras: 0, fee: 5, prepaid: 0, full: true };
  const withShipped = (cands) => Object.assign(ctxWith({ preorders }), { findSaved: () => savedFull, shippedCandidates: () => cands });
  // 第一次出貨（-2、-1 一起）：-1 記全額，-2 記 0
  let p = planOrder(draft({ lines: [popwLine('CA7D-2', 'P2', '22', 0), popwLine('CA7D-1', 'P1', '11', 0)] }), withShipped([]));
  assert.deepEqual(ops(p, 'appendShipped').map((r) => [r.values.A, r.values.N]), [['CA7D-1', 5], ['CA7D-2', 0]]);
  // 之後出貨 -3：其他列已經記了 $5 → 0
  p = planOrder(draft({ lines: [popwLine('CA7D-3', 'P3', '33', 0)] }), withShipped([{ code: 'CA7D-1', N: 5 }, { code: 'CA7D-2', N: 0 }]));
  assert.equal(ops(p, 'appendShipped')[0].values.N, 0);
  // 以前按比例記了一部分 → 記剩下的
  p = planOrder(draft({ lines: [popwLine('CA7D-3', 'P3', '33', 0)] }), withShipped([{ code: 'CA7D-1', N: 1.2 }]));
  assert.equal(ops(p, 'appendShipped')[0].values.N, 3.8);
  // 其他列 N 空白 → 提醒
  p = planOrder(draft({ lines: [popwLine('CA7D-3', 'P3', '33', 0)] }), withShipped([{ code: 'CA7D-1', N: '' }]));
  assert.match(p.warnings.join(), /CA7D-1 N 欄是空的/);
  // 舊規則存的（G 欄空白）：D 是這一項分到的，直接用
  const old = Object.assign(ctxWith({ preorders }), { findSaved: () => ({ extras: 0, fee: 1.7, prepaid: 0 }), shippedCandidates: () => [{ code: 'CA7D-1', N: 2 }] });
  p = planOrder(draft({ lines: [popwLine('CA7D-3', 'P3', '33', 0)] }), old);
  assert.equal(ops(p, 'appendShipped')[0].values.N, 1.7);
});

test('INT 現貨＋預購：原單手續費只算第一筆付款（補運費那筆記在現貨的 O）', () => {
  const p = planOrder(order({
    country: 'JP', financialStatus: 'paid', shippingCharged: 60,
    payments: [{ createdAt: '1', gateway: 'shopify_payments', amount: 100, fee: 3 }, { createdAt: '2', gateway: 'shopify_payments', amount: 60, fee: 2 }],
    lines: [line('Stock A', 50), line('Pre B - Pay in full', 50, { sku: '22', requiresShipping: false })]
  }));
  const r = ops(p, 'appendShipped')[0];
  assert.deepEqual([r.values.N, r.values.O], [3, 2]);
  assert.equal(ops(p, 'saveOriginal')[0].values.D, 3);
});

test('保險分到的折扣移回商品（按商品金額比例），保險維持原價', () => {
  const ins = line('Damage & Loss Insurance - $5.00 (Coverage up to $400 for every $5. Package theft is not covered)', 5, { sku: '', requiresShipping: false, discount: 0.5 });
  const p = planOrder(order({
    shippingCharged: 0,
    lines: [ins, line('A - Pay in full', 60, { sku: '11', requiresShipping: false, discount: 6 }), line('B - Pay a 20% non-refundable deposit', 40, { sku: '22', requiresShipping: false, discount: 3.5 })]
  }));
  const pre = ops(p, 'appendPreorder');
  // 0.5 按 60:40 分：A +0.3、B +0.2
  assert.deepEqual(pre.map((r) => r.values.N), [53.7, 36.3]);
  assert.equal(pre[1].values.M, Math.round((40 * 5 - 0.01 - 3.7) * 100) / 100);
  assert.deepEqual(ops(p, 'saveOriginal').map((r) => r.values.C), [2.5, 2.5]);
  assert.match(p.notes.join(), /折扣 \$0\.5 移回商品/);
});

test('兩個出貨地點：照 Shopify 後台的分組編號（CA53291D）', () => {
  const p = planOrder(order({
    name: 'CA53291D', shippingCharged: 0,
    lines: [
      line('Trunks - Pay a 20% non-refundable deposit', 24, { sku: '4573102736659', requiresShipping: false, group: 0, location: 'Vancouver (Marine Drive)' }),
      line('FULL POWER FRIEZA - Pay a 20% non-refundable deposit', 30, { sku: '4580886840151', requiresShipping: false, group: 1, location: 'Vancouver (Renfrew)' }),
      line('Vegeta - Pay a 20% non-refundable deposit', 12, { sku: '4580886840380', requiresShipping: false, group: 0, location: 'Vancouver (Marine Drive)' })
    ]
  }));
  assert.deepEqual(ops(p, 'appendPreorder').map((r) => [r.values.A, r.values.I]),
    [['CA53291D-1', 4573102736659], ['CA53291D-2', 4580886840380], ['CA53291D-3', 4580886840151]]);
  assert.match(p.notes.join(), /Vancouver \(Marine Drive\)（-1、-2），Vancouver \(Renfrew\)（-3）/);
  // 讀不到分組 → 照商品順序並提醒
  const q = planOrder(order({ groupError: 'app 缺少權限', shippingCharged: 0, lines: [line('A', 10), line('B', 20)] }));
  assert.match(q.warnings.join(), /讀不到出貨地點分組/);
});

test('POPW：控制台有原單資料時直接用（原單超過 60 天也可以），不用再讀原單', () => {
  let fetched = 0;
  const ctx = Object.assign(ctxWith({ preorders: { 'CA1000D-1': { row: 7, B: 'shipping paid', C: '2026-02-01', D: 'P1', I: 11, L: 1, M: 99.99, N: 20, Nvalue: 20 } } }), {
    findSaved: (code) => (code === 'CA1000D-1' ? { extras: 2.5, fee: 0.9, prepaid: 14.99 } : null),
    findOriginal: () => { fetched++; return null; }
  });
  const p = planOrder(draft({ shippingCharged: 0, lines: [popwLine('CA1000D-1', 'P1', '11', 79.99)] }), ctx);
  assert.equal(fetched, 0);
  const r = ops(p, 'appendShipped')[0];
  assert.deepEqual([r.values.L, r.values.N], [17.49, 0.9]);
  assert.ok(!p.warnings.some((w) => /讀不到原單/.test(w)));
});

// ---- POPW 出貨單裡另外加了現貨 ----

test('POPW 出貨單加了現貨：現貨用出貨單單號記錄（運費、手續費記在現貨），POPW 那一列 L、O 是 0、M 灰色', () => {
  const ctx = ctxWith({ preorders: { CA42485D: { row: 5, B: '', C: '2026-03-02', D: 'Niformation', I: 1, L: 1, M: 149.99, N: 149.99, Nvalue: 149.99 } } });
  const p = planOrder(draft({ name: 'CA52878D', shippingCharged: 14.99, payments: [{ createdAt: 'x', gateway: 'shopify_payments', amount: 172, fee: 4.85 }],
    lines: [popwLine('CA42485D', 'Niformation', '1', 0), line('Mega Cat Project One Piece Nyan Pie', 139.99, { sku: '4535123848902' })] }), ctx);
  assert.deepEqual(p.errors, []);
  const rows = ops(p, 'appendShipped');
  assert.deepEqual(rows.map((r) => r.values.A), ['CA52878D', 'CA42485D']);
  assert.deepEqual([rows[0].values.C, rows[0].values.K, rows[0].values.L, rows[0].values.N], ['Shopify', 139.99, 14.99, 4.85]);
  assert.deepEqual([rows[1].values.L, rows[1].values.O, rows[1].values.M, rows[1].colors.M], [0, 0, 0, '#cccccc']);
});

test('POPW 出貨單只有 POPW 商品：出貨單單號本身不記錄', () => {
  const ctx = ctxWith({ preorders: { CA1D: { row: 5, B: '', C: '2026-03-01', D: 'X', I: 1, L: 1, M: 100, N: 100, Nvalue: 100 } } });
  const p = planOrder(draft({ name: 'CA52999D', lines: [popwLine('CA1D', 'X', '1', 0)] }), ctx);
  assert.ok(!ops(p, 'appendShipped').some((r) => r.values.A === 'CA52999D'));
});

test('POPW：商品名稱用空格隔開（「CA39736D 品名」）也認得', () => {
  const ctx = ctxWith({ preorders: { CA39736D: { row: 5, B: '', C: '2025-11-01', D: 'Tamaki', I: 1, L: 1, M: 79.99, N: 16, Nvalue: 16 } } });
  const p = planOrder(draft({ lines: [line('CA39736D Nendoroid No.2104 Tamaki Suou', 63.99, { sku: '' }), line('Private Warehouse Storage Fee', 2, { sku: '', requiresShipping: false })] }), ctx);
  assert.deepEqual(p.errors, []);
  const r = ops(p, 'appendShipped')[0];
  assert.deepEqual([r.values.A, r.values.L], ['CA39736D', 16.99]);
  assert.equal(ops(p, 'updatePreorder')[0].paidAfter, 79.99);
});

test('「Prepaid Duties (US)」不記錄', () => {
  const ctx = ctxWith({ preorders: { CA47611D: { row: 5, B: '', C: '2026-06-21', D: 'Rapi', I: 1, L: 1, M: 309.99, N: 309.99, Nvalue: 309.99 } } });
  const p = planOrder(draft({ shippingCharged: 24.99, lines: [popwLine('CA47611D', 'Rapi', '1', 0), line('Prepaid Duties (US)', 31, { sku: '', requiresShipping: false })] }), ctx);
  assert.deepEqual(ops(p, 'appendShipped').map((r) => [r.values.A, r.values.L]), [['CA47611D', 24.99]]);
});

test('POPW：PW／現貨商品自取出貨，沒有運費也沒有手續費 → 原本那一列不用改，算已登記（CA52841D）', () => {
  const ctx = ctxWith({ shipped: { CA50480D: { file: 'main', tab: '2026已出貨 CA', row: 8498, L: 0, O: 0 } } });
  const p = planOrder(draft({ name: 'CA52841D', shippingTitle: 'Vancouver (Renfrew)', shippingCharged: 0, payments: [],
    lines: [popwLine('CA50480D', 'HG 1/100 YF-19 WATER DECALS', '4573102642592', 0)] }), ctx);
  assert.equal(classifyPlan(p), 'done');
  assert.equal(ops(p, 'updateShipped').length, 0);
});

test('任何關稅收費都不記錄；名稱有 Duty 但有 SKU 的商品照常記錄', () => {
  const fee = (n) => line(n, 10, { sku: '', requiresShipping: false });
  for (const n of ['Duties (US)', 'Prepaid Duties (US)', 'Import Duty', 'US duties', '關稅']) {
    const p = planOrder(order({ lines: [line('Figure', 50), fee(n)] }));
    assert.equal(ops(p, 'appendShipped')[0].values.L, 14.99, n);
    assert.ok(p.notes.some((x) => x.includes(n)), n);
  }
  const cod = planOrder(order({ lines: [line('Call of Duty Ghost Figure', 80, { sku: '4900000000001' })] }));
  assert.equal(ops(cod, 'appendShipped')[0].values.D, 'Call of Duty Ghost Figure');
});

test('一般網站訂單裡也有 POPW 商品（CA52750D）：現貨用訂單單號、POPW 用原單號', () => {
  const preorders = {
    'CA42482D-11': { row: 1, B: '', C: '2026-03-02', D: 'Xabungle', I: 1, L: 1, M: 71.99, N: 71.99, Nvalue: 71.99 },
    'CA42482D-22': { row: 2, B: '', C: '2026-03-02', D: 'Belka', I: 2, L: 1, M: 149.99, N: 54, Nvalue: 54 }
  };
  const p = planOrder(order({ name: 'CA52750D', source: 'web', shippingCharged: 0, lines: [
    line('Storm Collectibles M. Bison', 159.99), line('M.A.S.K. High Tech Helicopter', 149.99), line('M.A.S.K. Thunderhawk', 99.99),
    line('CA42482D-11\tMODEROID Xabungle (Reissue)\t(4580828674738)\t2026-10-01', 0, { sku: '' }),
    line('CA42482D-22\tCommando Belka 1/12 Action Figure\t(4595316221011)\t2026-10-01', 95.99, { sku: '' })] }), ctxWith({ preorders }));
  assert.deepEqual(p.errors, []);
  assert.deepEqual(ops(p, 'appendShipped').map((r) => r.values.A), ['CA52750D-1', 'CA52750D-2', 'CA52750D-3', 'CA42482D-11', 'CA42482D-22']);
  assert.equal(ops(p, 'updatePreorder')[1].paidAfter, 149.99);
});

test('「Store this order at my Private Warehouse」是服務，不記錄、不佔編號', () => {
  const p = planOrder(order({ lines: [line('Store this order at my Private Warehouse', 0, { sku: '' }), line('Figure', 50), line('P - Pay in full', 60, { sku: '22', requiresShipping: false })] }));
  assert.deepEqual(ops(p, 'appendShipped').map((r) => r.values.A), ['CA1000D-1']);
  assert.deepEqual(ops(p, 'appendPreorder').map((r) => r.values.A), ['CA1000D-2']);
  assert.ok(p.notes.some((n) => /Store this order/.test(n)));
});

test('舊的 PW 服務商品「Store this order at my Private Warehouse」只略過，不會把訂單當成 PW', () => {
  const p = planOrder(order({ shippingTitle: 'Flat Rate Shipping', lines: [line('Store this order at my Private Warehouse', 0, { sku: '' }), line('Figure', 50)] }));
  const r = ops(p, 'appendShipped')[0];
  assert.deepEqual([r.values.A, r.values.M, r.colors.M], ['CA1000D', '', undefined]);
  assert.equal(ops(p, 'appendPW').length, 0);
});

test('POPW：沒寫編號、候選有好幾個又對不出來 → 錯誤，請手動', () => {
  const cands = [{ code: 'CA5D-1', row: 1, D: 'A', I: 1 }, { code: 'CA5D-2', row: 2, D: 'B', I: 2 }];
  const ctx = Object.assign(ctxWith({}), { preorderCandidates: () => cands });
  const p = planOrder(draft({ lines: [popwLine('CA5D', 'Something Else', '9', 0)] }), ctx);
  assert.match(p.errors.join(), /好幾個 CA5D-N（CA5D-1、CA5D-2）/);
});
