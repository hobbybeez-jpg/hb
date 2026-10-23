// Sale Manager backend logic.
// Scan: active products in stock, without a sale / 20off / 40off tag, and with no orders in the last 2 years.
// Campaign: the chosen products go on sale from the start date (compare-at price = price, price = 60% rounded
// up to x9.99, tags sale + 40off) and everything is put back after the end date.
//
// db interface: db.transaction(async (tx) => ...), tx.query(sql, params) resolves to rows[].
// Call: handle(db, fn, args, { code, user, client, cronSecret, shopify })
//   code       = shared staff password (header x-sale-code)
//   user       = name of the person acting (header x-sale-user)
//   client     = caller's IP address (used to lock out repeated wrong passwords)
//   cronSecret = header x-sale-cron (only the scheduled tick sends it)
//   shopify    = Shopify client from shopify.js, or null when Shopify is not configured

import {
  SALE_TAGS, BLOCKED_TAGS, SALE_PERCENT, NO_SALES_YEARS,
  ineligibleReason, planChanges, planRestore, productsCollector, ordersCollector, readJsonl
} from './rules.js';
import { productsBulkQuery, ordersBulkQuery } from './shopify.js';

// Start and end dates are whole days in the stores' time zone
export const TIME_ZONE = 'America/Vancouver';
const PASSWORD_KEYS = ['pw_access', 'pw_manager'];
const MANAGER = ['pw_manager', 'Manager'];
const MIN_PASSWORD_LENGTH = 8;
// Wrong passwords: 5 per IP or 50 in total per password within 15 minutes locks that password for the rest of the window
const LOCKOUT = { perClient: 5, total: 50, minutes: 15 };
// A product that keeps failing in Shopify is tried this many times, then waits for "Retry"
const MAX_ATTEMPTS = 5;
// A product being changed in Shopify is held for this long (a crashed request frees it after that)
const CLAIM_MINUTES = 3;
// Reading a scan's result file holds the scan for this long
const SCAN_CLAIM_MINUTES = 5;
// Time spent changing products per request: the page keeps asking while there is more; the schedule allows longer
const PAGE_BUDGET_MS = 25000;
const TICK_BUDGET_MS = 110000;
const MAX_PRODUCTS = 3000;
const RUNNING_SCAN = ['PRODUCTS', 'READ_PRODUCTS', 'ORDERS', 'READ_ORDERS'];

export class UserError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'UserError';
    this.code = code || '';
  }
}

const accessCache = new Map();

export async function handle(db, fn, args, ctx) {
  const api = API[fn];
  const shopifyAction = SHOPIFY_ACTIONS[fn];
  if (!api && !shopifyAction && fn !== 'tick') throw new UserError('Unknown action: ' + fn);
  const payload = (args && typeof args === 'object') ? args : {};
  const context = {
    code: String((ctx && ctx.code) || ''),
    user: cleanText((ctx && ctx.user) || '', 40),
    client: cleanText((ctx && ctx.client) || '', 64),
    cronSecret: String((ctx && ctx.cronSecret) || ''),
    shopify: (ctx && ctx.shopify) || null,
    now: (ctx && ctx.now) || Date.now
  };
  try {
    if (fn === 'tick') return await tick(db, context);
    if (shopifyAction) return await shopifyAction(db, payload, context);
    return await db.transaction(async (tx) => {
      await checkAccess(tx, context);
      return api(tx, payload, context);
    });
  } catch (error) {
    if (error && error.authKey) await recordFailure(db, context.client, error.authKey);
    throw error;
  }
}

// ---------- helpers ----------

function cleanText(value, max) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max || 200);
}

function wholeNumber(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new UserError(`${label} is missing.`);
  return n;
}

function dateArg(value, label) {
  const s = String(value || '');
  const d = new Date(s + 'T00:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(d) || d.toISOString().slice(0, 10) !== s) throw new UserError(`Please choose the ${label}.`);
  return s;
}

function requireUser(ctx) {
  if (!ctx.user) throw new UserError('Please enter your name first.', 'NEED_USER');
  return ctx.user;
}

function requireShopify(ctx) {
  if (!ctx.shopify) throw new UserError('Shopify is not connected yet. See Settings.');
  if (ctx.shopify.configError) throw new UserError(ctx.shopify.configError);
  return ctx.shopify;
}

function shopifyMessage(error) {
  if (error && (error.name === 'ShopifyError' || error.name === 'UserError')) return error.message;
  console.error(error);
  return 'Unexpected error (details are in the function log).';
}

async function setting(tx, key) {
  const rows = await tx.query('select value from sale.settings where key = $1', [key]);
  return rows.length ? rows[0].value : null;
}

async function checkAccess(tx, ctx) {
  const hash = await setting(tx, 'pw_access');
  if (!hash) return;
  const code = ctx.code;
  if (!code) throw new UserError('Please enter the staff password.', 'ACCESS');
  const cacheKey = hash + '|' + code;
  const cached = accessCache.get(cacheKey);
  if (cached && cached > Date.now()) return;
  await assertNotLocked(tx, ctx.client, 'pw_access');
  const rows = await tx.query('select extensions.crypt($1::text, $2::text) = $2::text as ok', [code, hash]);
  if (!rows[0].ok) throw wrongPassword('Incorrect staff password.', 'ACCESS', 'pw_access');
  if (accessCache.size > 200) accessCache.clear();
  accessCache.set(cacheKey, Date.now() + 5 * 60 * 1000);
}

async function verifyPassword(tx, ctx, [key, label], password) {
  const rows = await tx.query('select extensions.crypt($1::text, value) = value as ok from sale.settings where key = $2', [String(password || ''), key]);
  if (!rows.length) throw new UserError(`The ${label} password has not been set yet. Ask an admin to set it.`);
  if (!password) throw new UserError(`Please enter the ${label} password.`, 'PASSWORD');
  await assertNotLocked(tx, ctx.client, key);
  if (!rows[0].ok) throw wrongPassword(`Incorrect ${label} password.`, 'PASSWORD', key);
}

function wrongPassword(message, code, key) {
  return Object.assign(new UserError(message, code), { authKey: key });
}

async function assertNotLocked(tx, client, key) {
  const rows = await tx.query(
    `select count(*) filter (where client = $1) as mine, count(*) as total from sale.auth_failures
     where key = $2 and at > now() - make_interval(mins => $3::int)`,
    [client || '', key, LOCKOUT.minutes]
  );
  if (Number(rows[0].mine) >= LOCKOUT.perClient || Number(rows[0].total) >= LOCKOUT.total) {
    throw new UserError(`Too many wrong passwords. Please wait ${LOCKOUT.minutes} minutes and try again.`, 'LOCKED');
  }
}

// Runs in its own transaction: the failed request's transaction is rolled back
async function recordFailure(db, client, key) {
  try {
    await db.transaction(async (tx) => {
      await tx.query('insert into sale.auth_failures (client, key) values ($1, $2)', [client || '', key]);
      await tx.query("delete from sale.auth_failures where at < now() - interval '1 day'");
    });
  } catch (e) {
    console.error('recordFailure', e);
  }
}

async function logEvent(tx, campaignId, action, by, note) {
  await tx.query('insert into sale.events (campaign_id, action, by_name, note) values ($1, $2, $3, $4)', [campaignId, action, by || null, note || null]);
}

async function today(tx) {
  const rows = await tx.query("select to_char((now() at time zone $1)::date, 'YYYY-MM-DD') as d", [TIME_ZONE]);
  return rows[0].d;
}

// ---------- scan ----------

function scanOut(row) {
  if (!row) return null;
  return {
    id: Number(row.id), status: row.status, since: row.since, stats: row.stats || {}, error: row.error || '',
    startedBy: row.started_by || '', startedAt: row.started_at, finishedAt: row.finished_at
  };
}

const SCAN_COLUMNS = "id, status, to_char(since, 'YYYY-MM-DD') as since, stats, error, started_by, started_at, finished_at";

async function latestRunningScan(tx) {
  const rows = await tx.query(`select ${SCAN_COLUMNS}, products_op, orders_op, attempt_at,
    attempt_at < now() - make_interval(mins => $2::int) as stale
    from sale.scans where status = any(array(select json_array_elements_text($1::text::json))) order by id desc limit 1`, [JSON.stringify(RUNNING_SCAN), SCAN_CLAIM_MINUTES]);
  return rows[0] || null;
}

async function failScan(db, id, message) {
  await db.transaction((tx) => tx.query(
    "update sale.scans set status = 'ERROR', error = $2, finished_at = now(), candidates = null where id = $1", [id, message]));
}

// Moves a running scan one step forward (called by the page while it waits, and by the schedule)
async function advanceScan(db, ctx) {
  const shopify = ctx.shopify;
  if (!shopify || shopify.configError) return;
  const scan = await db.transaction((tx) => latestRunningScan(tx));
  if (!scan) return;
  try {
    if (scan.status === 'PRODUCTS' || scan.status === 'ORDERS') {
      const opId = scan.status === 'PRODUCTS' ? scan.products_op : scan.orders_op;
      if (!opId) {
        if (scan.stale) await failScan(db, scan.id, 'The scan did not start. Please try again.');
        return;
      }
      const op = await shopify.bulkOperation(opId);
      if (op.status === 'CREATED' || op.status === 'RUNNING') {
        await db.transaction((tx) => tx.query(
          "update sale.scans set stats = coalesce(stats, '{}'::jsonb) || jsonb_build_object('read', $2::int) where id = $1",
          [scan.id, Number(op.objectCount) || 0]));
        return;
      }
      if (op.status !== 'COMPLETED') {
        await failScan(db, scan.id, `Shopify could not read the ${scan.status === 'PRODUCTS' ? 'products' : 'orders'} (${op.status}${op.errorCode ? ', ' + op.errorCode : ''}).`);
        return;
      }
      const next = scan.status === 'PRODUCTS' ? 'READ_PRODUCTS' : 'READ_ORDERS';
      const claimed = await db.transaction((tx) => tx.query(
        'update sale.scans set status = $3, attempt_at = now() where id = $1 and status = $2 returning id', [scan.id, scan.status, next]));
      if (!claimed.length) return;
      if (next === 'READ_PRODUCTS') await readProducts(db, shopify, scan.id, op.url);
      else await readOrders(db, shopify, scan.id, op.url);
    } else if (scan.stale) {
      // A request that was reading the results stopped half way: start that part again
      const claimed = await db.transaction((tx) => tx.query(
        `update sale.scans set attempt_at = now() where id = $1 and status = $2
         and attempt_at < now() - make_interval(mins => $3::int) returning id`, [scan.id, scan.status, SCAN_CLAIM_MINUTES]));
      if (!claimed.length) return;
      const op = await shopify.bulkOperation(scan.status === 'READ_PRODUCTS' ? scan.products_op : scan.orders_op);
      if (scan.status === 'READ_PRODUCTS') await readProducts(db, shopify, scan.id, op.url);
      else await readOrders(db, shopify, scan.id, op.url);
    }
  } catch (error) {
    await failScan(db, scan.id, shopifyMessage(error));
  }
}

async function readProducts(db, shopify, scanId, url) {
  const collector = productsCollector();
  if (url) await readJsonl(await shopify.download(url), (o) => collector.add(o));
  const { candidates, stats } = collector.candidates();
  const rows = await db.transaction((tx) => tx.query("select to_char(since, 'YYYY-MM-DD') as since from sale.scans where id = $1", [scanId]));
  const ordersOp = await shopify.startBulkQuery(ordersBulkQuery(rows[0].since));
  await db.transaction((tx) => tx.query(
    `update sale.scans set status = 'ORDERS', orders_op = $2, candidates = $3::jsonb,
       stats = $4::jsonb, attempt_at = null where id = $1`,
    [scanId, ordersOp, JSON.stringify(candidates), JSON.stringify(stats)]));
}

async function readOrders(db, shopify, scanId, url) {
  const rows = await db.transaction((tx) => tx.query('select candidates, stats from sale.scans where id = $1', [scanId]));
  const candidates = rows[0].candidates || [];
  const collector = ordersCollector(candidates.map((p) => p.id));
  if (url) await readJsonl(await shopify.download(url), (o) => collector.add(o));
  const sold = collector.soldIds();
  const results = candidates.filter((p) => !sold.has(p.id));
  results.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.title.localeCompare(b.title));
  const stats = Object.assign({}, rows[0].stats, { orders: collector.orders, sold: sold.size, matches: results.length });
  delete stats.read;
  await db.transaction((tx) => tx.query(
    `update sale.scans set status = 'DONE', results = $2::jsonb, stats = $3::jsonb, candidates = null,
       attempt_at = null, finished_at = now() where id = $1`,
    [scanId, JSON.stringify(results), JSON.stringify(stats)]));
}

// ---------- applying and restoring products ----------

// Products waiting to go on sale whose sale is over (ended early, canceled, or never got through):
// never changed in Shopify -> CANCELED; prices may have been changed -> ON_SALE so they get put back.
async function expireUnapplied(tx) {
  await tx.query(
    `update sale.items i set
       status = case when i.changes is null then 'CANCELED' else 'ON_SALE' end,
       note = case when i.changes is null then 'The sale ended before this product was put on sale.' else i.note end,
       attempts = 0
     from sale.campaigns c
     where c.id = i.campaign_id and i.status = 'PENDING' and c.end_at <= now()
       and (i.attempt_at is null or i.attempt_at < now() - make_interval(mins => $1::int))`,
    [CLAIM_MINUTES]);
}

const DUE_ITEM = `((i.status = 'PENDING' and c.canceled_at is null and c.start_at <= now() and c.end_at > now())
  or (i.status = 'ON_SALE' and c.end_at <= now()))`;

async function claimItem(db, campaignId) {
  return db.transaction(async (tx) => {
    await expireUnapplied(tx);
    const rows = await tx.query(
      `update sale.items set attempt_at = now(), attempts = attempts + 1
       where id = (
         select i.id from sale.items i join sale.campaigns c on c.id = i.campaign_id
         where ($1::bigint is null or i.campaign_id = $1) and i.attempts < $2
           and (i.attempt_at is null or i.attempt_at < now() - make_interval(mins => $3::int))
           and ${DUE_ITEM}
         order by i.id limit 1
         for update of i skip locked)
       returning *`,
      [campaignId, MAX_ATTEMPTS, CLAIM_MINUTES]);
    return rows[0] || null;
  });
}

async function finishItem(db, id, status, note) {
  const stamp = status === 'ON_SALE' ? 'applied_at' : 'ended_at';
  await db.transaction((tx) => tx.query(
    `update sale.items set status = $2, note = $3, error = null, attempts = 0, attempt_at = null, ${stamp} = now() where id = $1`,
    [id, status, note || null]));
}

async function applyItem(db, shopify, item) {
  const live = await shopify.getProduct(item.product_id);
  if (!live) return finishItem(db, item.id, 'SKIPPED', 'Product no longer exists in Shopify.');
  let changes = item.changes;
  if (!changes) {
    const reason = ineligibleReason(live);
    if (reason) return finishItem(db, item.id, 'SKIPPED', reason);
    changes = planChanges(live.variants);
    if (!changes.length) return finishItem(db, item.id, 'SKIPPED', 'Price is too low for a sale price ending in 9.99.');
    // Saved before Shopify is changed, so a retry never mistakes the sale price for the original price
    await db.transaction((tx) => tx.query('update sale.items set changes = $2::jsonb where id = $1', [item.id, JSON.stringify(changes)]));
  }
  const ids = new Set(live.variants.map((v) => v.id));
  const apply = changes.filter((c) => ids.has(c.id));
  if (apply.length) await shopify.updateVariantPrices(item.product_id, apply.map((c) => ({ id: c.id, price: c.salePrice, compareAtPrice: c.origPrice })));
  await shopify.addTags(item.product_id, SALE_TAGS);
  const left = live.variants.length - apply.length;
  const note = left > 0 ? `${apply.length} of ${live.variants.length} variants on sale (the others are too cheap or were added later).` : '';
  await finishItem(db, item.id, 'ON_SALE', note);
}

async function restoreItem(db, shopify, item) {
  const live = await shopify.getProduct(item.product_id);
  const notes = item.note ? [item.note] : [];
  if (!live) return finishItem(db, item.id, 'ENDED', [...notes, 'Product was deleted in Shopify.'].join(' '));
  const plan = planRestore(item.changes, live.variants);
  if (plan.restore.length) await shopify.updateVariantPrices(item.product_id, plan.restore);
  await shopify.removeTags(item.product_id, SALE_TAGS);
  await finishItem(db, item.id, 'ENDED', [...notes, ...plan.notes].join(' '));
}

// Applies / restores due products until the time budget runs out. Returns how many were handled.
async function processDue(db, ctx, campaignId, budgetMs) {
  const shopify = requireShopify(ctx);
  const deadline = Date.now() + budgetMs;
  let processed = 0;
  while (Date.now() < deadline) {
    const item = await claimItem(db, campaignId);
    if (!item) break;
    try {
      if (item.status === 'PENDING') await applyItem(db, shopify, item);
      else await restoreItem(db, shopify, item);
    } catch (error) {
      // Stays claimed for CLAIM_MINUTES, then is tried again (up to MAX_ATTEMPTS)
      await db.transaction((tx) => tx.query('update sale.items set error = $2 where id = $1', [item.id, shopifyMessage(error)]));
    }
    processed += 1;
  }
  return processed;
}

async function dueCount(tx, campaignId) {
  await expireUnapplied(tx);
  const rows = await tx.query(
    `select count(*) filter (where i.attempts < $2) as due,
            count(*) filter (where i.attempts < $2 and (i.attempt_at is null or i.attempt_at < now() - make_interval(mins => $3::int))) as ready
     from sale.items i join sale.campaigns c on c.id = i.campaign_id
     where ($1::bigint is null or i.campaign_id = $1) and ${DUE_ITEM}`,
    [campaignId, MAX_ATTEMPTS, CLAIM_MINUTES]);
  return { due: Number(rows[0].due), ready: Number(rows[0].ready) };
}

// Scheduled every 10 minutes (pg_cron, only when there is something to do)
async function tick(db, ctx) {
  const ok = await db.transaction(async (tx) => {
    const secret = await setting(tx, 'cron_secret');
    if (!secret || !ctx.cronSecret || secret !== ctx.cronSecret) return false;
    await tx.query(
      `insert into sale.settings (key, value) values ('last_tick', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
       on conflict (key) do update set value = excluded.value, updated_at = now()`);
    return true;
  });
  if (!ok) throw new UserError('Not allowed.', 'ACCESS');
  if (!ctx.shopify || ctx.shopify.configError) return { processed: 0 };
  const start = Date.now();
  await advanceScan(db, ctx);
  const processed = await processDue(db, ctx, null, Math.max(10000, TICK_BUDGET_MS - (Date.now() - start)));
  return { processed };
}

// ---------- campaigns ----------

function campaignState(c, counts) {
  const open = (counts.PENDING || 0) + (counts.ON_SALE || 0);
  if (c.canceled_at) return open ? 'ENDING' : 'CANCELED';
  if (!c.started) return 'SCHEDULED';
  if (!c.ended) return counts.PENDING ? 'STARTING' : 'ON_SALE';
  return open ? 'ENDING' : 'ENDED';
}

const CAMPAIGN_COLUMNS = `c.id, c.name, to_char(c.start_date, 'YYYY-MM-DD') as start_date, to_char(c.end_date, 'YYYY-MM-DD') as end_date,
  c.start_at, c.end_at, c.created_by, c.created_at, c.canceled_at, c.canceled_by, c.ended_early_by,
  c.start_at <= now() as started, c.end_at <= now() as ended`;

async function campaignsOut(tx, where, params) {
  const rows = await tx.query(`select ${CAMPAIGN_COLUMNS} from sale.campaigns c ${where} order by c.id desc limit 200`, params);
  if (!rows.length) return [];
  const counts = await tx.query(
    `select campaign_id, status, count(*) as n, count(*) filter (where error is not null) as errors
     from sale.items where campaign_id in (select json_array_elements_text($1::text::json)::bigint) group by campaign_id, status`,
    [JSON.stringify(rows.map((r) => String(r.id)))]);
  return rows.map((c) => {
    const mine = counts.filter((r) => String(r.campaign_id) === String(c.id));
    const byStatus = {};
    let errors = 0;
    for (const r of mine) { byStatus[r.status] = Number(r.n); errors += Number(r.errors); }
    return {
      id: Number(c.id), name: c.name, startDate: c.start_date, endDate: c.end_date, startAt: c.start_at, endAt: c.end_at,
      createdBy: c.created_by || '', createdAt: c.created_at, canceledAt: c.canceled_at, canceledBy: c.canceled_by || '',
      endedEarlyBy: c.ended_early_by || '', state: campaignState(c, byStatus), counts: byStatus,
      total: Object.values(byStatus).reduce((a, b) => a + b, 0), errors
    };
  });
}

async function loadCampaign(tx, id, lock) {
  const rows = await tx.query(`select ${CAMPAIGN_COLUMNS} from sale.campaigns c where c.id = $1 ${lock ? 'for update' : ''}`, [id]);
  if (!rows.length) throw new UserError('Sale not found.');
  return rows[0];
}

// Cancel (nothing changed yet) or end now: the sale's end becomes now and the products are put back
async function stopCampaign(tx, id, ctx, password, mode) {
  const user = requireUser(ctx);
  const c = await loadCampaign(tx, id, true);
  if (c.canceled_at || c.ended) throw new UserError('This sale has already ended.');
  const applied = await tx.query("select count(*) as n from sale.items where campaign_id = $1 and (status in ('ON_SALE', 'ENDED') or changes is not null)", [id]);
  const anyApplied = Number(applied[0].n) > 0;
  if (mode === 'cancel' && anyApplied) throw new UserError('Some products are already on sale. Use "End sale now" instead.');
  if (mode === 'end' && !c.started) throw new UserError('This sale has not started yet. Use "Cancel sale" instead.');
  await verifyPassword(tx, ctx, MANAGER, password);
  if (mode === 'cancel') {
    await tx.query('update sale.campaigns set canceled_at = now(), canceled_by = $2, end_at = least(end_at, now()) where id = $1', [id, user]);
    await logEvent(tx, id, 'CANCEL', user, '');
  } else {
    await tx.query('update sale.campaigns set ended_early_by = $2, end_at = now() where id = $1', [id, user]);
    await logEvent(tx, id, 'END_NOW', user, `Planned end date was ${c.end_date}.`);
  }
  await expireUnapplied(tx);
  return API.getCampaign(tx, { id });
}

const SHOPIFY_ACTIONS = {
  async shopifyTest(db, args, ctx) {
    await db.transaction((tx) => checkAccess(tx, ctx));
    const shopify = requireShopify(ctx);
    try {
      return await shopify.testConnection();
    } catch (error) {
      throw new UserError(shopifyMessage(error));
    }
  },

  // Starts a new scan (or returns the one already running)
  async startScan(db, args, ctx) {
    const start = await db.transaction(async (tx) => {
      await checkAccess(tx, ctx);
      const user = requireUser(ctx);
      requireShopify(ctx);
      // One scan at a time
      await tx.query("select 1 from sale.settings where key = 'cron_secret' for update");
      if (await latestRunningScan(tx)) return null;
      const rows = await tx.query(
        `insert into sale.scans (status, since, started_by, attempt_at, stats)
         values ('PRODUCTS', ((now() at time zone $1)::date - make_interval(years => $2::int))::date, $3, now(), '{}'::jsonb) returning id`,
        [TIME_ZONE, NO_SALES_YEARS, user]);
      return Number(rows[0].id);
    });
    if (start) {
      try {
        const op = await ctx.shopify.startBulkQuery(productsBulkQuery());
        await db.transaction((tx) => tx.query('update sale.scans set products_op = $2, attempt_at = null where id = $1', [start, op]));
      } catch (error) {
        await failScan(db, start, shopifyMessage(error));
      }
    }
    return db.transaction((tx) => API.getScan(tx, args, ctx));
  },

  // The page asks every few seconds while a scan runs
  async scanStatus(db, args, ctx) {
    await db.transaction((tx) => checkAccess(tx, ctx));
    await advanceScan(db, ctx);
    return db.transaction((tx) => API.getScan(tx, args, ctx));
  },

  async cancelScan(db, args, ctx) {
    const scan = await db.transaction(async (tx) => {
      await checkAccess(tx, ctx);
      requireUser(ctx);
      const row = await latestRunningScan(tx);
      if (row) await tx.query("update sale.scans set status = 'CANCELED', finished_at = now(), candidates = null where id = $1", [row.id]);
      return row;
    });
    const op = scan && (scan.status === 'ORDERS' ? scan.orders_op : scan.status === 'PRODUCTS' ? scan.products_op : null);
    if (op && ctx.shopify && !ctx.shopify.configError) {
      try { await ctx.shopify.cancelBulkOperation(op); } catch (e) { console.error('cancelBulkOperation', e); }
    }
    return db.transaction((tx) => API.getScan(tx, args, ctx));
  },

  // Applies / restores this sale's products that are due now (the page calls again while `more` is true)
  async processCampaign(db, args, ctx) {
    const id = wholeNumber(args.id, 'Sale');
    await db.transaction(async (tx) => {
      await checkAccess(tx, ctx);
      requireUser(ctx);
      await loadCampaign(tx, id);
    });
    const processed = await processDue(db, ctx, id, PAGE_BUDGET_MS);
    return db.transaction(async (tx) => {
      const left = await dueCount(tx, id);
      const campaign = await API.getCampaign(tx, { id });
      return Object.assign(campaign, { processed, due: left.due, more: left.ready > 0 });
    });
  }
};

const API = {
  async ping(tx, args, ctx) {
    const rows = await tx.query('select key from sale.settings where key = any(array(select json_array_elements_text($1::text::json)))', [JSON.stringify(PASSWORD_KEYS)]);
    const tickRow = await tx.query("select value from sale.settings where key = 'last_tick'");
    const shopify = ctx.shopify
      ? { connected: !ctx.shopify.configError, store: ctx.shopify.store, error: ctx.shopify.configError || '' }
      : { connected: false, store: '', error: '' };
    return {
      ok: true, passwordsSet: rows.map((r) => r.key), shopify, lastTick: tickRow.length ? tickRow[0].value : '',
      today: await today(tx), timeZone: TIME_ZONE,
      rules: { years: NO_SALES_YEARS, percent: SALE_PERCENT, blockedTags: BLOCKED_TAGS, saleTags: SALE_TAGS }
    };
  },

  // Latest finished scan (results only when the page does not have them yet), the running one, and a newer failure
  async getScan(tx, { haveId }) {
    const done = await tx.query(
      `select ${SCAN_COLUMNS}, case when id = $1 then null else results end as results
       from sale.scans where status = 'DONE' order by id desc limit 1`, [Number(haveId) || 0]);
    const running = await latestRunningScan(tx);
    const doneId = done.length ? Number(done[0].id) : 0;
    const failed = await tx.query(`select ${SCAN_COLUMNS} from sale.scans where status = 'ERROR' and id > $1 order by id desc limit 1`, [doneId]);
    // Products already in a sale that has not ended
    const open = await tx.query(
      `select i.product_id, i.status, c.id, c.name from sale.items i join sale.campaigns c on c.id = i.campaign_id
       where i.status in ('PENDING', 'ON_SALE')`);
    const inSale = {};
    for (const r of open) inSale[r.product_id] = { campaignId: Number(r.id), name: r.name, status: r.status };
    const last = done.length ? scanOut(done[0]) : null;
    if (last && done[0].results) last.results = done[0].results;
    return { last, running: scanOut(running), failed: failed.length ? scanOut(failed[0]) : null, inSale };
  },

  async listCampaigns(tx) {
    return { campaigns: await campaignsOut(tx, '', []) };
  },

  async getCampaign(tx, { id }) {
    const cid = wholeNumber(id, 'Sale');
    const [campaign] = await campaignsOut(tx, 'where c.id = $1', [cid]);
    if (!campaign) throw new UserError('Sale not found.');
    const items = await tx.query(
      `select id, product_id, title, handle, vendor, snapshot, changes, status, note, error, attempts, applied_at, ended_at
       from sale.items where campaign_id = $1 order by title, id`, [cid]);
    const events = await tx.query('select action, by_name, note, at from sale.events where campaign_id = $1 order by at, id', [cid]);
    campaign.items = items.map((i) => ({
      id: Number(i.id), productId: i.product_id, title: i.title, handle: i.handle, vendor: i.vendor || '',
      snapshot: i.snapshot || [], changes: i.changes, status: i.status, note: i.note || '', error: i.error || '',
      stuck: !!i.error && i.attempts >= MAX_ATTEMPTS, appliedAt: i.applied_at, endedAt: i.ended_at
    }));
    campaign.events = events.map((e) => ({ action: e.action, by: e.by_name || '', note: e.note || '', at: e.at }));
    return campaign;
  },

  // Put the chosen products of a scan on sale from startDate to endDate (whole days, store time)
  async createCampaign(tx, { name, startDate, endDate, scanId, productIds, password }, ctx) {
    const user = requireUser(ctx);
    const start = dateArg(startDate, 'start date');
    const end = dateArg(endDate, 'end date');
    const now = await today(tx);
    if (start < now) throw new UserError('The start date cannot be in the past.');
    if (end < start) throw new UserError('The end date must be on or after the start date.');
    const ids = [...new Set((Array.isArray(productIds) ? productIds : []).map((v) => String(v)))];
    if (!ids.length) throw new UserError('Please select at least one product.');
    if (ids.length > MAX_PRODUCTS) throw new UserError(`At most ${MAX_PRODUCTS} products per sale.`);
    await verifyPassword(tx, ctx, MANAGER, password);

    const scan = await tx.query("select results from sale.scans where id = $1 and status = 'DONE'", [Number(scanId) || 0]);
    if (!scan.length) throw new UserError('This scan is no longer available. Please run a new scan.');
    const byId = new Map((scan[0].results || []).map((p) => [p.id, p]));
    const picked = ids.map((id) => byId.get(id));
    if (picked.some((p) => !p)) throw new UserError('Some selected products are not in this scan. Please reload the page.');
    const cheap = picked.filter((p) => !p.canDiscount);
    if (cheap.length) throw new UserError(`Price too low for a sale price ending in 9.99: ${cheap.slice(0, 5).map((p) => p.title).join(', ')}.`);

    // Serialize with other new sales, then check the products are not in another sale
    await tx.query("select 1 from sale.settings where key = 'cron_secret' for update");
    const busy = await tx.query(
      `select i.title, c.name from sale.items i join sale.campaigns c on c.id = i.campaign_id
       where i.status in ('PENDING', 'ON_SALE') and i.product_id = any(array(select json_array_elements_text($1::text::json)))
       order by i.title limit 6`, [JSON.stringify(ids)]);
    if (busy.length) {
      throw new UserError(`Already in another sale: ${busy.slice(0, 5).map((r) => `${r.title} (${r.name})`).join(', ')}${busy.length > 5 ? ', …' : ''}.`);
    }

    const title = cleanText(name, 100) || `40% off ${start}`;
    const rows = await tx.query(
      `insert into sale.campaigns (name, start_date, end_date, start_at, end_at, scan_id, created_by)
       values ($1, $2::date, $3::date, ($2::date)::timestamp at time zone $4, ($3::date + 1)::timestamp at time zone $4, $5, $6)
       returning id, start_at <= now() as started`,
      [title, start, end, TIME_ZONE, Number(scanId), user]);
    const id = Number(rows[0].id);
    const items = picked.map((p) => ({
      product_id: p.id, title: p.title, handle: p.handle, vendor: p.vendor,
      snapshot: p.variants.map((v) => ({ id: v.id, title: v.title, sku: v.sku, barcode: v.barcode, price: v.price, compareAtPrice: v.compareAtPrice, salePrice: v.salePrice, inventoryQuantity: v.inventoryQuantity }))
    }));
    await tx.query(
      `insert into sale.items (campaign_id, product_id, title, handle, vendor, snapshot)
       select $1, x.product_id, x.title, x.handle, x.vendor, x.snapshot
       from jsonb_to_recordset($2::jsonb) as x(product_id text, title text, handle text, vendor text, snapshot jsonb)`,
      [id, JSON.stringify(items)]);
    await logEvent(tx, id, 'CREATE', user, `${items.length} products, ${start} to ${end}.`);
    return { id, startsNow: !!rows[0].started };
  },

  async cancelCampaign(tx, { id, password }, ctx) {
    return stopCampaign(tx, wholeNumber(id, 'Sale'), ctx, password, 'cancel');
  },

  async endCampaignNow(tx, { id, password }, ctx) {
    return stopCampaign(tx, wholeNumber(id, 'Sale'), ctx, password, 'end');
  },

  async changeEndDate(tx, { id, endDate, password }, ctx) {
    const user = requireUser(ctx);
    const cid = wholeNumber(id, 'Sale');
    const end = dateArg(endDate, 'end date');
    const c = await loadCampaign(tx, cid, true);
    if (c.canceled_at || c.ended) throw new UserError('This sale has already ended.');
    if (end < c.start_date) throw new UserError('The end date must be on or after the start date.');
    if (end < await today(tx)) throw new UserError('The end date cannot be in the past. Use "End sale now" to end it today.');
    await verifyPassword(tx, ctx, MANAGER, password);
    await tx.query('update sale.campaigns set end_date = $2::date, end_at = ($2::date + 1)::timestamp at time zone $3 where id = $1', [cid, end, TIME_ZONE]);
    await logEvent(tx, cid, 'CHANGE_END', user, `${c.end_date} → ${end}`);
    return API.getCampaign(tx, { id: cid });
  },

  // Products that failed in Shopify MAX_ATTEMPTS times are tried again
  async retryCampaign(tx, { id }, ctx) {
    const user = requireUser(ctx);
    const cid = wholeNumber(id, 'Sale');
    await loadCampaign(tx, cid);
    const rows = await tx.query(
      "update sale.items set attempts = 0, attempt_at = null where campaign_id = $1 and error is not null and status in ('PENDING', 'ON_SALE') returning id", [cid]);
    if (rows.length) await logEvent(tx, cid, 'RETRY', user, `${rows.length} products.`);
    return API.getCampaign(tx, { id: cid });
  },

  async setPassword(tx, { key, value, password }, ctx) {
    const user = requireUser(ctx);
    if (!PASSWORD_KEYS.includes(key)) throw new UserError('Unknown password.');
    const next = String(value || '');
    if (!next && key !== 'pw_access') throw new UserError('Please enter the new password.');
    if (next && next.length < MIN_PASSWORD_LENGTH) throw new UserError(`The new password needs at least ${MIN_PASSWORD_LENGTH} characters.`);
    await verifyPassword(tx, ctx, MANAGER, password);
    if (next) {
      await tx.query(
        `insert into sale.settings (key, value) values ($1, extensions.crypt($2::text, extensions.gen_salt('bf', 8)))
         on conflict (key) do update set value = excluded.value, updated_at = now()`, [key, next]);
    } else {
      await tx.query('delete from sale.settings where key = $1', [key]);
    }
    await logEvent(tx, null, 'PASSWORD', user, key);
    accessCache.clear();
    return { ok: true };
  }
};
