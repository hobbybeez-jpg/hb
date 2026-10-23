// Shopify Admin API client for the Sale Manager.
// Runs only in the Edge Function: the token / client secret never reaches the browser.
//
// Uses its own Shopify app (the Receiving Tracker's app deliberately cannot change products or read orders).
// Supabase secrets:
//   SALE_SHOPIFY_STORE          your-store.myshopify.com (optional when SHOPIFY_STORE is already set)
//   SALE_SHOPIFY_ADMIN_TOKEN    Admin API access token (custom app created in the Shopify admin), or
//   SALE_SHOPIFY_CLIENT_ID + SALE_SHOPIFY_CLIENT_SECRET
//                               Dev Dashboard app (client credentials grant; the 24-hour token is renewed automatically)
//   SHOPIFY_API_VERSION         optional, default 2026-07
// App access scopes: read_products, write_products, read_inventory, read_orders, read_all_orders

const DEFAULT_API_VERSION = '2026-07';

export class ShopifyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ShopifyError';
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const numericId = (value) => String(value || '').replace(/^.*\//, '');

// Returns null when Shopify is not configured at all; otherwise a client
// (client.configError is set when the configuration is incomplete).
export function shopifyFromEnv(get, fetchImpl = fetch) {
  const env = (key) => String(get(key) || '').trim();
  const store = (env('SALE_SHOPIFY_STORE') || env('SHOPIFY_STORE')).toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const adminToken = env('SALE_SHOPIFY_ADMIN_TOKEN');
  const clientId = env('SALE_SHOPIFY_CLIENT_ID');
  const clientSecret = env('SALE_SHOPIFY_CLIENT_SECRET');
  if (!store && !adminToken && !clientId) return null;
  return createShopify({ store, adminToken, clientId, clientSecret, apiVersion: env('SHOPIFY_API_VERSION') || DEFAULT_API_VERSION }, fetchImpl);
}

export function createShopify(config, fetchImpl = fetch) {
  const store = config.store;
  const problems = [];
  // Only ever send the token to a *.myshopify.com host
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(store)) problems.push('SALE_SHOPIFY_STORE (or SHOPIFY_STORE) must look like your-store.myshopify.com');
  if (!config.adminToken && !(config.clientId && config.clientSecret)) problems.push('set SALE_SHOPIFY_ADMIN_TOKEN, or SALE_SHOPIFY_CLIENT_ID and SALE_SHOPIFY_CLIENT_SECRET');
  if (!/^(\d{4}-\d{2}|unstable)$/.test(config.apiVersion)) problems.push('SHOPIFY_API_VERSION must look like 2026-07');
  const configError = problems.length ? 'Shopify is not set up correctly: ' + problems.join('; ') + '.' : '';

  let cachedToken = null;
  async function accessToken(renew) {
    if (config.adminToken) return config.adminToken;
    if (!renew && cachedToken && cachedToken.expires > Date.now()) return cachedToken.value;
    const res = await fetchImpl(`https://${store}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: config.clientId, client_secret: config.clientSecret }).toString(),
      signal: AbortSignal.timeout(20000)
    });
    if (!res.ok) throw new ShopifyError(`Shopify sign-in failed (HTTP ${res.status}). Check SALE_SHOPIFY_CLIENT_ID / SALE_SHOPIFY_CLIENT_SECRET and that the app is installed on the store.`);
    const body = await res.json();
    if (!body.access_token) throw new ShopifyError('Shopify sign-in failed: no access token returned.');
    const seconds = Number(body.expires_in) || 3600;
    cachedToken = { value: body.access_token, expires: Date.now() + Math.max(60, seconds - 300) * 1000 };
    return cachedToken.value;
  }

  // Every mutation here sets absolute values (prices, tags), so repeating one after a lost response is safe
  async function graphql(query, variables) {
    if (configError) throw new ShopifyError(configError);
    let renew = false;
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetchImpl(`https://${store}/admin/api/${config.apiVersion}/graphql.json`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Shopify-Access-Token': await accessToken(renew) },
          body: JSON.stringify({ query, variables: variables || {} }),
          signal: AbortSignal.timeout(25000)
        });
      } catch (e) {
        if (e instanceof ShopifyError) throw e;
        if (attempt < 2) { await sleep(1500 * (attempt + 1)); continue; }
        throw new ShopifyError('Could not reach Shopify. Please try again.');
      }
      renew = false;
      if (res.status === 401 && !config.adminToken && attempt === 0) { renew = true; continue; }  // expired token: renew once
      if ((res.status === 429 || res.status >= 500) && attempt < 2) { await sleep(2000 * (attempt + 1)); continue; }
      if (res.status === 401 || res.status === 403) {
        throw new ShopifyError(`Shopify refused the request (HTTP ${res.status}). Check the app's access token and access scopes.`);
      }
      if (!res.ok) throw new ShopifyError(`Shopify returned HTTP ${res.status}.`);
      const body = await res.json();
      if (body.errors && body.errors.length) {
        const throttled = body.errors.some((e) => e && e.extensions && e.extensions.code === 'THROTTLED');
        if (throttled && attempt < 3) { await sleep(2000 * (attempt + 1)); continue; }
        throw new ShopifyError('Shopify: ' + body.errors.map((e) => e.message).join('; '));
      }
      return body.data;
    }
  }

  function checkUserErrors(payload) {
    const errors = (payload && payload.userErrors) || [];
    if (errors.length) throw new ShopifyError('Shopify: ' + errors.map((e) => e.message).join('; '));
  }

  return {
    store,
    configError,
    graphql,

    productUrl(productId) {
      return `https://${store}/admin/products/${numericId(productId)}`;
    },

    // Read-only check: sign-in works and the app can read products and orders. Changes nothing.
    async testConnection() {
      const data = await graphql(
        `query SaleCheck {
          shop { name myshopifyDomain }
          products(first: 1) { nodes { id } }
          orders(first: 1, sortKey: CREATED_AT) { nodes { id createdAt } }
        }`
      );
      return { shopName: data.shop.name, domain: data.shop.myshopifyDomain };
    },

    // Starts a bulk query; returns the bulk operation ID
    async startBulkQuery(query) {
      const data = await graphql(
        `mutation SaleBulkRun($query: String!) {
          bulkOperationRunQuery(query: $query) {
            bulkOperation { id status }
            userErrors { field message }
          }
        }`,
        { query }
      );
      const payload = data.bulkOperationRunQuery;
      checkUserErrors(payload);
      if (!payload.bulkOperation) throw new ShopifyError('Shopify did not start the bulk operation.');
      return payload.bulkOperation.id;
    },

    // { id, status, errorCode, objectCount, url } (url is null when there are no results)
    async bulkOperation(id) {
      const data = await graphql(
        `query SaleBulkStatus($id: ID!) {
          node(id: $id) { ... on BulkOperation { id status errorCode objectCount url } }
        }`,
        { id }
      );
      if (!data.node) throw new ShopifyError('The Shopify bulk operation was not found.');
      return data.node;
    },

    async cancelBulkOperation(id) {
      const data = await graphql(
        `mutation SaleBulkCancel($id: ID!) {
          bulkOperationCancel(id: $id) { bulkOperation { id status } userErrors { field message } }
        }`,
        { id }
      );
      checkUserErrors(data.bulkOperationCancel);
    },

    // Streams the result file (a signed storage URL: the Shopify token is not sent there)
    async download(url) {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(120000) });
      if (!res.ok || !res.body) throw new ShopifyError(`Could not download the Shopify results (HTTP ${res.status}).`);
      return res.body;
    },

    // The product as it is now, or null when it was deleted
    async getProduct(productId) {
      const data = await graphql(
        `query SaleProduct($id: ID!) {
          product(id: $id) {
            id title status tags totalInventory
            variants(first: 250) { nodes { id title sku barcode price compareAtPrice inventoryQuantity } }
          }
        }`,
        { id: productId }
      );
      const p = data.product;
      return p ? { ...p, variants: p.variants.nodes } : null;
    },

    // variants: [{ id, price, compareAtPrice }] (compareAtPrice null clears it)
    async updateVariantPrices(productId, variants) {
      const data = await graphql(
        `mutation SaleVariantPrices($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) {
            productVariants { id price compareAtPrice }
            userErrors { field message }
          }
        }`,
        { productId, variants }
      );
      checkUserErrors(data.productVariantsBulkUpdate);
    },

    async addTags(id, tags) {
      const data = await graphql(
        `mutation SaleTagsAdd($id: ID!, $tags: [String!]!) {
          tagsAdd(id: $id, tags: $tags) { node { id } userErrors { field message } }
        }`,
        { id, tags }
      );
      checkUserErrors(data.tagsAdd);
    },

    async removeTags(id, tags) {
      const data = await graphql(
        `mutation SaleTagsRemove($id: ID!, $tags: [String!]!) {
          tagsRemove(id: $id, tags: $tags) { node { id } userErrors { field message } }
        }`,
        { id, tags }
      );
      checkUserErrors(data.tagsRemove);
    }
  };
}

// Bulk queries for the scan. Only active products; child connections use edges/node as bulk operations require.
export function productsBulkQuery() {
  return `{
    products(query: "status:active") {
      edges { node {
        id title handle status vendor productType createdAt tags totalInventory
        variants { edges { node { id title sku barcode price compareAtPrice inventoryQuantity } } }
      } }
    }
  }`;
}

// since: 'YYYY-MM-DD' (validated by the caller)
export function ordersBulkQuery(since) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new Error('Invalid date');
  return `{
    orders(query: "created_at:>=${since}") {
      edges { node {
        id cancelledAt
        lineItems { edges { node { product { id } } } }
      } }
    }
  }`;
}
