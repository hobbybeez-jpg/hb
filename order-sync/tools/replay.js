// 回放：用 Shopify 匯出的訂單 CSV 跑一次規則，和試算表裡人工記錄的結果逐欄比對。
// 用法：node order-sync/tools/replay.js orders_export.csv sheet.json [--numbering=shopify|stockFirst] [--show=欄位]
// sheet.json：試算表各分頁的資料（{ "2026已出貨 CA": [{ r, v: [A..O], colors: { A, B, M } }], "預購": [...], ... }）
// 訂單資料含個資，CSV 和 sheet.json 不要放進 repo。
'use strict';
const fs = require('fs');
const { planOrder, rulesOrderFacts, rulesUpcKey } = require('../src/Rules.js');
const { ordersFromCsv } = require('./csv-orders.js');

const args = process.argv.slice(2);
const opt = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')));
const [csvFile, sheetFile] = args.filter((a) => !a.startsWith('--'));
const numbering = opt.numbering || 'stockFirst';

const orders = ordersFromCsv(csvFile);
const byName = new Map(orders.map((o) => [o.name, o]));
const sheet = JSON.parse(fs.readFileSync(sheetFile, 'utf8'));
const COLS = 'ABCDEFGHIJKLMNO';
const cell = (row, col) => row.v[COLS.indexOf(col)];
const key = (v) => String(v ?? '').trim();

function index(tab) {
  const m = new Map();
  for (const row of sheet[tab] || []) {
    const k = key(row.v[0]);
    if (!k) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(row);
  }
  return m;
}
const tabs = { '2026已出貨 CA': index('2026已出貨 CA'), '2026已出貨 INT': index('2026已出貨 INT') };
const preIdx = index('預購');

const ctx = {
  findPreorder(code) {
    const row = (preIdx.get(code) || [])[0];
    if (!row) return null;
    // 試算表裡現在的 B 欄已經被改成 Y，回放時從原單判斷是不是 backorder
    let B = cell(row, 'B');
    const orig = byName.get(code.replace(/-\d+$/, ''));
    if (orig) {
      const f = rulesOrderFacts(orig, { numbering });
      const l = f.counted.find((x) => x.code === code);
      if (l) B = l.kind === 'backorder' ? 'backorder' : '';
    }
    return { row: row.r, B, C: cell(row, 'C'), D: cell(row, 'D'), I: cell(row, 'I'), L: cell(row, 'L'), M: cell(row, 'M'), N: 0, Nvalue: 0 };
  },
  findOriginal(base) { return byName.get(base) || null; },
  baseShipped() { return false; },
  findShipped(code) {
    for (const t of Object.keys(tabs)) {
      const row = (tabs[t].get(code) || [])[0];
      if (row && cell(row, 'C') === 'Shopify') return { file: 'main', tab: t, row: row.r, L: 0, O: 0 };
    }
    return null;
  }
};

const norm = (v) => (v === null || v === undefined ? '' : typeof v === 'number' ? Math.round(v * 100) / 100 : String(v).trim());
const sameNum = (a, b) => {
  const x = Number(a === '' || a == null ? 0 : a), y = Number(b === '' || b == null ? 0 : b);
  return isFinite(x) && isFinite(y) ? Math.abs(x - y) < 0.006 : norm(a) === norm(b);
};
const colorName = (c) => ({ '#cccccc': 'gray', '#00ffff': 'cyan', '#ff9900': 'orange', '#4a86e8': 'blue', '#d9d9d9': 'gray' }[c] || '');

const stats = {};
const samples = {};
function tally(field, ok, sample) {
  stats[field] = stats[field] || { ok: 0, bad: 0 };
  stats[field][ok ? 'ok' : 'bad']++;
  if (!ok) { samples[field] = samples[field] || []; if (samples[field].length < 8) samples[field].push(sample); }
}

let ordersChecked = 0, ordersSkipped = 0, notInSheet = 0, otherYear = 0;
const kinds = {};
for (const order of orders) {
  const plan = planOrder(order, ctx, { numbering });
  const kind = plan.facts.draft && plan.facts.popw ? 'popw' : plan.facts.pw ? 'pw' : plan.facts.pos ? 'pos' : 'web';
  let any = false;
  for (const a of plan.actions) {
    if (a.op === 'appendShipped') {
      if (a.year !== 2026) { otherYear++; continue; }
      const tab = `2026已出貨 ${a.region}`;
      const row = (tabs[tab].get(a.key) || [])[0];
      if (!row) {
        const other = (tabs[a.region === 'CA' ? '2026已出貨 INT' : '2026已出貨 CA'].get(a.key) || [])[0];
        tally('shipped:找得到這一列', false, `${a.key} ${other ? '在另一個分頁' : '找不到'} (${kind})`);
        notInSheet++;
        continue;
      }
      any = true;
      tally('shipped:找得到這一列', true);
      for (const col of ['B', 'C', 'D', 'J', 'K', 'L']) {
        const want = a.values[col], got = cell(row, col);
        const ok = ['J', 'K', 'L'].includes(col) ? sameNum(want, got) : norm(want).toLowerCase() === norm(got).toLowerCase();
        tally(`shipped:${col}`, ok, `${a.key} 規則=${JSON.stringify(want)} 試算表=${JSON.stringify(got)} (${kind})`);
        kinds[kind] = kinds[kind] || {}; kinds[kind][col] = kinds[kind][col] || { ok: 0, bad: 0 }; kinds[kind][col][ok ? 'ok' : 'bad']++;
      }
      const wantM = colorName(a.colors.M), gotM = colorName(row.colors.M);
      tally('shipped:M顏色', wantM === gotM, `${a.key} 規則=${wantM || '無'} 試算表=${gotM || '無'} (${kind})`);
      if (a.values.M === 0) tally('shipped:M=0', sameNum(cell(row, 'M'), 0), `${a.key} 試算表 M=${JSON.stringify(cell(row, 'M'))} (${kind})`);
    } else if (a.op === 'appendPreorder') {
      const row = (preIdx.get(a.key) || [])[0];
      if (!row) { tally('預購:找得到這一列', false, `${a.key}`); notInSheet++; continue; }
      any = true;
      tally('預購:找得到這一列', true);
      const sheetB = key(cell(row, 'B'));
      for (const col of ['B', 'C', 'D', 'I', 'L', 'M', 'N']) {
        if (col === 'B' && /^(Y|C)$/i.test(sheetB)) continue;
        if (col === 'N' && /^Y$/i.test(sheetB)) continue;
        const want = a.values[col], got = cell(row, col);
        const ok = col === 'I' ? rulesUpcKey(want) === rulesUpcKey(got) : ['L', 'M', 'N'].includes(col) ? sameNum(want, got) : norm(want).toLowerCase() === norm(got).toLowerCase();
        tally(`預購:${col}`, ok, `${a.key} 規則=${JSON.stringify(want)} 試算表=${JSON.stringify(got)}`);
      }
    }
  }
  if (any) ordersChecked++; else ordersSkipped++;
}

console.log(`編號規則：${numbering}；訂單 ${orders.length} 張，有比對到的 ${ordersChecked} 張；其他年份（2025/2024 檔案）${otherYear} 列；找不到 ${notInSheet} 列`);
for (const [f, s] of Object.entries(stats)) {
  const pct = ((s.ok / (s.ok + s.bad)) * 100).toFixed(1);
  console.log(`${f.padEnd(22)} 符合 ${String(s.ok).padStart(5)}  不符 ${String(s.bad).padStart(4)}  (${pct}%)`);
}
const show = opt.show ? opt.show.split(',') : Object.keys(samples);
for (const f of show) {
  if (!samples[f]) continue;
  console.log(`\n— ${f} 不符的例子：`);
  for (const s of samples[f]) console.log('   ' + s);
}
if (opt.kinds) console.log(JSON.stringify(kinds, null, 1));
