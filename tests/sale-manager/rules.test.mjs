import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cents, salePrice, percentOff, blockedTags, ineligibleReason, planChanges, planRestore,
  productsCollector, ordersCollector, readJsonl
} from '../../supabase/functions/sale-manager/rules.js';

test('特價＝原價 60% 無條件進位到 x9.99', () => {
  assert.equal(salePrice('123.00'), '79.99');   // 73.80
  assert.equal(salePrice('133.31'), '79.99');   // 79.986
  assert.equal(salePrice('133.35'), '89.99');   // 80.01
  assert.equal(salePrice('16.65'), '9.99');     // 9.99 exactly
  assert.equal(salePrice('50'), '39.99');       // 30.00
  assert.equal(salePrice('49.99'), '39.99');    // 29.994 -> 39.99
  assert.equal(salePrice('1000.00'), '609.99'); // 600.00
  assert.equal(salePrice('15.00'), '9.99');
  // 特價不比原價低：不打折
  assert.equal(salePrice('9.99'), null);
  assert.equal(salePrice('5'), null);
  assert.equal(salePrice('0'), null);
  assert.equal(salePrice(''), null);
  assert.equal(salePrice('abc'), null);
});

test('金額、折扣百分比', () => {
  assert.equal(cents('12.5'), 1250);
  assert.equal(cents('12.345'), 1234);
  assert.equal(cents(null), null);
  assert.equal(percentOff('100.00', '59.99'), 40);
  assert.equal(percentOff('12.00', '9.99'), 17);
});

test('tag 不分大小寫；沒庫存不符合', () => {
  assert.deepEqual(blockedTags(['Sale', 'figure', '20OFF']), ['sale', '20off']);
  assert.deepEqual(blockedTags(['wholesale', 'sale-2024']), []);
  assert.equal(ineligibleReason({ tags: ['40off'], totalInventory: 3 }), 'Already tagged 40off.');
  assert.equal(ineligibleReason({ tags: [], totalInventory: 0 }), 'Out of stock.');
  assert.equal(ineligibleReason({ tags: ['new'], totalInventory: 1 }), '');
});

test('套用：只改得了價的款式；記下原本的 compare-at', () => {
  const changes = planChanges([
    { id: 'v1', title: 'Red', price: '100.00', compareAtPrice: '120.00' },
    { id: 'v2', title: 'Mini', price: '8.00', compareAtPrice: null }
  ]);
  assert.deepEqual(changes, [{ id: 'v1', title: 'Red', sku: '', barcode: '', origPrice: '100.00', origCompareAt: '120.00', salePrice: '69.99' }]);  // 60.00 -> 69.99
});

test('還原：特價沒被動過才還原；已還原的不重複；被改過的留著並註記', () => {
  const changes = [
    { id: 'v1', title: 'A', origPrice: '100.00', origCompareAt: null, salePrice: '59.99' },
    { id: 'v2', title: 'B', origPrice: '50.00', origCompareAt: '70.00', salePrice: '39.99' },
    { id: 'v3', title: 'C', origPrice: '30.00', origCompareAt: null, salePrice: '19.99' },
    { id: 'v4', title: 'D', origPrice: '30.00', origCompareAt: null, salePrice: '19.99' }
  ];
  const live = [
    { id: 'v1', price: '59.99', compareAtPrice: '100.00' },
    { id: 'v2', price: '50.00', compareAtPrice: '70.00' },
    { id: 'v3', price: '25.00', compareAtPrice: '30.00' }
  ];
  const plan = planRestore(changes, live);
  assert.deepEqual(plan.restore, [{ id: 'v1', price: '100.00', compareAtPrice: null }]);
  assert.deepEqual(plan.notes, ['C: price was changed to 25.00 during the sale, left as is.', 'D: variant was deleted.']);
});

test('bulk 結果：子項目可能在父項目前面；取消的訂單不算銷售', async () => {
  const lines = [
    { id: 'v-a', title: 'Default Title', price: '20.00', __parentId: 'p-a', inventoryQuantity: 2 },
    { id: 'p-a', title: 'A', tags: [], totalInventory: 2, status: 'ACTIVE' },
    { id: 'p-b', title: 'B', tags: ['SALE'], totalInventory: 2 },
    { id: 'p-c', title: 'C', tags: [], totalInventory: 0 },
    { id: 'p-d', title: 'D', tags: [], totalInventory: 1 },
    { id: 'v-d', title: 'Default Title', price: '5.00', __parentId: 'p-d' }
  ];
  const text = lines.map((l) => JSON.stringify(l)).join('\n');
  const stream = new Blob([text.slice(0, 50), text.slice(50)]).stream();
  const products = productsCollector();
  await readJsonl(stream, (o) => products.add(o));
  const { candidates, stats } = products.candidates();
  assert.deepEqual(candidates.map((p) => [p.id, p.canDiscount]), [['p-a', true], ['p-d', false]]);
  assert.equal(candidates[0].variants[0].salePrice, '19.99');  // 12.00 -> 19.99
  assert.deepEqual(stats, { products: 4, inStock: 3, untagged: 2 });

  const orders = ordersCollector(['p-a', 'p-d']);
  for (const o of [
    { product: { id: 'p-a' }, __parentId: 'o1' },
    { id: 'o1', cancelledAt: '2026-01-01T00:00:00Z' },
    { id: 'o2', cancelledAt: null },
    { product: { id: 'p-d' }, __parentId: 'o2' },
    { product: null, __parentId: 'o2' },
    { product: { id: 'p-x' }, __parentId: 'o2' }
  ]) orders.add(o);
  assert.deepEqual([...orders.soldIds()], ['p-d']);
  assert.equal(orders.orders, 2);
});
