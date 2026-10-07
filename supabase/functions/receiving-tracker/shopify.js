// Shopify Admin API client for the Receiving Tracker.
// Runs only in the Edge Function: the token / client secret never reaches the browser.
//
// Supabase secrets:
//   SHOPIFY_STORE              your-store.myshopify.com
//   SHOPIFY_ADMIN_TOKEN        Admin API access token (custom app created in the Shopify admin before 2026), or
//   SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET
//                              Dev Dashboard app (client credentials grant; the 24-hour token is renewed automatically)
//   SHOPIFY_FROM_LOCATION_ID   Marine Drive location ID (the number at the end of Settings > Locations > the location's URL)
//   SHOPIFY_TO_LOCATION_ID     Renfrew location ID
//   SHOPIFY_API_VERSION        optional, default 2026-07
// App access scopes: read_products, read_inventory_transfers, write_inventory_transfers,
//   read_inventory_shipments, write_inventory_shipments, write_inventory_shipments_received_items

const DEFAULT_API_VERSION = '2026-07';

export class ShopifyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ShopifyError';
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function gid(type, id) {
  const value = String(id || '').trim();
  if (value.startsWith('gid://shopify/' + type + '/')) return value;
  return /^\d+$/.test(value) ? `gid://shopify/${type}/${value}` : '';
}

export const numericId = (value) => String(value || '').replace(/^.*\//, '');

// Returns null when Shopify is not configured at all; otherwise a client
// (client.configError is set when the configuration is incomplete).
export function shopifyFromEnv(get, fetchImpl = fetch) {
  const env = (key) => String(get(key) || '').trim();
  const store = env('SHOPIFY_STORE').toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!store) return null;
  return createShopify({
    store,
    adminToken: env('SHOPIFY_ADMIN_TOKEN'),
    clientId: env('SHOPIFY_CLIENT_ID'),
    clientSecret: env('SHOPIFY_CLIENT_SECRET'),
    fromLocationId: env('SHOPIFY_FROM_LOCATION_ID'),
    toLocationId: env('SHOPIFY_TO_LOCATION_ID'),
    apiVersion: env('SHOPIFY_API_VERSION') || DEFAULT_API_VERSION
  }, fetchImpl);
}

export function createShopify(config, fetchImpl = fetch) {
  const store = config.store;
  const from = gid('Location', config.fromLocationId);
  const to = gid('Location', config.toLocationId);
  const problems = [];
  // Only ever send the token to a *.myshopify.com host
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(store)) problems.push('SHOPIFY_STORE must look like your-store.myshopify.com');
  if (!config.adminToken && !(config.clientId && config.clientSecret)) problems.push('set SHOPIFY_ADMIN_TOKEN, or SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET');
  if (!from) problems.push('SHOPIFY_FROM_LOCATION_ID is missing or not a number');
  if (!to) problems.push('SHOPIFY_TO_LOCATION_ID is missing or not a number');
  if (from && from === to) problems.push('the from and to locations are the same');
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
    if (!res.ok) throw new ShopifyError(`Shopify sign-in failed (HTTP ${res.status}). Check SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET and that the app is installed on the store.`);
    const body = await res.json();
    if (!body.access_token) throw new ShopifyError('Shopify sign-in failed: no access token returned.');
    const seconds = Number(body.expires_in) || 3600;
    cachedToken = { value: body.access_token, expires: Date.now() + Math.max(60, seconds - 300) * 1000 };
    return cachedToken.value;
  }

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
        // Mutations carry an idempotency key, so a retry after a lost response is safe
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
        if (throttled && attempt < 2) { await sleep(2000 * (attempt + 1)); continue; }
        throw new ShopifyError('Shopify: ' + body.errors.map((e) => e.message).join('; '));
      }
      return body.data;
    }
  }

  function checkUserErrors(payload, describeField) {
    const errors = (payload && payload.userErrors) || [];
    if (!errors.length) return;
    throw new ShopifyError('Shopify: ' + errors.map((e) => {
      const where = describeField ? describeField(e.field || []) : '';
      return (where ? where + ': ' : '') + e.message;
    }).join('; '));
  }

  // The idempotency key goes into the query text, so only allow UUID-shaped keys
  function idempotent(key) {
    if (!/^[0-9a-f-]{36}$/.test(key)) throw new Error('Invalid idempotency key');
    return `@idempotent(key: "${key}")`;
  }

  return {
    store,
    configError,
    fromLocationId: from,
    toLocationId: to,
    graphql,

    transferUrl(transferId) {
      return transferId ? `https://${store}/admin/transfers/${numericId(transferId)}` : '';
    },

    // UPCs -> variants with that barcode (leading zeros ignored). Returns { [upc]: [variant, ...] }
    async variantsByBarcode(upcs) {
      const strip = (v) => String(v || '').replace(/^0+/, '');
      const wanted = [...new Set(upcs.map(strip).filter((v) => /^[0-9A-Za-z-]+$/.test(v)))];
      const found = {};
      for (let i = 0; i < wanted.length; i += 10) {
        const chunk = wanted.slice(i, i + 10);
        // Barcodes may be saved with leading zeros (UPC-A 12 / EAN-13 / GTIN-14 digits)
        const terms = new Set();
        for (const v of chunk) {
          terms.add(v);
          for (const len of [12, 13, 14]) if (len > v.length) terms.add(v.padStart(len, '0'));
        }
        const search = [...terms].map((t) => `barcode:${t}`).join(' OR ');
        let after = null;
        do {
          const data = await graphql(
            `query TrkVariantsByBarcode($q: String!, $after: String) {
              productVariants(first: 100, query: $q, after: $after) {
                nodes { id barcode displayName inventoryItem { id tracked } }
                pageInfo { hasNextPage endCursor }
              }
            }`,
            { q: search, after }
          );
          const page = data.productVariants;
          for (const v of page.nodes) {
            const key = strip(v.barcode);
            if (!chunk.includes(key)) continue;
            (found[key] = found[key] || []).push({ id: v.id, barcode: v.barcode, name: v.displayName, inventoryItemId: v.inventoryItem && v.inventoryItem.id, tracked: !!(v.inventoryItem && v.inventoryItem.tracked) });
          }
          after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
        } while (after);
      }
      const out = {};
      for (const upc of upcs) out[upc] = found[strip(upc)] || [];
      return out;
    },

    async getTransfer(transferId) {
      const data = await graphql(
        `query TrkTransfer($id: ID!) {
          inventoryTransfer(id: $id) { id name status tags shipments(first: 5) { nodes { id name status } } }
        }`,
        { id: transferId }
      );
      return data.inventoryTransfer ? transferOut(data.inventoryTransfer) : null;
    },

    // A transfer this app created earlier (found by its unique tag), unless it was canceled
    async findTransferByTag(tag) {
      const data = await graphql(
        `query TrkTransferByTag($q: String!) {
          inventoryTransfers(first: 5, query: $q) {
            nodes { id name status tags shipments(first: 5) { nodes { id name status } } }
          }
        }`,
        { q: `tag:${tag}` }
      );
      const match = data.inventoryTransfers.nodes.find((t) => t.status !== 'CANCELED' && (t.tags || []).includes(tag));
      return match ? transferOut(match) : null;
    },

    // items: [{ inventoryItemId, qty, label }]
    async createTransfer({ items, referenceName, note, tag, key }) {
      const data = await graphql(
        `mutation TrkTransferCreate($input: InventoryTransferCreateAsReadyToShipInput!) {
          inventoryTransferCreateAsReadyToShip(input: $input) ${idempotent(key)} {
            inventoryTransfer { id name status tags shipments(first: 5) { nodes { id name status } } }
            userErrors { field message code }
          }
        }`,
        {
          input: {
            originLocationId: from,
            destinationLocationId: to,
            lineItems: items.map((i) => ({ inventoryItemId: i.inventoryItemId, quantity: i.qty })),
            referenceName,
            note,
            tags: [tag]
          }
        }
      );
      const payload = data.inventoryTransferCreateAsReadyToShip;
      checkUserErrors(payload, (field) => lineLabel(field, items));
      if (!payload.inventoryTransfer) throw new ShopifyError('Shopify did not return the new transfer.');
      return transferOut(payload.inventoryTransfer);
    },

    // Mark the transfer as shipped: one in-transit shipment with every item
    async createInTransitShipment({ transferId, items, key }) {
      const data = await graphql(
        `mutation TrkShipmentCreate($input: InventoryShipmentCreateInput!) {
          inventoryShipmentCreateInTransit(input: $input) ${idempotent(key)} {
            inventoryShipment { id name status }
            userErrors { field message code }
          }
        }`,
        { input: { movementId: transferId, lineItems: items.map((i) => ({ inventoryItemId: i.inventoryItemId, quantity: i.qty })) } }
      );
      const payload = data.inventoryShipmentCreateInTransit;
      checkUserErrors(payload, (field) => lineLabel(field, items));
      if (!payload.inventoryShipment) throw new ShopifyError('Shopify did not return the new shipment.');
      return payload.inventoryShipment;
    },

    async getShipment(shipmentId) {
      let after = null;
      let shipment = null;
      const lines = [];
      do {
        const data = await graphql(
          `query TrkShipment($id: ID!, $after: String) {
            inventoryShipment(id: $id) {
              id name status
              lineItems(first: 250, after: $after) {
                nodes { id quantity acceptedQuantity rejectedQuantity unreceivedQuantity inventoryItem { id } }
                pageInfo { hasNextPage endCursor }
              }
            }
          }`,
          { id: shipmentId, after }
        );
        if (!data.inventoryShipment) throw new ShopifyError('The Shopify shipment was not found. Was the transfer deleted in Shopify?');
        shipment = data.inventoryShipment;
        for (const l of shipment.lineItems.nodes) {
          lines.push({
            id: l.id, inventoryItemId: l.inventoryItem && l.inventoryItem.id, quantity: l.quantity,
            accepted: l.acceptedQuantity, rejected: l.rejectedQuantity, unreceived: l.unreceivedQuantity
          });
        }
        after = shipment.lineItems.pageInfo.hasNextPage ? shipment.lineItems.pageInfo.endCursor : null;
      } while (after);
      return { id: shipment.id, name: shipment.name, status: shipment.status, lines };
    },

    // items: [{ shipmentLineItemId, qty }]
    async receive({ shipmentId, items, key }) {
      const data = await graphql(
        `mutation TrkShipmentReceive($id: ID!, $lineItems: [InventoryShipmentReceiveItemInput!]) {
          inventoryShipmentReceive(id: $id, lineItems: $lineItems) ${idempotent(key)} {
            inventoryShipment { id status totalAcceptedQuantity }
            userErrors { field message code }
          }
        }`,
        { id: shipmentId, lineItems: items.map((i) => ({ shipmentLineItemId: i.shipmentLineItemId, quantity: i.qty, reason: 'ACCEPTED' })) }
      );
      const payload = data.inventoryShipmentReceive;
      checkUserErrors(payload);
      return payload.inventoryShipment;
    }
  };
}

function transferOut(t) {
  return { id: t.id, name: t.name, status: t.status, tags: t.tags || [], shipments: (t.shipments && t.shipments.nodes) || [] };
}

// userErrors field paths like ["input", "lineItems", "2", "inventoryItemId"] -> the item's name
function lineLabel(field, items) {
  const i = field.indexOf('lineItems');
  const item = i >= 0 ? items[Number(field[i + 1])] : null;
  return item ? item.label : '';
}
