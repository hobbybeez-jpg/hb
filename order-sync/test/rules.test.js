'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { planOrder, rulesAllocate, rulesCleanName } = require('../src/Rules.js');

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

test('INT：還沒付清不處理；付清後 N=第一筆付款手續費、O=補運費那筆的手續費', () => {
  const lines = [line('Figure', 289.99)];
  const pending = planOrder(order({ country: 'AU', shippingTitle: 'International Shipping', financialStatus: 'partially_paid', shippingCharged: 66, lines }));
  assert.match(pending.errors.join(), /INT/);
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

test('現貨＋預購混合：現貨先編號，手續費按已付金額比例分攤', () => {
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
  // 現貨部分 = 79.99 + 94.99 + 14.99 = 189.97；全部 = 189.97 + 219.99 = 409.96
  assert.equal(rows[0].values.N, Math.round(10 * 189.97 / 409.96 * 100) / 100);
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
  assert.deepEqual(s.values, { A: 'CA46701D', B: '2026-06-03', C: 'PO-Shopify', D: 'Rocketboy Platea', J: 1, K: 359.99, L: 19.99, M: '', N: Math.round(2.6 * 72 / 77 * 100) / 100, O: 2.56 });
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

test('POPW：原單的保險只加一次（原單已有出貨紀錄就不加）', () => {
  const orig = order({ name: 'CA9D', shippingCharged: 0, payments: [], lines: [
    line('Damage & Loss Insurance - $5.00 (Coverage up to $400 for every $5. Package theft is not covered)', 5, { sku: '', requiresShipping: false }),
    line('P1 - Pay in full', 50, { sku: '11', requiresShipping: false }), line('P2 - Pay in full', 60, { sku: '22', requiresShipping: false })] });
  const preorders = {
    'CA9D-1': { row: 1, B: '', C: '2026-01-01', D: 'P1', I: 11, L: 1, M: 50, N: 50, Nvalue: 50 },
    'CA9D-2': { row: 2, B: '', C: '2026-01-01', D: 'P2', I: 22, L: 1, M: 60, N: 60, Nvalue: 60 }
  };
  const both = planOrder(draft({ shippingCharged: 0, lines: [popwLine('CA9D-1', 'P1', '11', 0), popwLine('CA9D-2', 'P2', '22', 0)] }), ctxWith({ preorders, originals: { CA9D: orig } }));
  assert.deepEqual(ops(both, 'appendShipped').map((r) => r.values.L), [5, 0]);
  const later = planOrder(draft({ shippingCharged: 0, lines: [popwLine('CA9D-2', 'P2', '22', 0)] }), ctxWith({ preorders, originals: { CA9D: orig }, baseShipped: { CA9D: true } }));
  assert.deepEqual(ops(later, 'appendShipped').map((r) => r.values.L), [0]);
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
const { classifyPlan } = require('../src/Rules.js');

test('classifyPlan：已登記／部分已登記／錯誤／需確認／可寫入／不用記錄', () => {
  const a = (op) => ({ op });
  assert.equal(classifyPlan({ actions: [a('appendShipped'), a('appendShipped')], errors: ['d1', 'd2'], warnings: [], duplicates: ['x-1', 'x-2'] }), 'done');
  assert.equal(classifyPlan({ actions: [a('appendShipped'), a('appendPreorder')], errors: ['d1'], warnings: [], duplicates: ['x-1'] }), 'partial');
  assert.equal(classifyPlan({ actions: [a('appendShipped')], errors: ['d1', 'other'], warnings: [], duplicates: ['x'] }), 'partial');
  assert.equal(classifyPlan({ actions: [], errors: ['INT 還沒付清'], warnings: [] }), 'error');
  assert.equal(classifyPlan({ actions: [a('appendShipped')], errors: [], warnings: ['w'] }), 'warn');
  assert.equal(classifyPlan({ actions: [a('appendShipped')], errors: [], warnings: [] }), 'ready');
  assert.equal(classifyPlan({ actions: [{ op: 'ensureOrdering', skip: true }], errors: [], warnings: [] }), 'nothing');
});
