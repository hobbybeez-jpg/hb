// Rules.js — 訂單 → 試算表的規則（純邏輯，不呼叫 Google / Shopify，可以在 Node 測試）
//
// planOrder(order, ctx, options) 回傳 plan：要新增／修改哪些列、每一欄的值和顏色、警告和錯誤。
// Sheets.js 依照 plan 寫入；側邊欄先顯示 plan 給人確認。
//
// order 的格式（Shopify.js 的 normalizeOrder 產生，測試時由 CSV 產生）：
// {
//   name: 'CA53126D', date: '2026-10-14'（溫哥華日期）, source: 'web' | 'pos' | 'shopify_draft_order' | ...,
//   financialStatus: 'paid' | 'partially_paid' | 'refunded' | ..., cancelled: false, email: '...',
//   country: 'CA', shippingTitle: 'Flat Rate Shipping', shippingCharged: 14.99（已扣運費折扣）,
//   lines: [{ name, qty, unitPrice, discount（這一行分到的折扣總額）, sku, barcode, requiresShipping, description }],
//   payments: [{ createdAt, gateway, amount, fee（null＝讀不到）, feeNote }]
// }

var RULES_COLORS = {
  gray: '#cccccc',
  cyan: '#00ffff',
  orange: '#ff9900',
  blue: '#4a86e8',
  green: '#93c47d',
  yellow: '#ffff00'
};

var RULES_RE = {
  service: /Damage\s*&\s*Loss Insurance|Gift Wrapping|Private Warehouse Storage Fee/i,
  shippingLike: /shipping/i,
  // 「Store this order at my Private Warehouse」：舊的 PW 服務商品（已停用，現在用運送方式），不記錄
  skip: /^Gift Card\b|Coin Exchange|^Transaction Fee$|^Cancellation Fee$|Store (this order )?at my Private Warehouse/i,
  // 關稅（Duties (US)、Prepaid Duties (US)…）：只看沒有 SKU／Barcode 的自訂收費，避免排除名稱剛好有 Duty 的商品
  duties: /\bdut(y|ies)\b|關稅/i,
  preorder: /\s+-\s+(Pay in full(?:\s*\([^)]*\))?|Pay a 20% non-refundable deposit)\s*$/i,
  deposit: /Pay a 20% non-refundable deposit\s*$/i,
  backorder: /^\s*\[backorder\]\s*/i,
  popwLine: /^\s*#?(CA\d+D(?:-\d+)?)\s+([\s\S]*)$/i,
  upcInName: /\((\d{6,14})\)/,
  pickup: /Vancouver \(Renfrew\)|Pick-?\s?up|Pick up in store/i,
  pw: /^\s*Do not Ship\.?\s*Store at my Private Warehouse/i,
  deadline: /Pre-?Order\s*Deadline\s*:?\s*(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/i
};

function rulesRound2(x) {
  return Math.round((Number(x) + (x >= 0 ? 1 : -1) * 1e-9) * 100) / 100;
}

function rulesNum(x) {
  var n = Number(x);
  return isFinite(n) ? n : 0;
}

// 去掉 [Backorder] 和 " - Pay in full (...)"、" - Pay a 20% ..." 之後的商品名稱
function rulesCleanName(name) {
  return String(name || '').replace(RULES_RE.backorder, '').replace(RULES_RE.preorder, '').trim();
}

function rulesUpc(line) {
  var v = String(line.barcode || line.sku || '').trim();
  return v;
}

// 試算表裡 UPC 存成數字（開頭的 0 會不見），比對時一律去掉開頭的 0
function rulesUpcKey(v) {
  return String(v == null ? '' : v).trim().replace(/\.0+$/, '').replace(/^0+/, '');
}

function rulesUpcCell(v) {
  var s = String(v || '').trim();
  if (/^\d{1,15}$/.test(s)) return Number(s);
  return s;
}

function classifyLine(line, order) {
  var name = String(line.name || '');
  if (rulesNum(line.qty) <= 0) return 'removed';
  // POPW 出貨單的商品：「CA46701D⇥品名⇥(UPC)⇥日期」，有時是「CA39736D 品名」（空格）
  // 有時出現在一般訂單裡（客人用網站結帳一起付預購尾款，例如 CA52750D）
  if (RULES_RE.popwLine.test(name)) return 'popw';
  if (RULES_RE.skip.test(name)) return 'skip';
  if (!line.sku && !line.barcode && RULES_RE.duties.test(name)) return 'skip';
  if (RULES_RE.service.test(name)) return 'service';
  if (!line.sku && !line.barcode && RULES_RE.shippingLike.test(name)) return 'service';
  if (RULES_RE.backorder.test(name)) return 'backorder';
  if (RULES_RE.preorder.test(name)) return 'preorder';
  return 'stock';
}

function rulesLineTotal(line) {
  return rulesRound2(rulesNum(line.unitPrice) * rulesNum(line.qty) - rulesNum(line.discount));
}

// 依比例分配 amount，四捨五入的差額放在最後一項
function rulesAllocate(amount, weights) {
  var total = weights.reduce(function (s, w) { return s + w; }, 0);
  var out = weights.map(function () { return 0; });
  if (!weights.length) return out;
  if (total <= 0) { out[out.length - 1] = rulesRound2(amount); return out; }
  var used = 0;
  for (var i = 0; i < weights.length; i++) {
    if (i === weights.length - 1) out[i] = rulesRound2(amount - used);
    else { out[i] = rulesRound2(amount * weights[i] / total); used = rulesRound2(used + out[i]); }
  }
  return out;
}

function rulesFeeInfo(payments) {
  var list = (payments || []).slice().sort(function (a, b) { return String(a.createdAt).localeCompare(String(b.createdAt)); });
  var unknown = list.filter(function (p) { return p.fee == null; });
  var sum = function (arr) { return rulesRound2(arr.reduce(function (s, p) { return s + rulesNum(p.fee); }, 0)); };
  return {
    total: sum(list),
    first: list.length ? sum(list.slice(0, 1)) : 0,
    later: sum(list.slice(1)),
    paid: rulesRound2(list.reduce(function (s, p) { return s + rulesNum(p.amount); }, 0)),
    unknown: unknown.map(function (p) { return p.gateway || '?'; }),
    count: list.length
  };
}

function rulesOrderFacts(order, options) {
  options = options || {};
  var lines = (order.lines || []).map(function (line, i) {
    return Object.assign({}, line, { index: i, kind: classifyLine(line, order) });
  });
  var counted = lines.filter(function (l) { return l.kind === 'stock' || l.kind === 'preorder' || l.kind === 'backorder'; });
  if (options.numbering !== 'shopify') {
    counted = counted.filter(function (l) { return l.kind === 'stock'; })
      .concat(counted.filter(function (l) { return l.kind !== 'stock'; }));
  }
  counted.forEach(function (l, i) { l.code = order.name + (counted.length > 1 ? '-' + (i + 1) : ''); });
  var services = lines.filter(function (l) { return l.kind === 'service'; });
  var title = String(order.shippingTitle || '');
  var isPickup = RULES_RE.pickup.test(title);
  var isPW = RULES_RE.pw.test(title);
  var country = String(order.country || '').toUpperCase();
  var region = (!isPickup && !isPW && country && country !== 'CA' && country !== 'US') ? 'INT' : 'CA';
  var servicesTotal = rulesRound2(services.reduce(function (s, l) { return s + rulesLineTotal(l); }, 0));
  // 運費類的自訂商品（例如 POS 加的「Flat Rate Shipping」）
  var shippingLines = rulesRound2(services.filter(function (l) { return !RULES_RE.service.test(l.name); })
    .reduce(function (s, l) { return s + rulesLineTotal(l); }, 0));
  return {
    lines: lines,
    counted: counted,
    stock: counted.filter(function (l) { return l.kind === 'stock'; }),
    pre: counted.filter(function (l) { return l.kind !== 'stock'; }),
    popw: lines.filter(function (l) { return l.kind === 'popw'; }),
    services: services,
    skipped: lines.filter(function (l) { return l.kind === 'skip'; }),
    servicesTotal: servicesTotal,
    // 保險、禮品包裝、Storage Fee（不含運費類的自訂商品）
    extras: rulesRound2(servicesTotal - shippingLines),
    shippingPaid: rulesRound2(rulesNum(order.shippingCharged) + shippingLines),
    shipping: rulesRound2(rulesNum(order.shippingCharged)),
    isPickup: isPickup,
    isPW: isPW,
    isPOS: order.source === 'pos',
    isDraft: order.source === 'shopify_draft_order',
    region: region,
    year: Number(String(order.date).slice(0, 4)),
    fees: rulesFeeInfo(order.payments)
  };
}

// 原單「已付金額」的分配基準：商品（訂金只算訂金）＋運費＋服務費
// 有預購商品時，保險等服務費算在預購商品（出貨時平分記到 L 欄），不算在現貨
function rulesPaidWeights(facts) {
  var extrasToPre = facts.pre.length ? facts.extras : 0;
  var stockPart = facts.stock.reduce(function (s, l) { return s + rulesLineTotal(l); }, 0) + facts.shippingPaid + (facts.extras - extrasToPre);
  return {
    stockPart: rulesRound2(stockPart),
    total: rulesRound2(stockPart + extrasToPre + facts.pre.reduce(function (s, l) { return s + rulesLineTotal(l); }, 0))
  };
}

// 原單的保險等服務費平分給每個預購商品，回傳這個商品分到的金額
function rulesExtrasShare(of, origLine) {
  if (!(of.extras > 0) || !of.pre.length || !origLine) return 0;
  var idx = of.pre.indexOf(origLine);
  if (idx < 0) return 0;
  return rulesAllocate(of.extras, of.pre.map(function () { return 1; }))[idx];
}

// 從同一張原單的 -1、-2… 裡挑出對應的那一列：先排除出貨單上明確寫出的編號，再用 UPC、品名，剩一個就用它
function rulesPickCandidate(cands, explicitCodes, upc, itemName) {
  var list = cands.filter(function (c) { return !explicitCodes[String(c.code).toUpperCase()]; });
  if (!list.length) return {};
  if (upc) {
    var byUpc = list.filter(function (c) { return rulesUpcKey(c.I) === rulesUpcKey(upc); });
    if (byUpc.length === 1) return { found: byUpc[0], by: '用 UPC 對到' };
    if (byUpc.length > 1) list = byUpc;
  }
  var norm = function (t) { return String(t || '').toLowerCase().replace(/\s+/g, ' ').trim(); };
  var n = norm(itemName);
  if (n) {
    var byName = list.filter(function (c) { var d = norm(c.D); return d && (d.indexOf(n) >= 0 || n.indexOf(d) >= 0); });
    if (byName.length === 1) return { found: byName[0], by: '用品名對到' };
    if (byName.length > 1) list = byName;
  }
  if (list.length === 1) return { found: list[0], by: '只有這一個' };
  return { ambiguous: list.map(function (c) { return c.code; }) };
}

// CA42482D-3 → [42482, 3]，用來把出貨單的商品照單號排序
function rulesCodeOrder(code) {
  var m = /CA(\d+)D(?:-(\d+))?/i.exec(code);
  return m ? [Number(m[1]), Number(m[2] || 0)] : [Infinity, 0];
}

function planOrder(order, ctx, options) {
  ctx = ctx || {};
  options = options || {};
  var plan = { order: order.name, date: order.date, summary: '', errors: [], warnings: [], notes: [], actions: [] };
  var facts = rulesOrderFacts(order, options);
  plan.facts = {
    stock: facts.stock.length, pre: facts.pre.length, popw: facts.popw.length, region: facts.region,
    pickup: facts.isPickup, pw: facts.isPW, pos: facts.isPOS, draft: facts.isDraft
  };

  if (order.cancelled) plan.errors.push('這張單已取消，不處理。');
  if (/refunded/i.test(order.financialStatus || '')) plan.warnings.push('這張單有退款（' + order.financialStatus + '），寫入的是目前剩下的商品，請確認。');
  if (facts.fees.unknown.length) plan.warnings.push('讀不到手續費：' + facts.fees.unknown.join(', ') + '。手續費欄會留空。');
  facts.skipped.forEach(function (l) { plan.notes.push('不記錄：' + l.name + '（$' + rulesLineTotal(l) + '）'); });
  facts.lines.forEach(function (l) {
    if (l.kind === 'stock' && l.requiresShipping === false) plan.warnings.push('「' + l.name + '」在 Shopify 設定為不需寄送，但不是預購格式，先當現貨記錄，請確認。');
  });

  if (facts.popw.length) {
    planPopw(order, facts, ctx, plan, options);
  } else {
    // 等待中：補了運費但客人還沒付清；或 INT 單運費還是 $0（還沒報價）。不寫入、不算錯誤，付清後再掃描就會變成可寫入
    if (/^partially_paid$/i.test(order.financialStatus || '')) {
      plan.waiting = '還沒付清（partially paid）：等客人付完運費 invoice 再處理。';
    } else if (facts.region === 'INT' && facts.stock.length && facts.shipping === 0) {
      plan.waiting = 'INT 訂單運費還是 $0：等報價、客人付完運費再處理。';
    }
    if (plan.waiting) plan.errors.push(plan.waiting);
    planNewOrder(order, facts, ctx, plan);
  }

  var parts = [];
  if (facts.stock.length) parts.push('現貨 ' + facts.stock.length + ' 項');
  if (facts.pre.length) parts.push('預購/backorder ' + facts.pre.length + ' 項');
  if (facts.popw.length) {
    parts.push('POPW 出貨 ' + facts.popw.length + ' 項（' + facts.popw.map(function (l) { return RULES_RE.popwLine.exec(l.name)[1].toUpperCase(); }).join('、') + '）');
  }
  if (facts.isPW) parts.push('存放 PW');
  if (facts.isPickup) parts.push('自取');
  if (facts.region === 'INT') parts.push('INT');
  plan.summary = parts.join('，') || '沒有要記錄的商品';
  if (!plan.actions.length && !plan.errors.length) plan.warnings.push('這張單沒有要寫入的資料。');
  return plan;
}

function planNewOrder(order, facts, ctx, plan) {
  var platform = facts.isPOS ? 'Store' : 'Shopify';
  var weights = rulesPaidWeights(facts);
  var stockFeeShare = weights.total > 0 ? weights.stockPart / weights.total : 1;
  if (facts.pre.length && facts.stock.length) {
    plan.notes.push('現貨和預購混合：手續費按已付金額比例分攤，現貨部分佔 ' + Math.round(stockFeeShare * 1000) / 10 + '%。');
  }
  var feeN, feeO;
  if (facts.region === 'INT') {
    feeN = facts.fees.first; feeO = facts.fees.later;
  } else {
    feeN = facts.fees.total; feeO = 0;
  }
  feeN = rulesRound2(feeN * stockFeeShare);
  var feeUnknown = facts.fees.unknown.length > 0;

  facts.stock.forEach(function (line, i) {
    var first = i === 0;
    var values = {
      A: line.code,
      B: order.date,
      C: platform,
      D: line.name,
      J: rulesNum(line.qty),
      K: rulesLineTotal(line),
      L: first ? (facts.pre.length ? facts.shippingPaid : rulesRound2(facts.shipping + facts.servicesTotal)) : 0,
      N: first ? (feeUnknown ? '' : feeN) : 0,
      O: first ? (feeUnknown ? '' : rulesRound2(feeO)) : 0
    };
    var colors = {};
    if (facts.isPOS) {
      values.M = 0;
    } else if (facts.isPW) {
      values.M = ''; colors.M = RULES_COLORS.orange;
    } else if (facts.isPickup) {
      values.M = 0; colors.M = RULES_COLORS.cyan;
    } else if (!first) {
      values.M = 0; colors.M = RULES_COLORS.gray;
    } else {
      values.M = '';
    }
    plan.actions.push({
      op: 'appendShipped', year: facts.year, region: facts.region, key: line.code,
      label: facts.year + '已出貨 ' + facts.region, values: values, colors: colors
    });
    if (facts.isPW) {
      plan.actions.push({
        op: 'appendPW', key: line.code, label: 'POPW（PW 存放）',
        values: { C: 'PW', D: order.date, E: line.code, F: line.name, G: rulesUpcCell(rulesUpc(line)), I: rulesNum(line.qty), J: order.email || '' },
        colors: { C: RULES_COLORS.gray }
      });
      if (!rulesUpc(line)) plan.warnings.push('「' + line.name + '」沒有 UPC，POPW 的 G 欄會留空。');
    }
  });

  var preShippingPaid = !facts.stock.length && facts.shippingPaid > 0;
  if (facts.pre.length && facts.extras > 0) {
    plan.notes.push('保險等服務費 $' + facts.extras + ' 平分給 ' + facts.pre.length + ' 個預購商品，每個商品出貨時記在已出貨的 L 欄。');
  }
  if (preShippingPaid && facts.pre.length) {
    plan.notes.push('預付的運費 $' + facts.shippingPaid + ' 在第一個預購商品出貨時記在已出貨的 L 欄。');
  }
  var seenUpc = {};
  facts.pre.forEach(function (line) {
    var isBackorder = line.kind === 'backorder';
    var isDeposit = RULES_RE.deposit.test(line.name);
    var qty = rulesNum(line.qty);
    var paid = rulesLineTotal(line);
    var unitDue;
    if (isDeposit) {
      var full = rulesRound2(rulesNum(line.unitPrice) * 5 - 0.01);
      if (Math.round(full * 100) % 100 !== 99) {
        plan.warnings.push('「' + rulesCleanName(line.name) + '」訂金 $' + line.unitPrice + ' ×5−0.01 = $' + full + '，不是 .99 結尾，請確認應付金額。');
      }
      unitDue = rulesRound2(full - rulesNum(line.discount) / qty);
    } else {
      unitDue = rulesRound2(paid / qty);
    }
    var upc = rulesUpc(line);
    var values = {
      A: line.code,
      B: isBackorder ? 'backorder' : (preShippingPaid ? 'shipping paid' : ''),
      C: order.date,
      D: rulesCleanName(line.name),
      I: rulesUpcCell(upc),
      L: qty,
      M: unitDue,
      N: paid
    };
    var colors = {};
    if (values.B === 'shipping paid') colors.B = RULES_COLORS.blue;
    plan.actions.push({
      op: 'appendPreorder', key: line.code, label: '預購', values: values, colors: colors, deposit: isDeposit
    });
    // 存到控制台「原單資料」：出貨時原單可能已經超過 60 天讀不到，先把這個商品分到的保險、手續費、預付運費記下來
    var extrasShare = rulesExtrasShare(facts, line);
    plan.actions.push({
      op: 'saveOriginal', key: line.code, label: '原單資料（控制台）',
      values: {
        A: line.code, B: order.name, C: extrasShare,
        D: facts.fees.unknown.length || !(weights.total > 0) ? '' : rulesRound2(facts.fees.total * (paid + extrasShare) / weights.total),
        E: facts.stock.length ? 0 : facts.shippingPaid,
        F: order.date
      }
    });
    if (!upc) {
      plan.warnings.push('「' + rulesCleanName(line.name) + '」沒有 UPC，無法對應訂貨表。');
      return;
    }
    var key = rulesUpcKey(upc);
    if (seenUpc[key]) return;
    seenUpc[key] = true;
    var m = RULES_RE.deadline.exec(String(line.description || '').replace(/<[^>]+>/g, ' '));
    var deadline = m ? m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2) : '';
    plan.actions.push({
      op: 'ensureOrdering', key: key, label: '訂貨（UPC 不存在才新增）',
      values: { A: rulesCleanName(line.name), B: rulesUpcCell(upc), C: deadline },
      // 只有真的要新增到訂貨表時才提醒（Sheets.resolve 判斷）
      missingDeadline: !deadline && !isBackorder ? '「' + rulesCleanName(line.name) + '」要新增到訂貨表，但商品敘述找不到 Pre-Order Deadline，C 欄會留空。' : ''
    });
  });
}

// POPW 出貨單：Draft 單，商品名稱是「CA46701D⇥品名⇥(UPC)⇥日期」
function planPopw(order, facts, ctx, plan, options) {
  // 出貨單裡另外加了現貨：現貨用出貨單的單號記錄（和一般訂單一樣），出貨單的運費、手續費記在現貨那一列，POPW 那幾列不記
  var chargesOnStock = facts.stock.length > 0;
  if (chargesOnStock) {
    if (facts.pre.length) {
      facts.pre.forEach(function (l) { plan.errors.push('出貨單裡有預購商品「' + l.name + '」，請手動處理。'); });
      return;
    }
    planNewOrder(order, facts, ctx, plan);
  }
  var draftExtra = chargesOnStock ? 0 : rulesRound2(facts.shipping + facts.servicesTotal);
  var draftFee = chargesOnStock ? 0 : (facts.fees.unknown.length ? '' : facts.fees.total);
  var popwRegion = facts.region;
  var originalsCharged = {};
  if (!chargesOnStock) {
    facts.pre.forEach(function (l) {
      plan.warnings.push('出貨單裡有不是「CA單號 品名」格式的商品：「' + l.name + '」，沒有記錄，請手動處理。');
    });
  }

  // 同一張原單的商品照編號從小到大寫入（CA42482D-1、-2、-3…）；不同原單照出貨單上的先後。運費和手續費記在第一項
  var firstSeen = {};
  facts.popw.forEach(function (l, i) {
    var base = rulesCodeOrder(RULES_RE.popwLine.exec(l.name)[1])[0];
    if (!(base in firstSeen)) firstSeen[base] = i;
  });
  var popwLines = facts.popw.slice().sort(function (a, b) {
    var x = rulesCodeOrder(RULES_RE.popwLine.exec(a.name)[1]), y = rulesCodeOrder(RULES_RE.popwLine.exec(b.name)[1]);
    return firstSeen[x[0]] - firstSeen[y[0]] || x[1] - y[1] || a.index - b.index;
  });
  var explicitCodes = {};
  popwLines.forEach(function (l) { explicitCodes[RULES_RE.popwLine.exec(l.name)[1].toUpperCase()] = true; });
  popwLines.forEach(function (line, i) {
    var first = i === 0;
    var m = RULES_RE.popwLine.exec(line.name);
    var code = m[1].toUpperCase();
    var base = code.replace(/-\d+$/, '');
    var linePaid = rulesLineTotal(line);
    var itemName = String(m[2] || '').split(/\t|\s\(/)[0].trim();
    var upcMatch = RULES_RE.upcInName.exec(m[2] || '');
    var pre = ctx.findPreorder ? ctx.findPreorder(code) : null;
    var shipped = null;
    // 出貨單上寫「CA37556D」，試算表是「CA37556D-1」：找同一張原單的 -1、-2…，用 UPC、品名對
    if (!pre && code === base) {
      var pick = rulesPickCandidate(ctx.preorderCandidates ? ctx.preorderCandidates(base) : [], explicitCodes, upcMatch && upcMatch[1], itemName);
      if (pick.found) {
        pre = pick.found;
        plan.notes.push(code + '：出貨單上沒有編號，對應到預購表第 ' + pre.row + ' 列的 ' + pre.code + '（' + pick.by + '）。');
        code = pre.code;
      } else if (pick.ambiguous) {
        plan.errors.push(code + '：預購表有好幾個 ' + base + '-N（' + pick.ambiguous.join('、') + '），對不出是哪一個，請手動處理。');
        return;
      } else {
        shipped = ctx.findShipped ? ctx.findShipped(code) : null;
        if (!shipped) {
          var spick = rulesPickCandidate(ctx.shippedCandidates ? ctx.shippedCandidates(base) : [], explicitCodes, null, itemName);
          if (spick.found) {
            shipped = spick.found;
            plan.notes.push(code + '：出貨單上沒有編號，對應到「' + shipped.tab + '」第 ' + shipped.row + ' 列的 ' + shipped.code + '（' + spick.by + '）。');
            code = shipped.code;
          } else if (spick.ambiguous) {
            plan.errors.push(code + '：已出貨表有好幾個 ' + base + '-N（' + spick.ambiguous.join('、') + '），對不出是哪一個，請手動處理。');
            return;
          }
        }
      }
    }

    if (pre) {
      var wasBackorder = /backorder/i.test(String(pre.B || ''));
      if (String(pre.B || '').trim().toUpperCase() === 'Y') plan.warnings.push(code + '：預購表 B 欄已經是 Y，可能已經處理過。');
      var year = Number(String(pre.C || '').slice(0, 4)) || facts.year;
      var qty = rulesNum(pre.L) || rulesNum(line.qty);
      var unitDue = rulesNum(pre.M);

      // 原單的保險等服務費：平分給原單的每個預購商品（現貨那幾列當時沒記）
      // 原單只有預購而且預付了運費：原單第一個出貨的商品加一次
      var origExtra = 0;
      var origFeeN = '';
      var saved = ctx.findSaved ? ctx.findSaved(code) : null;
      var original = saved ? null : (ctx.findOriginal ? ctx.findOriginal(base) : null);
      if (saved) {
        // 控制台「原單資料」：預購單記錄時存下的分攤金額
        if (saved.extras) {
          origExtra = rulesRound2(origExtra + saved.extras);
          plan.notes.push(code + '：原單的保險等服務費，這一項分到 $' + saved.extras + '，加到 L 欄（控制台原單資料）。');
        }
        if (saved.prepaid > 0 && !(ctx.baseShipped && ctx.baseShipped(base)) && !originalsCharged[base]) {
          origExtra = rulesRound2(origExtra + saved.prepaid);
          originalsCharged[base] = true;
          plan.notes.push(code + '：原單預付的運費 $' + saved.prepaid + ' 加到 L 欄（原單第一個出貨的商品）。');
        }
        if (saved.fee === '' || saved.fee == null) plan.warnings.push(code + '：原單記錄時沒有讀到手續費，N 欄留空。');
        else origFeeN = rulesNum(saved.fee);
      } else if (original) {
        var of = rulesOrderFacts(original, options);
        var origLine = rulesFindOriginalLine(of, code, pre);
        var extrasShare = rulesExtrasShare(of, origLine);
        if (of.extras > 0 && !origLine) plan.warnings.push(code + '：在原單 ' + base + ' 找不到對應的商品，原單的保險沒有加到 L 欄。');
        if (extrasShare) {
          origExtra = rulesRound2(origExtra + extrasShare);
          plan.notes.push(code + '：原單的保險等服務費 $' + of.extras + ' 平分給 ' + of.pre.length + ' 個預購商品，這一項加 $' + extrasShare + ' 到 L 欄。');
        }
        var alreadyShipped = ctx.baseShipped ? ctx.baseShipped(base) : false;
        if (!of.stock.length && of.shippingPaid > 0 && !alreadyShipped && !originalsCharged[base]) {
          origExtra = rulesRound2(origExtra + of.shippingPaid);
          originalsCharged[base] = true;
          plan.notes.push(code + '：原單預付的運費 $' + of.shippingPaid + ' 加到 L 欄（原單第一個出貨的商品）。');
        }
        var weights = rulesPaidWeights(of);
        if (of.fees.unknown.length) {
          plan.warnings.push(code + '：原單 ' + base + ' 讀不到手續費，N 欄留空。');
        } else if (!origLine) {
          plan.warnings.push(code + '：在原單 ' + base + ' 找不到對應的商品，N 欄留空。');
        } else {
          var share = weights.total > 0 ? (rulesLineTotal(origLine) + extrasShare) / weights.total : 0;
          origFeeN = rulesRound2(of.fees.total * share);
        }
      } else {
        plan.warnings.push(code + '：讀不到原單 ' + base + '，N 欄（原單手續費）留空，原單的保險／運費也沒有加到 L 欄。');
      }

      var values = {
        A: code,
        B: pre.C,
        C: wasBackorder ? 'Shopify' : 'PO-Shopify',
        D: pre.D,
        J: qty,
        K: rulesRound2(unitDue * qty),
        L: rulesRound2((first ? draftExtra : 0) + origExtra),
        N: origFeeN,
        O: first ? draftFee : 0
      };
      var colors = {};
      if (facts.isPickup) { values.M = 0; colors.M = RULES_COLORS.cyan; }
      else if (!first || chargesOnStock) { values.M = 0; colors.M = RULES_COLORS.gray; }
      else values.M = '';
      plan.actions.push({
        op: 'appendShipped', year: year, region: popwRegion, key: code,
        label: year + '已出貨 ' + popwRegion + '（POPW）', values: values, colors: colors
      });

      var paidBefore = rulesNum(pre.Nvalue != null ? pre.Nvalue : pre.N);
      var paidAfter = rulesRound2(paidBefore + linePaid);
      var due = rulesRound2(unitDue * qty);
      var diff = rulesRound2(due - paidAfter);
      plan.actions.push({
        op: 'updatePreorder', key: code, row: pre.row, label: '預購（第 ' + pre.row + ' 列）',
        set: { B: 'Y' }, addPaid: linePaid, paidBefore: paidBefore, paidAfter: paidAfter, due: due, diff: diff,
        rowColor: diff === 0 ? RULES_COLORS.green : RULES_COLORS.orange
      });
      if (diff !== 0) {
        plan.warnings.push(code + '：應付 $' + due + '，已付 $' + paidAfter + '，差 $' + diff + '。預購表這一列會標橘色並寄信通知。');
      }
      return;
    }

    shipped = shipped || (ctx.findShipped ? ctx.findShipped(code) : null);
    if (shipped) {
      if (!first) {
        plan.notes.push(code + '：PW 商品出貨（第 ' + (i + 1) + ' 項），運費和手續費記在第一項，這一列不用改。');
        return;
      }
      var oldL = rulesNum(shipped.L);
      // 出貨單沒有運費也沒有手續費要加（例如自取）→ 原本那一列不用改，算已登記
      if (!draftExtra && !rulesNum(draftFee)) {
        plan.duplicates = plan.duplicates || [];
        plan.duplicates.push(code);
        plan.errors.push(code + ' 已經記錄在「' + shipped.tab + '」第 ' + shipped.row + ' 列（出貨單沒有運費和手續費要加）。');
        return;
      }
      // L 欄已經有出貨單的運費（PW 存放時 L 是 0 或只有保險）→ 應該已經處理過
      if (draftExtra > 0 && oldL >= draftExtra) {
        plan.duplicates = plan.duplicates || [];
        plan.duplicates.push(code);
        plan.errors.push(code + ' 已經記錄在「' + shipped.tab + '」第 ' + shipped.row + ' 列（L 欄已經有 $' + oldL + '，出貨單運費 $' + draftExtra + '）。');
        return;
      }
      if (oldL) plan.warnings.push(code + '：已出貨表 L 欄原本是 $' + oldL + '，會加上出貨單的 $' + draftExtra + '。');
      if (rulesNum(shipped.O)) plan.warnings.push(code + '：已出貨表 O 欄原本是 $' + shipped.O + '，會改成出貨單的手續費。');
      plan.actions.push({
        op: 'updateShipped', key: code, file: shipped.file, tab: shipped.tab, row: shipped.row,
        label: shipped.tab + '（第 ' + shipped.row + ' 列，PW 出貨）',
        set: { L: rulesRound2(oldL + draftExtra), O: draftFee }
      });
      if (linePaid) plan.warnings.push(code + '：PW 商品出貨單上的金額 $' + linePaid + ' 沒有記錄，請確認。');
      return;
    }

    plan.errors.push(code + '：預購表和已出貨表都找不到這個單號。');
  });
}

// 批次清單用：這張單目前的狀態
//   waiting：等客人付清／等 INT 運費報價（不寫入，之後再掃描）
//   done：要新增的列都已經在試算表裡（已登記）
//   partial：有些已登記、有些沒有，要人工處理
//   error：有錯誤；warn：有警告要人確認；ready：可以直接寫；nothing：沒有要記錄的東西
function classifyPlan(plan) {
  if (plan.waiting) return 'waiting';
  var dups = plan.duplicates || [];
  if (dups.length) {
    // 還有沒登記過的列要寫 → 部分已登記
    var remaining = plan.actions.filter(function (a) {
      return /^(appendShipped|appendPreorder|appendPW|updatePreorder|updateShipped)$/.test(a.op) && dups.indexOf(a.key) < 0;
    });
    var others = plan.errors.length - dups.length;
    return !remaining.length && others === 0 ? 'done' : 'partial';
  }
  if (plan.errors.length) return 'error';
  if (!plan.actions.some(function (a) { return !a.skip; })) return 'nothing';
  if (plan.warnings.length) return 'warn';
  return 'ready';
}

function rulesFindOriginalLine(of, code, pre) {
  var upc = rulesUpcKey(pre && pre.I);
  var byCode = of.counted.filter(function (l) { return l.code === code; })[0];
  if (upc) {
    var byUpc = of.pre.filter(function (l) { return rulesUpcKey(rulesUpc(l)) === upc; });
    if (byUpc.length === 1) return byUpc[0];
    if (byUpc.length > 1 && byCode && byUpc.indexOf(byCode) >= 0) return byCode;
  }
  return byCode || null;
}

if (typeof module !== 'undefined') {
  module.exports = {
    RULES_COLORS: RULES_COLORS, RULES_RE: RULES_RE, planOrder: planOrder, classifyLine: classifyLine,
    rulesOrderFacts: rulesOrderFacts, rulesAllocate: rulesAllocate, rulesCleanName: rulesCleanName,
    rulesUpcKey: rulesUpcKey, rulesRound2: rulesRound2, rulesFeeInfo: rulesFeeInfo, classifyPlan: classifyPlan
  };
}
