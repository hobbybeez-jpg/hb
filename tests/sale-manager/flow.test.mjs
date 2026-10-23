// Sale Manager end to end: real Postgres (PGlite) with the migration, and an in-memory Shopify.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { handle } from '../../supabase/functions/sale-manager/core.js';

const MIGRATION = new URL('../../supabase/migrations/20261023000001_sale_manager.sql', import.meta.url);

async function setup() {
  const pg = new PGlite({ extensions: { pgcrypto } });
  await pg.exec('create schema extensions; create extension pgcrypto with schema extensions;');
  await pg.exec(readFileSync(MIGRATION, 'utf8'));
  await pg.exec(`insert into sale.settings (key, value) values
    ('pw_manager', extensions.crypt('manager-pw', extensions.gen_salt('bf', 4)))`);
  const db = {
    transaction: (fn) => pg.transaction((tx) => fn({ query: async (text, params) => (await tx.query(text, params || [])).rows }))
  };
  return { pg, db };
}

// In-memory Shopify: products by id, orders, bulk operations that finish on the first status check
function fakeShopify({ products, orders }) {
  const ops = new Map();
  const calls = [];
  let failNext = 0;
  const shop = {
    store: 'test.myshopify.com', configError: '', calls, products,
    failMutations(n) { failNext = n; },
    async startBulkQuery(query) {
      const id = 'gid://shopify/BulkOperation/' + (ops.size + 1);
      ops.set(id, query);
      calls.push(['bulk', query.includes('orders(') ? 'orders' : 'products']);
      return id;
    },
    async bulkOperation(id) {
      return { id, status: 'COMPLETED', objectCount: 1, url: 'mem://' + id };
    },
    async cancelBulkOperation() {},
    async download(url) {
      const query = ops.get(url.slice(6));
      const lines = [];
      if (query.includes('orders(')) {
        for (const o of orders) {
          lines.push({ id: o.id, cancelledAt: o.cancelledAt || null });
          for (const pid of o.products) lines.push({ product: pid ? { id: pid } : null, __parentId: o.id });
        }
      } else {
        // children first, like an ungrouped bulk result can be
        for (const p of Object.values(products)) {
          for (const v of p.variants) lines.push({ ...v, __parentId: p.id });
          if (p.status === 'ACTIVE') lines.push({ id: p.id, title: p.title, handle: p.title.toLowerCase(), status: p.status, vendor: 'V', productType: 'Figure', createdAt: '2023-01-01T00:00:00Z', tags: p.tags, totalInventory: p.totalInventory });
        }
      }
      return new Blob([lines.map((l) => JSON.stringify(l)).join('\n')]).stream();
    },
    async getProduct(id) {
      const p = products[id];
      return p ? structuredClone(p) : null;
    },
    async updateVariantPrices(productId, variants) {
      if (failNext > 0) { failNext -= 1; throw Object.assign(new Error('Shopify: boom'), { name: 'ShopifyError' }); }
      calls.push(['prices', productId, variants]);
      for (const u of variants) {
        const v = products[productId].variants.find((x) => x.id === u.id);
        v.price = u.price;
        v.compareAtPrice = u.compareAtPrice;
      }
    },
    async addTags(id, tags) {
      calls.push(['tagsAdd', id, tags]);
      for (const t of tags) if (!products[id].tags.includes(t)) products[id].tags.push(t);
    },
    async removeTags(id, tags) {
      calls.push(['tagsRemove', id, tags]);
      products[id].tags = products[id].tags.filter((t) => !tags.includes(t));
    }
  };
  return shop;
}

function product(n, { price = '100.00', compareAtPrice = null, tags = [], totalInventory = 3, status = 'ACTIVE', variants } = {}) {
  const id = 'gid://shopify/Product/' + n;
  return [id, {
    id, title: 'Product ' + n, status, tags: [...tags], totalInventory,
    variants: variants || [{ id: `gid://shopify/ProductVariant/${n}1`, title: 'Default Title', sku: 'SKU' + n, barcode: '000' + n, price, compareAtPrice, inventoryQuantity: totalInventory }]
  }];
}

const P = (n) => 'gid://shopify/Product/' + n;

async function world() {
  const products = Object.fromEntries([
    product(1),                                            // matches
    product(2, { tags: ['Sale'] }),                        // already on sale
    product(3, { totalInventory: 0 }),                     // out of stock
    product(4),                                            // sold within 2 years
    product(5, { price: '50.00', compareAtPrice: '65.00' }), // only in a canceled order -> matches
    product(6, { price: '9.00' }),                         // matches but too cheap to discount
    product(7, { status: 'DRAFT' }),                       // not active
    product(8, { variants: [
      { id: 'gid://shopify/ProductVariant/81', title: 'Big', price: '200.00', compareAtPrice: null, inventoryQuantity: 1 },
      { id: 'gid://shopify/ProductVariant/82', title: 'Keychain', price: '8.00', compareAtPrice: null, inventoryQuantity: 2 }
    ] })
  ]);
  const orders = [
    { id: 'gid://shopify/Order/1', products: [P(4), null] },
    { id: 'gid://shopify/Order/2', cancelledAt: '2026-01-01T00:00:00Z', products: [P(5)] }
  ];
  const { pg, db } = await setup();
  const shopify = fakeShopify({ products, orders });
  const ctx = { user: 'Amy', client: '1.2.3.4', shopify };
  const call = (fn, args, extra) => handle(db, fn, args || {}, { ...ctx, ...(extra || {}) });
  return { pg, db, shopify, products, call };
}

async function scan(call) {
  let s = await call('startScan');
  for (let i = 0; i < 5 && s.running; i++) s = await call('scanStatus', {});
  assert.equal(s.running, null);
  return s;
}

test('掃描：有庫存、沒有 sale/20off/40off、2 年內沒賣出（取消的訂單不算）', async () => {
  const { call, shopify } = await world();
  const s = await scan(call);
  assert.equal(s.last.status, 'DONE');
  assert.deepEqual(s.last.results.map((p) => p.id).sort(), [P(1), P(5), P(6), P(8)]);
  assert.equal(s.last.results.find((p) => p.id === P(6)).canDiscount, false);
  assert.deepEqual(s.last.stats, { products: 7, inStock: 6, untagged: 5, orders: 2, sold: 1, matches: 4 });
  // products first, then orders since 2 years ago
  assert.deepEqual(shopify.calls.map((c) => c[1]), ['products', 'orders']);
  // the page does not get the results again when it already has them
  const again = await call('getScan', { haveId: s.last.id });
  assert.equal(again.last.results, undefined);
});

test('套用（今天開始）→ 特價、compare-at、tag；提前結束 → 全部還原', async () => {
  const { call, shopify, products, pg } = await world();
  const s = await scan(call);
  // product 1 gets tagged 20off by someone after the scan: skipped at the start
  const created = await call('createCampaign', {
    name: 'Clearance', startDate: (await call('ping')).today, endDate: '2099-12-31',
    scanId: s.last.id, productIds: [P(1), P(5), P(8)], password: 'manager-pw'
  });
  assert.equal(created.startsNow, true);
  products[P(1)].tags.push('20OFF');

  let c = await call('processCampaign', { id: created.id });
  assert.equal(c.state, 'ON_SALE');
  assert.equal(c.more, false);
  const item = (pid) => c.items.find((i) => i.productId === pid);
  assert.equal(item(P(1)).status, 'SKIPPED');
  assert.equal(item(P(1)).note, 'Already tagged 20off.');
  assert.equal(item(P(5)).status, 'ON_SALE');
  assert.deepEqual(
    [products[P(5)].variants[0].price, products[P(5)].variants[0].compareAtPrice, products[P(5)].tags],
    ['39.99', '50.00', ['sale', '40off']]);
  // multi-variant: only the variant that can be discounted changes
  assert.deepEqual(products[P(8)].variants.map((v) => [v.price, v.compareAtPrice]), [['129.99', '200.00'], ['8.00', null]]);
  assert.match(item(P(8)).note, /1 of 2 variants/);
  // product 1 untouched
  assert.equal(products[P(1)].variants[0].price, '100.00');

  // the same products cannot go into another sale while this one runs
  await assert.rejects(call('createCampaign', {
    startDate: '2099-01-01', endDate: '2099-01-02', scanId: s.last.id, productIds: [P(5)], password: 'manager-pw'
  }), /Already in another sale: Product 5 \(Clearance\)/);

  // someone changes product 8's sale price by hand during the sale
  products[P(8)].variants[0].price = '120.00';

  await assert.rejects(call('endCampaignNow', { id: created.id, password: 'wrong' }), /Incorrect Manager password/);
  c = await call('endCampaignNow', { id: created.id, password: 'manager-pw' });
  assert.equal(c.state, 'ENDING');
  c = await call('processCampaign', { id: created.id });
  assert.equal(c.state, 'ENDED');
  assert.deepEqual(
    [products[P(5)].variants[0].price, products[P(5)].variants[0].compareAtPrice, products[P(5)].tags],
    ['50.00', '65.00', []]);
  assert.deepEqual(products[P(8)].variants.map((v) => [v.price, v.compareAtPrice]), [['120.00', '200.00'], ['8.00', null]]);
  assert.deepEqual(products[P(8)].tags, []);
  assert.match(item(P(8)).note || '', /variants on sale/);
  assert.match(c.items.find((i) => i.productId === P(8)).note, /Big: price was changed to 120.00 during the sale, left as is/);
  assert.deepEqual(c.events.map((e) => e.action), ['CREATE', 'END_NOW']);
  // 20OFF from the other person stays
  assert.deepEqual(products[P(1)].tags, ['20OFF']);
  // after the sale the products can go on sale again
  const again = await call('createCampaign', {
    startDate: '2099-01-01', endDate: '2099-01-02', scanId: s.last.id, productIds: [P(5)], password: 'manager-pw'
  });
  assert.ok(again.id > created.id);
  await pg.close();
});

test('排程：未來開始的不會先改；到時間由 tick 套用、結束後由 tick 還原；取消', async () => {
  const { call, products, pg } = await world();
  const s = await scan(call);
  const later = await call('createCampaign', { startDate: '2099-01-01', endDate: '2099-01-31', scanId: s.last.id, productIds: [P(1)], password: 'manager-pw' });
  assert.equal(later.startsNow, false);
  let c = await call('processCampaign', { id: later.id });
  assert.equal(c.state, 'SCHEDULED');
  assert.equal(c.processed, 0);
  assert.equal(products[P(1)].variants[0].price, '100.00');
  assert.equal((await pg.query('select sale.due_work() as w')).rows[0].w, false);

  // tick needs the secret
  await assert.rejects(call('tick', {}, { cronSecret: 'nope' }), /Not allowed/);
  const secret = (await pg.query("select value from sale.settings where key = 'cron_secret'")).rows[0].value;

  // start time reached
  await pg.query("update sale.campaigns set start_at = now() - interval '1 minute' where id = $1", [later.id]);
  assert.equal((await pg.query('select sale.due_work() as w')).rows[0].w, true);
  assert.deepEqual(await call('tick', {}, { cronSecret: secret, user: '' }), { processed: 1 });
  assert.equal(products[P(1)].variants[0].price, '69.99');
  // end time reached
  await pg.query("update sale.campaigns set end_at = now() - interval '1 minute' where id = $1", [later.id]);
  assert.deepEqual(await call('tick', {}, { cronSecret: secret, user: '' }), { processed: 1 });
  assert.deepEqual([products[P(1)].variants[0].price, products[P(1)].variants[0].compareAtPrice, products[P(1)].tags], ['100.00', null, []]);
  c = await call('getCampaign', { id: later.id });
  assert.equal(c.state, 'ENDED');
  assert.ok((await call('ping')).lastTick);

  // cancel before the start: nothing changes in Shopify
  const second = await call('createCampaign', { startDate: '2099-02-01', endDate: '2099-02-02', scanId: s.last.id, productIds: [P(1), P(5)], password: 'manager-pw' });
  await assert.rejects(call('endCampaignNow', { id: second.id, password: 'manager-pw' }), /has not started yet/);
  c = await call('cancelCampaign', { id: second.id, password: 'manager-pw' });
  assert.equal(c.state, 'CANCELED');
  assert.deepEqual(c.items.map((i) => i.status), ['CANCELED', 'CANCELED']);
  assert.equal((await pg.query('select sale.due_work() as w')).rows[0].w, false);
  await pg.close();
});

test('Shopify 出錯：記下錯誤、稍後重試；試 5 次後要按 Retry', async () => {
  const { call, shopify, products, pg } = await world();
  const s = await scan(call);
  const created = await call('createCampaign', { startDate: (await call('ping')).today, endDate: '2099-12-31', scanId: s.last.id, productIds: [P(1)], password: 'manager-pw' });
  shopify.failMutations(10);
  let c = await call('processCampaign', { id: created.id });
  assert.equal(c.items[0].status, 'PENDING');
  assert.equal(c.items[0].error, 'Shopify: boom');
  assert.equal(c.more, false);   // waits a few minutes before the next try
  for (let i = 0; i < 4; i++) {
    await pg.query('update sale.items set attempt_at = null');
    c = await call('processCampaign', { id: created.id });
  }
  assert.equal(c.items[0].stuck, true);
  assert.equal(c.errors, 1);
  await pg.query('update sale.items set attempt_at = null');
  c = await call('processCampaign', { id: created.id });
  assert.equal(c.processed, 0);

  shopify.failMutations(0);
  c = await call('retryCampaign', { id: created.id });
  c = await call('processCampaign', { id: created.id });
  assert.equal(c.items[0].status, 'ON_SALE');
  assert.equal(c.items[0].error, '');
  assert.equal(products[P(1)].variants[0].price, '69.99');
  // the original price was saved before the first try, so it is still 100.00
  assert.equal(c.items[0].changes[0].origPrice, '100.00');
  await pg.close();
});

test('檢查：員工密碼、名字、日期、太便宜的商品', async () => {
  const { call, pg } = await world();
  const s = await scan(call);
  const today = (await call('ping')).today;
  await assert.rejects(call('createCampaign', { startDate: today, endDate: today, scanId: s.last.id, productIds: [P(6)], password: 'manager-pw' }), /Price too low/);
  await assert.rejects(call('createCampaign', { startDate: '2000-01-01', endDate: '2099-01-01', scanId: s.last.id, productIds: [P(1)], password: 'manager-pw' }), /cannot be in the past/);
  await assert.rejects(call('createCampaign', { startDate: '2099-01-02', endDate: '2099-01-01', scanId: s.last.id, productIds: [P(1)], password: 'manager-pw' }), /on or after the start date/);
  await assert.rejects(call('createCampaign', { startDate: '2099-01-01', endDate: '2099-01-01', scanId: s.last.id, productIds: [], password: 'manager-pw' }), /at least one product/);
  await assert.rejects(call('startScan', {}, { user: '' }), /enter your name/);

  await call('setPassword', { key: 'pw_access', value: 'staff-pass', password: 'manager-pw' });
  await assert.rejects(call('ping'), /enter the staff password/);
  await assert.rejects(call('ping', {}, { code: 'nope' }), /Incorrect staff password/);
  assert.equal((await call('ping', {}, { code: 'staff-pass' })).ok, true);
  await assert.rejects(call('setPassword', { key: 'pw_manager', value: 'short', password: 'manager-pw' }, { code: 'staff-pass' }), /at least 8/);

  // wrong passwords lock out after 5 tries
  for (let i = 0; i < 4; i++) await assert.rejects(call('ping', {}, { code: 'bad' + i }), /Incorrect/);  // 5 with 'nope' above
  await assert.rejects(call('ping', {}, { code: 'another-guess' }), /Too many wrong passwords/);
  await pg.close();
});

test('掃描讀到一半中斷：5 分鐘後由下一次查詢接手完成', async () => {
  const { call, pg } = await world();
  await call('startScan');
  // a request claimed the products file and then died
  await pg.query("update sale.scans set status = 'READ_PRODUCTS', attempt_at = now()");
  let s = await call('scanStatus', {});
  assert.equal(s.running.status, 'READ_PRODUCTS');   // still held by the other request
  await pg.query("update sale.scans set attempt_at = now() - interval '6 minutes'");
  for (let i = 0; i < 3 && s.running; i++) s = await call('scanStatus', {});
  assert.equal(s.running, null);
  assert.equal(s.last.stats.matches, 4);
  await pg.close();
});
