// 把 Shopify「Export orders」的 CSV 轉成 Rules.js 用的 order 格式（只給測試／回放用）。
// CSV 沒有手續費、也沒有每一行分到的整單折扣，所以：
//   - payments 一律是空的（手續費不比對）
//   - 整單折扣按商品金額比例分攤；折扣碼是 FREESHIP 開頭的當成運費折扣
'use strict';
const fs = require('fs');
const { rulesAllocate, rulesRound2, classifyLine } = require('../src/Rules.js');

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift().map((h) => h.replace(/^﻿/, ''));
  return rows.filter((r) => r.length > 1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

function ordersFromCsv(file) {
  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  const byName = new Map();
  for (const r of rows) {
    if (!byName.has(r.Name)) byName.set(r.Name, []);
    byName.get(r.Name).push(r);
  }
  const orders = [];
  for (const [name, rs] of byName) {
    const h = rs[0];
    const shipping = Number(h.Shipping || 0);
    const discount = Number(h['Discount Amount'] || 0);
    const shipDiscount = /^FREESHIP/i.test(h['Discount Code'] || '') ? Math.min(discount, shipping) : 0;
    const order = {
      name: name.replace(/^#/, ''),
      date: h['Created at'].slice(0, 10),
      createdAt: h['Created at'],
      source: h.Source,
      financialStatus: h['Financial Status'],
      cancelled: !!h['Cancelled at'],
      email: h.Email,
      country: h['Shipping Country'],
      shippingTitle: h['Shipping Method'],
      shippingCharged: rulesRound2(shipping - shipDiscount),
      lines: rs.map((r) => ({
        name: r['Lineitem name'],
        qty: Number(r['Lineitem quantity'] || 0),
        unitPrice: Number(r['Lineitem price'] || 0),
        discount: Number(r['Lineitem discount'] || 0),
        sku: r['Lineitem sku'],
        barcode: '',
        requiresShipping: r['Lineitem requires shipping'] === 'true'
      })),
      payments: []
    };
    const productDiscount = rulesRound2(discount - shipDiscount);
    if (productDiscount > 0) {
      const targets = order.lines.filter((l) => ['stock', 'preorder', 'backorder', 'popw'].includes(classifyLine(l, order)));
      const parts = rulesAllocate(productDiscount, targets.map((l) => l.unitPrice * l.qty));
      targets.forEach((l, i) => { l.discount = rulesRound2(l.discount + parts[i]); });
    }
    orders.push(order);
  }
  return orders;
}

module.exports = { parseCsv, ordersFromCsv };
