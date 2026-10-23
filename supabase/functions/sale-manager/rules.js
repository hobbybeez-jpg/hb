// Sale Manager rules: which products qualify, the sale price, and reading Shopify bulk operation results.
// Pure functions (no database, no network) so they can be tested on their own.

// Products with any of these tags (any letter case) are already on a sale
export const BLOCKED_TAGS = ['sale', '20off', '40off'];
// Tags added while a product is on sale (removed again when the sale ends)
export const SALE_TAGS = ['sale', '40off'];
// Sale price = 60% of the price, rounded up to the next price ending in 9.99
export const SALE_PERCENT = 60;
// A product sold within this many years does not qualify
export const NO_SALES_YEARS = 2;

// "12.5" -> 1250; null for anything that is not a price
export function cents(value) {
  if (value == null || value === '') return null;
  const m = /^\s*(\d+)(?:\.(\d{1,2})\d*)?\s*$/.exec(String(value));
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] || '0').padEnd(2, '0'));
}

export const money = (c) => (c / 100).toFixed(2);

// 60% of the price, rounded up to x9.99 (9.99, 19.99, 29.99, ...): 123.00 -> 73.80 -> 79.99.
// null when that is not lower than the price (cheap items: 15.00 -> 9.99 is fine, 9.99 -> 9.99 is not).
export function salePrice(price) {
  const c = cents(price);
  if (c == null || c <= 0) return null;
  // Compare in tenths of a cent so 60% of any price stays a whole number
  const tenths = c * SALE_PERCENT / 10;            // c * 0.6 * 10
  const k = Math.max(0, Math.ceil((tenths - 9990) / 10000));
  const sale = 999 + 1000 * k;
  return sale < c ? money(sale) : null;
}

// Percent off, rounded to a whole number (for display)
export function percentOff(price, sale) {
  const p = cents(price);
  const s = cents(sale);
  if (!p || s == null) return null;
  return Math.round((1 - s / p) * 100);
}

export function blockedTags(tags) {
  const lower = (tags || []).map((t) => String(t).trim().toLowerCase());
  return BLOCKED_TAGS.filter((t) => lower.includes(t));
}

// Why a product (as read from Shopify now) can no longer go on sale; '' when it still can
export function ineligibleReason(product) {
  const tags = blockedTags(product.tags);
  if (tags.length) return `Already tagged ${tags.join(', ')}.`;
  if (!(Number(product.totalInventory) > 0)) return 'Out of stock.';
  return '';
}

// Variants that get a sale price: [{ id, title, sku, barcode, origPrice, origCompareAt, salePrice }]
export function planChanges(variants) {
  const out = [];
  for (const v of variants || []) {
    const sale = salePrice(v.price);
    if (!sale) continue;
    out.push({
      id: v.id, title: v.title || '', sku: v.sku || '', barcode: v.barcode || '',
      origPrice: money(cents(v.price)), origCompareAt: cents(v.compareAtPrice) == null ? null : money(cents(v.compareAtPrice)), salePrice: sale
    });
  }
  return out;
}

// Restoring after the sale: what to write back, and notes for variants left alone.
// live = the product's variants now; a variant whose price is no longer the sale price was changed by
// someone during the sale, so it is left as it is.
export function planRestore(changes, liveVariants) {
  const live = new Map((liveVariants || []).map((v) => [v.id, v]));
  const restore = [];
  const notes = [];
  for (const c of changes || []) {
    const v = live.get(c.id);
    const label = c.title && c.title !== 'Default Title' ? c.title : 'Price';
    if (!v) { notes.push(`${label}: variant was deleted.`); continue; }
    const now = cents(v.price);
    if (now === cents(c.salePrice)) {
      restore.push({ id: c.id, price: c.origPrice, compareAtPrice: c.origCompareAt });
    } else if (now === cents(c.origPrice) && cents(v.compareAtPrice) === cents(c.origCompareAt)) {
      // already restored (a retry after a lost response)
    } else {
      notes.push(`${label}: price was changed to ${v.price} during the sale, left as is.`);
    }
  }
  return { restore, notes };
}

// ---------- Bulk operation results (JSON Lines) ----------
// Child objects carry __parentId and are not always right after their parent, so join at the end.

export function productsCollector() {
  const products = new Map();
  const variants = [];
  return {
    add(obj) {
      if (obj.__parentId) variants.push(obj);
      else products.set(obj.id, obj);
    },
    // Products in stock and without a sale tag, each with its variants
    candidates() {
      const byProduct = new Map();
      for (const v of variants) {
        if (!byProduct.has(v.__parentId)) byProduct.set(v.__parentId, []);
        byProduct.get(v.__parentId).push(v);
      }
      const out = [];
      let inStock = 0;
      for (const p of products.values()) {
        if (!(Number(p.totalInventory) > 0)) continue;
        inStock += 1;
        if (blockedTags(p.tags).length) continue;
        out.push(productOut(p, byProduct.get(p.id) || []));
      }
      return { candidates: out, stats: { products: products.size, inStock, untagged: out.length } };
    }
  };
}

function productOut(p, variants) {
  const vs = variants.map((v) => ({
    id: v.id, title: v.title || '', sku: v.sku || '', barcode: v.barcode || '',
    price: v.price, compareAtPrice: v.compareAtPrice || null, inventoryQuantity: Number(v.inventoryQuantity) || 0,
    salePrice: salePrice(v.price)
  }));
  return {
    id: p.id, title: p.title || '', handle: p.handle || '', status: p.status || '', vendor: p.vendor || '',
    productType: p.productType || '', createdAt: p.createdAt || '', tags: p.tags || [],
    totalInventory: Number(p.totalInventory) || 0, variants: vs,
    canDiscount: vs.some((v) => v.salePrice)
  };
}

// Orders since the cut-off date: which of the wanted products sold (canceled orders do not count)
export function ordersCollector(wantedIds) {
  const wanted = new Set(wantedIds);
  const canceled = new Set();
  const sold = [];  // [orderId, productId]
  let orders = 0;
  return {
    add(obj) {
      if (!obj.__parentId) {
        orders += 1;
        if (obj.cancelledAt) canceled.add(obj.id);
        return;
      }
      const productId = obj.product && obj.product.id;
      if (productId && wanted.has(productId)) sold.push([obj.__parentId, productId]);
    },
    soldIds() {
      const out = new Set();
      for (const [orderId, productId] of sold) if (!canceled.has(orderId)) out.add(productId);
      return out;
    },
    get orders() { return orders; }
  };
}

// Calls onObject for each line of a JSON Lines stream (ReadableStream of bytes)
export async function readJsonl(stream, onObject) {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let rest = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (value) {
      rest += value;
      let nl;
      while ((nl = rest.indexOf('\n')) >= 0) {
        const line = rest.slice(0, nl).trim();
        rest = rest.slice(nl + 1);
        if (line) onObject(JSON.parse(line));
      }
    }
    if (done) break;
  }
  if (rest.trim()) onObject(JSON.parse(rest.trim()));
}
