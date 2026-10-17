// Shopify.js — 讀 Shopify 訂單（Admin GraphQL API），轉成 Rules.js 用的格式
//
// Script Properties（擴充功能 → Apps Script → 專案設定 → 指令碼屬性；或用選單「設定 Shopify 金鑰」）：
//   SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET   Dev Dashboard app（client credentials，token 每 24 小時自動換）
//   或 SHOPIFY_ADMIN_TOKEN                        2026 年以前在後台建立的舊式 custom app 的 token（shpat_…）
// App 權限：read_orders、read_products（讀 Pre-Order Deadline）。沒有 read_all_orders 時只讀得到最近 60 天的訂單

var SHOPIFY_ORDER_FIELDS = [
  'id name createdAt cancelledAt test sourceName email displayFinancialStatus',
  'shippingAddress { countryCodeV2 }',
  'shippingLines(first: 10) { nodes { title discountedPriceSet { shopMoney { amount } } } }',
  'lineItems(first: 250) { nodes {',
  '  name quantity currentQuantity sku requiresShipping',
  '  originalUnitPriceSet { shopMoney { amount } }',
  '  discountAllocations { allocatedAmountSet { shopMoney { amount } } }',
  '  variant { barcode }',
  '  product { descriptionHtml }',
  '} }',
  'transactions(first: 50) { id kind status gateway createdAt test amountSet { shopMoney { amount } } fees { amount { amount } } receiptJson }'
].join('\n');

var SHOPIFY_ORDER_QUERY = 'query OrderByName($q: String!) { orders(first: 5, query: $q) { nodes { ' + SHOPIFY_ORDER_FIELDS + ' } } }';

var SHOPIFY_RECENT_QUERY = 'query Recent($n: Int!) { orders(first: $n, sortKey: CREATED_AT, reverse: true) { nodes { name createdAt sourceName displayFinancialStatus cancelledAt shippingLines(first: 1) { nodes { title } } } } }';

function shopifyConfig_() {
  var settings = getSettings();
  var props = PropertiesService.getScriptProperties();
  var store = String(settings.SHOPIFY_STORE || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(store)) throw new Error('「設定」分頁的 SHOPIFY_STORE 要填 你的商店.myshopify.com');
  var version = String(settings.SHOPIFY_API_VERSION || '2026-07').trim();
  if (!/^(\d{4}-\d{2}|unstable)$/.test(version)) throw new Error('「設定」分頁的 SHOPIFY_API_VERSION 要像 2026-07（現在是「' + version + '」）。清空這一格就會用預設值。');
  return {
    store: store,
    version: version,
    adminToken: props.getProperty('SHOPIFY_ADMIN_TOKEN') || '',
    clientId: props.getProperty('SHOPIFY_CLIENT_ID') || '',
    clientSecret: props.getProperty('SHOPIFY_CLIENT_SECRET') || ''
  };
}

function shopifyToken_(cfg, renew) {
  if (cfg.adminToken) return cfg.adminToken;
  if (!cfg.clientId || !cfg.clientSecret) throw new Error('還沒設定 Shopify 金鑰：請用選單「訂單自動化 → 設定 Shopify 金鑰」。');
  var cache = CacheService.getScriptCache();
  var cached = renew ? null : cache.get('shopify_token');
  if (cached) return cached;
  var res = UrlFetchApp.fetch('https://' + cfg.store + '/admin/oauth/access_token', {
    method: 'post',
    headers: { Accept: 'application/json' },
    payload: { grant_type: 'client_credentials', client_id: cfg.clientId, client_secret: cfg.clientSecret },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) throw new Error('Shopify 登入失敗（HTTP ' + res.getResponseCode() + '）：請確認 Client ID / Secret，以及 app 已安裝在商店。');
  var body = JSON.parse(res.getContentText());
  if (!body.access_token) throw new Error('Shopify 登入失敗：沒有拿到 access token。');
  var seconds = Math.min(Number(body.expires_in) || 3600, 21600) - 300;
  cache.put('shopify_token', body.access_token, Math.max(60, seconds));
  return body.access_token;
}

function shopifyGraphql(query, variables) {
  var cfg = shopifyConfig_();
  var url = 'https://' + cfg.store + '/admin/api/' + cfg.version + '/graphql.json';
  var renewed = false;
  for (var attempt = 0; attempt < 5; attempt++) {
    var res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { Accept: 'application/json', 'X-Shopify-Access-Token': shopifyToken_(cfg, renewed && attempt > 0) },
      payload: JSON.stringify({ query: query, variables: variables || {} }),
      muteHttpExceptions: true
    });
    var code = res.getResponseCode();
    if (code === 401 && !renewed && !cfg.adminToken) { renewed = true; continue; }
    if (code === 429 || code >= 500) { Utilities.sleep(1000 * (attempt + 1)); continue; }
    if (code !== 200) throw new Error('Shopify API 錯誤 HTTP ' + code + '（' + url + '）：' + (res.getContentText().slice(0, 300) || '沒有回傳內容'));
    var body = JSON.parse(res.getContentText());
    if (body.errors && body.errors.length) {
      var throttled = body.errors.some(function (e) { return e.extensions && e.extensions.code === 'THROTTLED'; });
      if (throttled) { Utilities.sleep(1000 * (attempt + 1)); continue; }
      throw new Error('Shopify API 錯誤：' + body.errors.map(function (e) { return e.message; }).join('；'));
    }
    return body.data;
  }
  throw new Error('Shopify API 一直忙線，請稍後再試。');
}

// 目前的授權實際拿到的權限（例如 read_orders、read_all_orders）
function shopifyAccessScopes() {
  var data = shopifyGraphql('{ currentAppInstallation { accessScopes { handle } } }', {});
  return ((data.currentAppInstallation && data.currentAppInstallation.accessScopes) || []).map(function (s) { return s.handle; });
}

function shopifyCleanName(name) {
  return String(name || '').trim().replace(/^#/, '').toUpperCase();
}

// 用單號（CA53126D 或 #CA53126D）抓一張訂單，回傳 Shopify 原始資料；找不到回傳 null
function shopifyFetchOrderRaw(name) {
  var clean = shopifyCleanName(name);
  if (!/^[A-Z0-9-]+$/.test(clean)) throw new Error('單號格式不對：' + name);
  var data = shopifyGraphql(SHOPIFY_ORDER_QUERY, { q: 'name:"#' + clean + '"' });
  var nodes = (data.orders && data.orders.nodes) || [];
  return nodes.filter(function (n) { return shopifyCleanName(n.name) === clean; })[0] || null;
}

function shopifyFetchOrder(name) {
  var raw = shopifyFetchOrderRaw(name);
  return raw ? normalizeShopifyOrder(raw, function (iso) {
    return Utilities.formatDate(new Date(iso), getSettings().TIMEZONE || 'America/Vancouver', 'yyyy-MM-dd');
  }) : null;
}

function shopifyRecentOrders(n) {
  var data = shopifyGraphql(SHOPIFY_RECENT_QUERY, { n: n || 20 });
  return ((data.orders && data.orders.nodes) || []).map(function (o) {
    return {
      name: shopifyCleanName(o.name),
      createdAt: o.createdAt,
      source: o.sourceName,
      status: String(o.displayFinancialStatus || '').toLowerCase(),
      cancelled: !!o.cancelledAt,
      shipping: ((o.shippingLines && o.shippingLines.nodes) || []).map(function (s) { return s.title; }).join(' / ')
    };
  });
}

var SHOPIFY_LIST_QUERY = 'query List($q: String!, $after: String) { orders(first: 100, after: $after, sortKey: CREATED_AT, query: $q) { nodes { name createdAt sourceName displayFinancialStatus cancelledAt test } pageInfo { hasNextPage endCursor } } }';

// 某段日期（溫哥華時間，含頭尾兩天）內「建立或有更新」的訂單，從舊到新。
// 用更新時間是為了抓到之前下單、這幾天才付清運費（INT）或改過的單
function shopifyListOrders(fromDate, toDate) {
  var tz = getSettings().TIMEZONE || 'America/Vancouver';
  var from = Utilities.parseDate(fromDate + ' 00:00:00', tz, 'yyyy-MM-dd HH:mm:ss');
  var to = Utilities.parseDate(toDate + ' 23:59:59', tz, 'yyyy-MM-dd HH:mm:ss');
  if (isNaN(from.getTime()) || isNaN(to.getTime()) || from > to) throw new Error('日期範圍不對：' + fromDate + ' ～ ' + toDate);
  if ((to - from) / 86400000 > 31) throw new Error('一次最多掃 31 天。');
  var q = "updated_at:>='" + from.toISOString() + "' created_at:<='" + to.toISOString() + "'";
  var out = [];
  var after = null;
  for (var page = 0; page < 10; page++) {
    var data = shopifyGraphql(SHOPIFY_LIST_QUERY, { q: q, after: after });
    var conn = data.orders || { nodes: [], pageInfo: {} };
    conn.nodes.forEach(function (o) {
      out.push({
        name: shopifyCleanName(o.name), createdAt: o.createdAt, source: o.sourceName,
        status: String(o.displayFinancialStatus || '').toLowerCase(), cancelled: !!o.cancelledAt, test: !!o.test
      });
    });
    if (!conn.pageInfo || !conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return out;
}

function shopifyMoney(set) {
  return set && set.shopMoney ? Number(set.shopMoney.amount) || 0 : 0;
}

// PayPal 的手續費在交易的 receipt 裡（例如 paypal_fee、fee_amount、PAYMENTINFO_0_FEEAMT）
function paypalFeeFromReceipt(receiptJson) {
  var data;
  try { data = typeof receiptJson === 'string' ? JSON.parse(receiptJson) : receiptJson; } catch (e) { return null; }
  var found = null;
  var keyRe = /^(paypal_fee|fee_amount|fee|PAYMENTINFO_\d+_FEEAMT|FEEAMT)$/i;
  (function walk(node, depth) {
    if (found || !node || typeof node !== 'object' || depth > 8) return;
    Object.keys(node).forEach(function (k) {
      if (found) return;
      var v = node[k];
      if (keyRe.test(k)) {
        var num = v && typeof v === 'object' ? Number(v.value != null ? v.value : v.amount) : Number(v);
        if (isFinite(num) && v !== '' && v !== null) { found = { fee: Math.abs(num), key: k }; return; }
      }
      if (v && typeof v === 'object') walk(v, depth + 1);
    });
  })(data, 0);
  return found;
}

function shopifyTransactionFee(tx) {
  var gateway = String(tx.gateway || '').toLowerCase();
  if (tx.fees && tx.fees.length) {
    return { fee: tx.fees.reduce(function (s, f) { return s + (Number(f.amount && f.amount.amount) || 0); }, 0), note: 'Shopify fees' };
  }
  if (/paypal/.test(gateway)) {
    var p = paypalFeeFromReceipt(tx.receiptJson);
    return p ? { fee: p.fee, note: 'PayPal receipt: ' + p.key } : { fee: null, note: 'PayPal receipt 裡找不到 fee' };
  }
  if (/cash|gift_card|manual|custom|bogus|shop_cash|store_credit/.test(gateway)) return { fee: 0, note: gateway + ' 沒有手續費' };
  return { fee: null, note: gateway + ' 還沒有手續費資料' };
}

// formatDate(iso) → 'yyyy-MM-dd'（溫哥華時間）
function normalizeShopifyOrder(node, formatDate) {
  var lines = ((node.lineItems && node.lineItems.nodes) || []).map(function (li) {
    var qty = li.currentQuantity != null ? Number(li.currentQuantity) : Number(li.quantity);
    var discount = (li.discountAllocations || []).reduce(function (s, d) { return s + shopifyMoney(d.allocatedAmountSet); }, 0);
    if (Number(li.quantity) > 0 && qty < Number(li.quantity)) discount = discount * qty / Number(li.quantity);
    return {
      name: li.name,
      qty: qty,
      unitPrice: shopifyMoney(li.originalUnitPriceSet),
      discount: Math.round(discount * 100) / 100,
      sku: li.sku || '',
      barcode: (li.variant && li.variant.barcode) || '',
      requiresShipping: li.requiresShipping !== false,
      description: (li.product && li.product.descriptionHtml) || ''
    };
  });
  var shippingNodes = (node.shippingLines && node.shippingLines.nodes) || [];
  var payments = (node.transactions || []).filter(function (tx) {
    return tx.status === 'SUCCESS' && (tx.kind === 'SALE' || tx.kind === 'CAPTURE') && !tx.test;
  }).map(function (tx) {
    var f = shopifyTransactionFee(tx);
    return { createdAt: tx.createdAt, gateway: tx.gateway, amount: shopifyMoney(tx.amountSet), fee: f.fee, feeNote: f.note };
  });
  return {
    name: shopifyCleanName(node.name),
    date: formatDate(node.createdAt),
    createdAt: node.createdAt,
    source: node.sourceName || '',
    financialStatus: String(node.displayFinancialStatus || '').toLowerCase(),
    cancelled: !!node.cancelledAt,
    test: !!node.test,
    email: node.email || '',
    country: (node.shippingAddress && node.shippingAddress.countryCodeV2) || '',
    shippingTitle: shippingNodes.map(function (s) { return s.title; }).join(' / '),
    shippingCharged: Math.round(shippingNodes.reduce(function (s, n) { return s + shopifyMoney(n.discountedPriceSet); }, 0) * 100) / 100,
    lines: lines,
    payments: payments
  };
}

if (typeof module !== 'undefined') {
  module.exports = { normalizeShopifyOrder: normalizeShopifyOrder, paypalFeeFromReceipt: paypalFeeFromReceipt, shopifyTransactionFee: shopifyTransactionFee, SHOPIFY_ORDER_QUERY: SHOPIFY_ORDER_QUERY };
}
