// 進貨進度追蹤（Receiving Tracker）後端邏輯。
// 只讀取庫存系統的 wh.*，所有寫入都在 trk.*。
//
// db 介面：db.transaction(async (tx) => ...)，tx.query(sql, params) 回傳 rows[]。
// 呼叫：handle(db, fn, args, { code, user })
//   code = 員工共用密碼（header x-trk-code）
//   user = 操作人員名字（header x-trk-user）

export const STEPS = ['2', '3', '4a', '4b', '5'];
export const STEP_LABELS = {
  '1': '匯入點貨單',
  '2': '數量已確認',
  '3': '確認入庫存',
  '4a': '上架系統',
  '4b': 'Renfrew 清點',
  '5': '上架店內'
};
const STEP_COL = { '2': 's2', '3': 's3', '4a': 's4a', '4b': 's4b', '5': 's5' };
const PENDING = 'PENDING';
const PASSWORD_KEYS = ['pw_access', 'pw_step3', 'pw_step4a', 'pw_admin'];
const REMOVE_REASONS = { TO_STORE: '上架店內', SOLD: '售出', DAMAGED: '損壞', ADJUST: '數量調整', OTHER: '其他' };

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
  if (!api) throw new UserError('未知的操作：' + fn);
  const payload = (args && typeof args === 'object') ? args : {};
  const context = { code: String((ctx && ctx.code) || ''), user: cleanText((ctx && ctx.user) || '', 40) };
  return db.transaction(async (tx) => {
    await checkAccess(tx, context.code);
    return api(tx, payload, context);
  });
}

// ---------- helpers ----------

function cleanText(value, max) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max || 200);
}

function cleanUpc(value) {
  return String(value == null ? '' : value).replace(/\s+/g, '').slice(0, 40);
}

function wholeNumber(value, label, { min = 0 } = {}) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) throw new UserError(`${label}必須是 ${min} 以上的整數。`);
  return n;
}

function requireUser(ctx) {
  if (!ctx.user) throw new UserError('請先輸入你的名字。', 'NEED_USER');
  return ctx.user;
}

async function setting(tx, key) {
  const rows = await tx.query('select value from trk.settings where key = $1', [key]);
  return rows.length ? rows[0].value : null;
}

async function checkAccess(tx, code) {
  const hash = await setting(tx, 'pw_access');
  if (!hash) return;
  if (!code) throw new UserError('請輸入員工密碼。', 'ACCESS');
  const cacheKey = hash + '|' + code;
  const cached = accessCache.get(cacheKey);
  if (cached && cached > Date.now()) return;
  const rows = await tx.query('select extensions.crypt($1::text, $2::text) = $2::text as ok', [code, hash]);
  if (!rows[0].ok) throw new UserError('員工密碼不正確。', 'ACCESS');
  if (accessCache.size > 200) accessCache.clear();
  accessCache.set(cacheKey, Date.now() + 5 * 60 * 1000);
}

// 任一 key 的密碼符合即通過
async function verifyPassword(tx, keys, password, label) {
  const rows = await tx.query(
    `select key, extensions.crypt($1::text, value) = value as ok from trk.settings
     where key = any(array(select json_array_elements_text($2::text::json)))`,
    [String(password || ''), JSON.stringify(keys)]
  );
  if (!rows.length) throw new UserError(`${label}密碼尚未設定，請管理員先設定。`);
  if (!password) throw new UserError(`請輸入${label}密碼。`, 'PASSWORD');
  if (!rows.some((r) => r.ok)) throw new UserError(`${label}密碼不正確。`, 'PASSWORD');
}

async function adminKeys(tx) {
  return (await setting(tx, 'pw_admin')) ? ['pw_admin'] : ['pw_step3', 'pw_step4a'];
}

async function whExists(tx) {
  const rows = await tx.query("select to_regclass('wh.shipments') is not null as ok");
  return rows[0].ok;
}

// 把 go_live 之後在庫存系統建立的點貨單加入追蹤
async function syncShipments(tx) {
  if (!(await whExists(tx))) return;
  await tx.query(
    `insert into trk.shipments (shipment_id, supplier, name, created_at)
     select s.shipment_id, s.supplier, s.name, s.created_at from wh.shipments s
     where s.shipment_id is not null
       and s.created_at >= coalesce((select value::timestamptz from trk.settings where key = 'go_live'), now())
     on conflict (shipment_id) do nothing`
  );
}

const SHIPMENT_COLUMNS = `
  t.shipment_id, coalesce(s.supplier, t.supplier) as supplier, coalesce(s.name, t.name) as name,
  coalesce(s.created_at, t.created_at) as created_at, s.status as wh_status, s.finalized_at as wh_finalized_at,
  (s.shipment_id is null) as wh_missing,
  t.s2_at, t.s2_by, t.s3_at, t.s3_by, t.s4a_at, t.s4a_by, t.s4b_at, t.s4b_by, t.s4b_note, t.s5_at, t.s5_by, t.s5_note`;

function shipmentOut(row) {
  const steps = { '1': { at: row.created_at, by: '' } };
  for (const step of STEPS) {
    const col = STEP_COL[step];
    steps[step] = row[col + '_at'] ? { at: row[col + '_at'], by: row[col + '_by'] || '' } : null;
  }
  return {
    shipmentId: row.shipment_id,
    supplier: row.supplier || '',
    name: row.name || '',
    createdAt: row.created_at,
    whStatus: row.wh_status || (row.wh_missing ? 'MISSING' : ''),
    whFinalizedAt: row.wh_finalized_at || null,
    steps,
    s4bNote: row.s4b_note || '',
    s5Note: row.s5_note || '',
    nextSteps: nextSteps(steps),
    done: !!row.s5_at
  };
}

// 流程：1 → 2 → [3 → 4a] 與 [4b] 兩條平行支線 → 5
export const PREREQ = { '2': [], '3': ['2'], '4a': ['3'], '4b': ['2'], '5': ['4a', '4b'] };
const LATER = { '2': ['3', '4b'], '3': ['4a'], '4a': ['5'], '4b': ['5'], '5': [] };

export function nextSteps(steps) {
  return STEPS.filter((k) => !steps[k] && PREREQ[k].every((p) => steps[p]));
}

async function loadShipmentRow(tx, shipmentId) {
  const wh = await whExists(tx);
  const rows = await tx.query(
    `select ${SHIPMENT_COLUMNS} from trk.shipments t
     ${whJoin(wh)} where t.shipment_id = $1`,
    [shipmentId]
  );
  if (!rows.length) throw new UserError('找不到這張進貨表：' + shipmentId);
  return rows[0];
}

function whJoin(wh) {
  return wh
    ? 'left join wh.shipments s on s.shipment_id = t.shipment_id'
    : 'left join (select null::text as shipment_id, null::text as supplier, null::text as name, null::timestamptz as created_at, null::text as status, null::timestamptz as finalized_at) s on false';
}

// 點貨單明細（含 PO / MARINE / RENFREW 分配）
async function loadLines(tx, shipmentId) {
  if (!(await whExists(tx))) return [];
  const query = (lineTable, allocTable) => tx.query(
    `select l.line_id, p.product_name, p.upc, coalesce(l.expected_qty, 0) as expected_qty,
            coalesce(l.received_qty, 0) as received_qty, coalesce(l.required_po_qty, 0) as required_po_qty,
            coalesce(l.required_renfrew_qty, 0) as required_renfrew_qty, l.status,
            coalesce(a.po_qty, 0) as po_alloc, coalesce(a.marine_qty, 0) as marine_alloc,
            coalesce(a.renfrew_qty, 0) as renfrew_alloc, coalesce(a.ng_qty, 0) as ng_alloc, a.orders
     from ${lineTable} l
     left join wh.products p on p.product_id = l.product_id
     left join lateral (
       select sum(x.qty) filter (where x.type = 'PO'
                                  or (x.type = 'OUTBOUND' and x.location_code = 'PICKED' and coalesce(x.reference_id, '') <> '')) as po_qty,
              sum(x.qty) filter (where x.type = 'MARINE') as marine_qty,
              sum(x.qty) filter (where x.type = 'RENFREW') as renfrew_qty,
              sum(x.qty) filter (where x.type = 'NG') as ng_qty,
              string_agg(distinct nullif(x.order_number, ''), ', ') filter (where x.type = 'PO' and x.qty > 0) as orders
       from ${allocTable} x where x.shipment_line_id = l.line_id
     ) a on true
     where l.shipment_id = $1
     order by l._rid`,
    [shipmentId]
  );
  let rows = await query('wh.shipment_lines', 'wh.allocations');
  if (!rows.length) rows = await query('wh.shipment_lines_archive', 'wh.allocations_archive');
  return rows.map((r) => {
    const expected = Number(r.expected_qty);
    const po = Number(r.required_po_qty);
    const renfrew = Number(r.required_renfrew_qty);
    const renfrewAlloc = Number(r.renfrew_alloc);
    return {
      lineId: r.line_id,
      productName: r.product_name || '',
      upc: r.upc || '',
      expectedQty: expected,
      receivedQty: Number(r.received_qty),
      status: r.status || '',
      po: { plan: po, allocated: Number(r.po_alloc), orders: r.orders || '' },
      marine: { plan: Math.max(0, expected - po - renfrew), allocated: Number(r.marine_alloc) },
      renfrew: { plan: renfrew, allocated: renfrewAlloc },
      ngQty: Number(r.ng_alloc),
      // Renfrew 應到數量：計畫與實際分配取較大者
      renfrewQty: Math.max(renfrew, renfrewAlloc)
    };
  });
}

async function logEvent(tx, shipmentId, step, action, user, note) {
  await tx.query(
    'insert into trk.events (shipment_id, step, action, by_name, note) values ($1, $2, $3, $4, $5)',
    [shipmentId, step, action, user, note || null]
  );
}

async function logMove(tx, m) {
  await tx.query(
    `insert into trk.renfrew_moves (upc, product_name, shipment_id, from_code, to_code, qty, reason, by_name)
     values ($1, $2, $3, $4, $5, $6::int, $7, $8)`,
    [m.upc, m.productName || '', m.shipmentId || '', m.from || null, m.to || null, m.qty, m.reason, m.user]
  );
}

async function addStock(tx, { locationCode, upc, productName, shipmentId, qty }) {
  await tx.query(
    `insert into trk.renfrew_stock (location_code, upc, product_name, shipment_id, qty)
     values ($1, $2, $3, $4, $5::int)
     on conflict (location_code, upc, shipment_id)
     do update set qty = trk.renfrew_stock.qty + excluded.qty,
                   product_name = coalesce(nullif(excluded.product_name, ''), trk.renfrew_stock.product_name),
                   updated_at = now()`,
    [locationCode, upc, productName || '', shipmentId || '', qty]
  );
}

async function takeStock(tx, stockId, qty) {
  const rows = await tx.query('select * from trk.renfrew_stock where id = $1::bigint for update', [stockId]);
  if (!rows.length) throw new UserError('找不到這筆庫存，可能已被其他人移動，請重新整理。');
  const row = rows[0];
  if (Number(row.qty) < qty) throw new UserError(`數量不足：${row.location_code} 只有 ${row.qty} 件。`);
  if (Number(row.qty) === qty) await tx.query('delete from trk.renfrew_stock where id = $1::bigint', [stockId]);
  else await tx.query('update trk.renfrew_stock set qty = qty - $2::int, updated_at = now() where id = $1::bigint', [stockId, qty]);
  return row;
}

async function requireLocation(tx, code) {
  const rows = await tx.query('select * from trk.renfrew_locations where code = $1 and active', [cleanText(code, 20).toUpperCase()]);
  if (!rows.length) throw new UserError('找不到貨架位置：' + code);
  return rows[0];
}

async function shipmentLabels(tx, ids) {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return {};
  const wh = await whExists(tx);
  const rows = await tx.query(
    `select t.shipment_id, coalesce(s.supplier, t.supplier) as supplier, coalesce(s.name, t.name) as name,
            t.s4a_at, t.s5_at
     from trk.shipments t ${whJoin(wh)} where t.shipment_id = any(array(select json_array_elements_text($1::text::json)))`,
    [JSON.stringify(list)]
  );
  const out = {};
  for (const r of rows) out[r.shipment_id] = { supplier: r.supplier || '', name: r.name || '', step4a: !!r.s4a_at, done: !!r.s5_at };
  return out;
}

function stockOut(row, labels) {
  const label = labels[row.shipment_id] || null;
  return {
    id: String(row.id),
    locationCode: row.location_code,
    upc: row.upc,
    productName: row.product_name || '',
    shipmentId: row.shipment_id || '',
    shipment: label,
    qty: Number(row.qty),
    updatedAt: row.updated_at
  };
}

async function productName(tx, upc) {
  if (await whExists(tx)) {
    const rows = await tx.query(
      `select product_name from wh.products where ltrim(upc, '0') = ltrim($1, '0') and upc <> '' limit 1`, [upc]
    );
    if (rows.length && rows[0].product_name) return rows[0].product_name;
  }
  const local = await tx.query(
    `select product_name from trk.renfrew_stock where ltrim(upc, '0') = ltrim($1, '0') and coalesce(product_name, '') <> ''
     union all
     select product_name from trk.renfrew_checks where ltrim(upc, '0') = ltrim($1, '0') and coalesce(product_name, '') <> ''
     limit 1`, [upc]
  );
  return local.length ? local[0].product_name : '';
}

// ---------- API ----------

const API = {
  async ping(tx) {
    const rows = await tx.query('select key from trk.settings where key = any(array(select json_array_elements_text($1::text::json)))', [JSON.stringify(PASSWORD_KEYS)]);
    return { ok: true, passwordsSet: rows.map((r) => r.key) };
  },

  async listShipments(tx, { filter = 'open' }) {
    await syncShipments(tx);
    const wh = await whExists(tx);
    const where = filter === 'done' ? 't.s5_at is not null' : filter === 'all' ? 'true' : 't.s5_at is null';
    const rows = await tx.query(
      `select ${SHIPMENT_COLUMNS}, coalesce(agg.line_count, 0) as line_count,
              coalesce(agg.expected_units, 0) as expected_units, coalesce(agg.received_units, 0) as received_units,
              coalesce(agg.renfrew_units, 0) as renfrew_units
       from trk.shipments t ${whJoin(wh)}
       left join lateral (
         ${wh ? `select count(*) as line_count, sum(expected_qty) as expected_units, sum(received_qty) as received_units,
                 sum(required_renfrew_qty) as renfrew_units
          from wh.shipment_lines l where l.shipment_id = t.shipment_id`
              : 'select 0 as line_count, 0 as expected_units, 0 as received_units, 0 as renfrew_units'}
       ) agg on true
       where ${where}
       order by t.s5_at desc nulls first, coalesce(s.created_at, t.created_at) desc
       limit 300`
    );
    return rows.map((r) => Object.assign(shipmentOut(r), {
      lineCount: Number(r.line_count),
      expectedUnits: Number(r.expected_units),
      receivedUnits: Number(r.received_units),
      renfrewUnits: Number(r.renfrew_units)
    }));
  },

  async getShipment(tx, { shipmentId }) {
    const row = await loadShipmentRow(tx, cleanText(shipmentId, 300));
    const shipment = shipmentOut(row);
    const lines = await loadLines(tx, shipment.shipmentId);
    const events = await tx.query(
      'select step, action, by_name, note, at from trk.events where shipment_id = $1 order by at desc, id desc limit 100',
      [shipment.shipmentId]
    );
    const checks = await tx.query(
      'select * from trk.renfrew_checks where shipment_id = $1 order by upc, line_id', [shipment.shipmentId]
    );
    const stock = await tx.query(
      `select st.* from trk.renfrew_stock st join trk.renfrew_locations loc on loc.code = st.location_code
       where st.shipment_id = $1 order by loc.sort, st.location_code, st.product_name`, [shipment.shipmentId]
    );
    const labels = await shipmentLabels(tx, [shipment.shipmentId]);
    return {
      shipment,
      lines,
      events: events.map((e) => ({ step: e.step, action: e.action, by: e.by_name || '', note: e.note || '', at: e.at })),
      checks: checks.map((c) => ({
        lineId: c.line_id, upc: c.upc || '', productName: c.product_name || '',
        expectedQty: Number(c.expected_qty), countedQty: Number(c.counted_qty), putQty: Number(c.put_qty)
      })),
      stock: stock.map((r) => stockOut(r, labels))
    };
  },

  async completeStep(tx, { shipmentId, step, password, note, counts, force }, ctx) {
    const user = requireUser(ctx);
    step = String(step || '');
    if (!STEP_COL[step]) throw new UserError('無效的步驟：' + step);
    const id = cleanText(shipmentId, 300);
    await tx.query('select 1 from trk.shipments where shipment_id = $1 for update', [id]);
    const row = await loadShipmentRow(tx, id);
    const shipment = shipmentOut(row);
    if (shipment.steps[step]) {
      throw new UserError(`步驟 ${step}「${STEP_LABELS[step]}」已經由 ${shipment.steps[step].by} 完成了。`);
    }
    const missing = PREREQ[step].filter((p) => !shipment.steps[p]);
    if (missing.length) {
      const need = missing.map((s) => `${s}「${STEP_LABELS[s]}」`).join('、');
      throw new UserError(`還不能進行步驟 ${step}，請先完成：${need}。`);
    }
    note = cleanText(note, 500);

    if (step === '3') {
      await verifyPassword(tx, ['pw_step3'], password, '主管1（確認入庫存）');
      if (shipment.whStatus !== 'FINALIZED' && !force) {
        throw new UserError('庫存系統中這張點貨單尚未 Finalize。仍要確認入庫存嗎？', 'CONFIRM');
      }
    }
    if (step === '4a') await verifyPassword(tx, ['pw_step4a'], password, '主管2（上架系統）');

    if (step === '4b') {
      const lines = (await loadLines(tx, id)).filter((l) => l.renfrewQty > 0);
      const countMap = {};
      for (const c of Array.isArray(counts) ? counts : []) {
        countMap[String(c.lineId)] = wholeNumber(c.counted, '清點數量');
      }
      const mismatches = [];
      for (const line of lines) {
        if (!(line.lineId in countMap)) throw new UserError(`請填寫清點數量：${line.productName || line.upc}`);
        if (countMap[line.lineId] !== line.renfrewQty) mismatches.push(line);
      }
      if (mismatches.length && !note) {
        throw new UserError(`有 ${mismatches.length} 項數量與應到數量不符，請填寫備註說明。`, 'NEED_NOTE');
      }
      await tx.query('delete from trk.renfrew_checks where shipment_id = $1', [id]);
      for (const line of lines) {
        await tx.query(
          `insert into trk.renfrew_checks (shipment_id, line_id, upc, product_name, expected_qty, counted_qty)
           values ($1, $2, $3, $4, $5::int, $6::int)`,
          [id, line.lineId, line.upc, line.productName, line.renfrewQty, countMap[line.lineId]]
        );
      }
      await tx.query('update trk.shipments set s4b_note = $2 where shipment_id = $1', [id, note || null]);
    }

    if (step === '5') {
      const unput = await tx.query(
        'select coalesce(sum(counted_qty - put_qty), 0) as n from trk.renfrew_checks where shipment_id = $1', [id]
      );
      const pending = await tx.query(
        'select coalesce(sum(qty), 0) as n from trk.renfrew_stock where shipment_id = $1 and location_code = $2', [id, PENDING]
      );
      const unputQty = Number(unput[0].n);
      const pendingQty = Number(pending[0].n);
      if ((unputQty > 0 || pendingQty > 0) && !force) {
        const parts = [];
        if (unputQty > 0) parts.push(`還有 ${unputQty} 件未歸架`);
        if (pendingQty > 0) parts.push(`Pending 還有 ${pendingQty} 件未掃描上架店內`);
        throw new UserError(parts.join('，') + '。仍要完成並隱藏這張進貨表嗎？', 'CONFIRM');
      }
      await tx.query('update trk.shipments set s5_note = $2 where shipment_id = $1', [id, note || null]);
    }

    const col = STEP_COL[step];
    await tx.query(`update trk.shipments set ${col}_at = now(), ${col}_by = $2 where shipment_id = $1`, [id, user]);
    await logEvent(tx, id, step, force ? 'DONE_FORCED' : 'DONE', user, note);
    return API.getShipment(tx, { shipmentId: id });
  },

  async undoStep(tx, { shipmentId, step, password, note }, ctx) {
    const user = requireUser(ctx);
    step = String(step || '');
    if (!STEP_COL[step]) throw new UserError('無效的步驟：' + step);
    const id = cleanText(shipmentId, 300);
    await tx.query('select 1 from trk.shipments where shipment_id = $1 for update', [id]);
    const shipment = shipmentOut(await loadShipmentRow(tx, id));
    if (!shipment.steps[step]) throw new UserError(`步驟 ${step} 尚未完成，不需要撤銷。`);
    const blocking = LATER[step].filter((s) => shipment.steps[s]);
    if (blocking.length) throw new UserError(`請先撤銷後面的步驟：${blocking.join('、')}。`);
    await verifyPassword(tx, await adminKeys(tx), password, '主管');
    if (step === '4b') {
      const put = await tx.query('select coalesce(sum(put_qty), 0) as n from trk.renfrew_checks where shipment_id = $1', [id]);
      if (Number(put[0].n) > 0) throw new UserError('這張進貨表已經有商品歸架，不能撤銷清點。請用貨架地圖調整庫存。');
      await tx.query('delete from trk.renfrew_checks where shipment_id = $1', [id]);
      await tx.query('update trk.shipments set s4b_note = null where shipment_id = $1', [id]);
    }
    if (step === '5') await tx.query('update trk.shipments set s5_note = null where shipment_id = $1', [id]);
    const col = STEP_COL[step];
    await tx.query(`update trk.shipments set ${col}_at = null, ${col}_by = null where shipment_id = $1`, [id]);
    await logEvent(tx, id, step, 'UNDO', user, cleanText(note, 500));
    return API.getShipment(tx, { shipmentId: id });
  },

  // 掃 UPC：屬於哪些進貨表（未完成優先）＋ Renfrew 貨架位置
  async searchUpc(tx, { upc }) {
    upc = cleanUpc(upc);
    if (!upc) throw new UserError('請輸入或掃描 UPC。');
    await syncShipments(tx);
    const wh = await whExists(tx);
    let lines = [];
    if (wh) {
      lines = await tx.query(
        `select ${SHIPMENT_COLUMNS}, l.line_id, p.product_name, p.upc, l.expected_qty, l.received_qty,
                l.required_po_qty, l.required_renfrew_qty
         from wh.products p
         join wh.shipment_lines l on l.product_id = p.product_id
         join trk.shipments t on t.shipment_id = l.shipment_id
         ${whJoin(true)}
         where ltrim(p.upc, '0') = ltrim($1, '0') and p.upc <> ''
         order by (t.s5_at is not null), coalesce(s.created_at, t.created_at) desc
         limit 100`,
        [upc]
      );
    }
    const stockRows = await tx.query(
      `select st.* from trk.renfrew_stock st join trk.renfrew_locations loc on loc.code = st.location_code
       where ltrim(st.upc, '0') = ltrim($1, '0') order by loc.sort, st.location_code`, [upc]
    );
    const toPut = await tx.query(
      `select c.* from trk.renfrew_checks c where ltrim(c.upc, '0') = ltrim($1, '0') and c.counted_qty > c.put_qty`, [upc]
    );
    const labels = await shipmentLabels(tx, stockRows.map((r) => r.shipment_id).concat(toPut.map((r) => r.shipment_id)));
    return {
      upc,
      productName: lines.length ? lines[0].product_name : await productName(tx, upc),
      shipments: lines.map((r) => Object.assign(shipmentOut(r), {
        line: {
          lineId: r.line_id, productName: r.product_name || '', upc: r.upc || '',
          expectedQty: Number(r.expected_qty || 0), receivedQty: Number(r.received_qty || 0),
          poQty: Number(r.required_po_qty || 0), renfrewQty: Number(r.required_renfrew_qty || 0),
          marineQty: Math.max(0, Number(r.expected_qty || 0) - Number(r.required_po_qty || 0) - Number(r.required_renfrew_qty || 0))
        }
      })),
      stock: stockRows.map((r) => stockOut(r, labels)),
      toPutaway: toPut.map((c) => ({
        shipmentId: c.shipment_id, shipment: labels[c.shipment_id] || null, lineId: c.line_id,
        upc: c.upc, productName: c.product_name || '', remaining: Number(c.counted_qty) - Number(c.put_qty)
      }))
    };
  },

  // ---------- Renfrew 倉庫 ----------

  async renfrewMap(tx) {
    const locations = await tx.query('select * from trk.renfrew_locations where active order by sort, code');
    const stock = await tx.query(
      `select st.* from trk.renfrew_stock st join trk.renfrew_locations loc on loc.code = st.location_code
       where loc.active order by st.location_code, st.product_name, st.upc`
    );
    const labels = await shipmentLabels(tx, stock.map((r) => r.shipment_id));
    const byCode = {};
    for (const r of stock) (byCode[r.location_code] = byCode[r.location_code] || []).push(stockOut(r, labels));
    const racks = [];
    const rackIndex = {};
    for (const loc of locations) {
      if (!rackIndex[loc.rack]) {
        rackIndex[loc.rack] = { rack: loc.rack, sort: Number(loc.sort), cells: [] };
        racks.push(rackIndex[loc.rack]);
      }
      const items = byCode[loc.code] || [];
      rackIndex[loc.rack].cells.push({
        code: loc.code,
        note: loc.note || '',
        items,
        totalQty: items.reduce((n, i) => n + i.qty, 0)
      });
    }
    return { racks, toPutaway: await API.renfrewToPutaway(tx) };
  },

  async renfrewToPutaway(tx) {
    const rows = await tx.query(
      `select c.* from trk.renfrew_checks c join trk.shipments t on t.shipment_id = c.shipment_id
       where c.counted_qty > c.put_qty order by t.s4b_at, c.product_name`
    );
    const labels = await shipmentLabels(tx, rows.map((r) => r.shipment_id));
    return rows.map((c) => ({
      shipmentId: c.shipment_id, shipment: labels[c.shipment_id] || null, lineId: c.line_id,
      upc: c.upc || '', productName: c.product_name || '', remaining: Number(c.counted_qty) - Number(c.put_qty)
    }));
  },

  // 歸架：items = [{ shipmentId, lineId, qty, locationCode }]
  async renfrewPutaway(tx, { items }, ctx) {
    const user = requireUser(ctx);
    if (!Array.isArray(items) || !items.length) throw new UserError('沒有要歸架的商品。');
    for (const item of items) {
      const qty = wholeNumber(item.qty, '歸架數量', { min: 1 });
      const loc = await requireLocation(tx, item.locationCode);
      const rows = await tx.query(
        `update trk.renfrew_checks set put_qty = put_qty + $3::int
         where shipment_id = $1 and line_id = $2 and counted_qty - put_qty >= $3::int returning *`,
        [cleanText(item.shipmentId, 300), cleanText(item.lineId, 60), qty]
      );
      if (!rows.length) throw new UserError('歸架數量超過未歸架數量，請重新整理後再試。');
      const c = rows[0];
      await addStock(tx, { locationCode: loc.code, upc: c.upc, productName: c.product_name, shipmentId: c.shipment_id, qty });
      await logMove(tx, { upc: c.upc, productName: c.product_name, shipmentId: c.shipment_id, from: 'ARRIVAL', to: loc.code, qty, reason: 'PUTAWAY', user });
    }
    return API.renfrewMap(tx);
  },

  async renfrewMove(tx, { stockId, toCode, qty }, ctx) {
    const user = requireUser(ctx);
    qty = wholeNumber(qty, '數量', { min: 1 });
    const loc = await requireLocation(tx, toCode);
    const row = await takeStock(tx, stockId, qty);
    if (row.location_code === loc.code) throw new UserError('來源和目的地是同一個位置。');
    await addStock(tx, { locationCode: loc.code, upc: row.upc, productName: row.product_name, shipmentId: row.shipment_id, qty });
    await logMove(tx, { upc: row.upc, productName: row.product_name, shipmentId: row.shipment_id, from: row.location_code, to: loc.code, qty, reason: 'MOVE', user });
    return API.renfrewMap(tx);
  },

  async renfrewRemove(tx, { stockId, qty, reason, note }, ctx) {
    const user = requireUser(ctx);
    qty = wholeNumber(qty, '數量', { min: 1 });
    reason = REMOVE_REASONS[reason] ? reason : 'OTHER';
    const row = await takeStock(tx, stockId, qty);
    await logMove(tx, {
      upc: row.upc, productName: row.product_name, shipmentId: row.shipment_id, from: row.location_code,
      to: reason === 'TO_STORE' ? 'STORE' : null, qty, reason: reason + (note ? ': ' + cleanText(note, 200) : ''), user
    });
    return API.renfrewMap(tx);
  },

  async renfrewAdd(tx, { upc, locationCode, qty, productName: name }, ctx) {
    const user = requireUser(ctx);
    upc = cleanUpc(upc);
    if (!upc) throw new UserError('請輸入或掃描 UPC。');
    qty = wholeNumber(qty, '數量', { min: 1 });
    const loc = await requireLocation(tx, locationCode);
    const productNameValue = cleanText(name, 200) || await productName(tx, upc);
    await addStock(tx, { locationCode: loc.code, upc, productName: productNameValue, shipmentId: '', qty });
    await logMove(tx, { upc, productName: productNameValue, shipmentId: '', from: null, to: loc.code, qty, reason: 'ADD', user });
    return API.renfrewMap(tx);
  },

  // 步驟 5：掃描 UPC，把 Pending 的商品移出（上架店內）
  async renfrewScanOut(tx, { upc, qty, shipmentId }, ctx) {
    const user = requireUser(ctx);
    upc = cleanUpc(upc);
    if (!upc) throw new UserError('請輸入或掃描 UPC。');
    qty = wholeNumber(qty == null ? 1 : qty, '數量', { min: 1 });
    const preferred = cleanText(shipmentId, 300);
    const rows = await tx.query(
      `select * from trk.renfrew_stock where location_code = $1 and ltrim(upc, '0') = ltrim($2, '0')
       order by (shipment_id = $3) desc, updated_at, id for update`,
      [PENDING, upc, preferred]
    );
    const available = rows.reduce((n, r) => n + Number(r.qty), 0);
    if (!available) throw new UserError(`Pending 裡沒有這個商品（${upc}）。`, 'NOT_FOUND');
    if (available < qty) throw new UserError(`Pending 裡這個商品只有 ${available} 件。`);
    let left = qty;
    const taken = [];
    for (const r of rows) {
      if (!left) break;
      const n = Math.min(left, Number(r.qty));
      await takeStock(tx, r.id, n);
      await logMove(tx, { upc: r.upc, productName: r.product_name, shipmentId: r.shipment_id, from: PENDING, to: 'STORE', qty: n, reason: 'TO_STORE', user });
      taken.push({ shipmentId: r.shipment_id, productName: r.product_name || '', qty: n });
      left -= n;
    }
    const labels = await shipmentLabels(tx, taken.map((t) => t.shipmentId));
    const warnings = [...new Set(taken.map((t) => t.shipmentId))]
      .filter((sid) => sid && labels[sid] && !labels[sid].step4a)
      .map((sid) => `${labels[sid].supplier} ${labels[sid].name} 尚未完成 4a「上架系統」`);
    return {
      productName: taken[0].productName,
      taken: taken.map((t) => Object.assign(t, { shipment: labels[t.shipmentId] || null })),
      remainingForUpc: available - qty,
      warnings
    };
  },

  async renfrewMoves(tx, { upc, limit }) {
    const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const value = cleanUpc(upc);
    const rows = value
      ? await tx.query(`select * from trk.renfrew_moves where ltrim(upc, '0') = ltrim($1, '0') order by at desc, id desc limit ${n}`, [value])
      : await tx.query(`select * from trk.renfrew_moves order by at desc, id desc limit ${n}`);
    const labels = await shipmentLabels(tx, rows.map((r) => r.shipment_id));
    return rows.map((r) => ({
      upc: r.upc, productName: r.product_name || '', shipmentId: r.shipment_id || '', shipment: labels[r.shipment_id] || null,
      from: r.from_code || '', to: r.to_code || '', qty: Number(r.qty), reason: r.reason, by: r.by_name || '', at: r.at
    }));
  },

  async lookupUpc(tx, { upc }) {
    upc = cleanUpc(upc);
    return { upc, productName: upc ? await productName(tx, upc) : '' };
  },

  // ---------- 管理 ----------

  async addLocation(tx, { code, rack, password }, ctx) {
    requireUser(ctx);
    await verifyPassword(tx, await adminKeys(tx), password, '主管');
    code = cleanText(code, 20).toUpperCase();
    rack = cleanText(rack || code, 20).toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9-]*$/.test(code) || !/^[A-Z0-9][A-Z0-9-]*$/.test(rack)) {
      throw new UserError('位置代碼只能用英文字母、數字和 -。');
    }
    const existing = await tx.query('select * from trk.renfrew_locations where code = $1', [code]);
    if (existing.length && existing[0].active) throw new UserError('這個位置已經存在：' + code);
    const sortRows = await tx.query(
      'select coalesce(max(sort), 0) as s, count(*) as n from trk.renfrew_locations where rack = $1', [rack]
    );
    const fallback = await tx.query("select coalesce(max(sort), 0) + 10 as s from trk.renfrew_locations where code <> 'PENDING'");
    const sort = Number(sortRows[0].n) ? Number(sortRows[0].s) : Number(fallback[0].s);
    if (existing.length) await tx.query('update trk.renfrew_locations set active = true, rack = $2 where code = $1', [code, rack]);
    else await tx.query('insert into trk.renfrew_locations (code, rack, sort) values ($1, $2, $3::int)', [code, rack, sort]);
    return API.renfrewMap(tx);
  },

  async removeLocation(tx, { code, password }, ctx) {
    requireUser(ctx);
    await verifyPassword(tx, await adminKeys(tx), password, '主管');
    code = cleanText(code, 20).toUpperCase();
    if (code === PENDING) throw new UserError('Pending 不能刪除。');
    const stock = await tx.query('select coalesce(sum(qty), 0) as n from trk.renfrew_stock where location_code = $1', [code]);
    if (Number(stock[0].n) > 0) throw new UserError('這個位置還有商品，請先移走。');
    await tx.query('update trk.renfrew_locations set active = false where code = $1', [code]);
    return API.renfrewMap(tx);
  },

  async setPassword(tx, { key, value, adminPassword }, ctx) {
    requireUser(ctx);
    if (!PASSWORD_KEYS.includes(key)) throw new UserError('無效的密碼種類。');
    await verifyPassword(tx, await adminKeys(tx), adminPassword, '主管');
    value = String(value || '');
    if (!value) {
      if (key !== 'pw_access') throw new UserError('密碼不能是空白。');
      await tx.query("delete from trk.settings where key = 'pw_access'");
      return { ok: true };
    }
    if (value.length < 4) throw new UserError('密碼至少 4 個字元。');
    await tx.query(
      `insert into trk.settings (key, value) values ($1, extensions.crypt($2::text, extensions.gen_salt('bf', 8)))
       on conflict (key) do update set value = excluded.value, updated_at = now()`,
      [key, value]
    );
    accessCache.clear();
    return { ok: true };
  }
};
