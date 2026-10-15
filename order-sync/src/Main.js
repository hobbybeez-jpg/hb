// Main.js — 選單、設定分頁、紀錄分頁、逐筆處理視窗的後端
//
// 這個 Apps Script 綁在一個「另外新建」的 Google Sheet（訂單自動化控制台），
// 用 openById 讀寫 庫存/出貨/預購、各年份已出貨、PW/PO，不會動到那些檔案裡原本的 Apps Script。

var SETTINGS_TAB = '設定';
var LOG_TAB = '紀錄';

var SETTINGS_DEFAULTS = [
  ['SHOPIFY_STORE', '', '你的商店.myshopify.com'],
  ['SHOPIFY_API_VERSION', '2026-07', 'Shopify Admin API 版本'],
  ['MAIN_SHEET_ID', '', '庫存/出貨/預購（今年的已出貨、預購、訂貨都在這裡）的試算表 ID：網址 /d/ 和 /edit 中間那一段'],
  ['POPW_SHEET_ID', '', 'PW/PO（Private Warehouse / PO Arrival）試算表 ID'],
  ['POPW_TAB', 'PO/PW', 'PW/PO 試算表裡記錄 PW 的分頁名稱（要和分頁標籤一字不差）'],
  ['YEAR_SHEET_2025', '', '2025 年已出貨的獨立試算表 ID（POPW 出貨的原單是 2025 年時寫到這裡）'],
  ['YEAR_SHEET_2024', '', '2024 年已出貨的獨立試算表 ID'],
  ['ALERT_EMAIL', '', '預購應付和已付對不起來時寄信到這裡'],
  ['TIMEZONE', 'America/Vancouver', '訂單日期用哪個時區'],
  ['M_DEFAULT_COLOR', '#ffff00', '已出貨 M 欄沒有特別顏色時的底色（目前試算表是黃色）'],
  ['NUMBERING', 'stockFirst', 'stockFirst＝現貨先編號、預購後編號；shopify＝照 Shopify 訂單的商品順序']
];

function onOpen() {
  SpreadsheetApp.getUi().createMenu('訂單自動化')
    .addItem('開啟逐筆／批次處理', 'openReviewDialog')
    .addSeparator()
    .addItem('設定 Shopify 金鑰', 'promptShopifySecrets')
    .addItem('測試 Shopify 連線（看一張訂單的原始資料）', 'testShopifyConnection')
    .addItem('建立／補齊「設定」「紀錄」「原單資料」分頁', 'setupTabs')
    .addToUi();
}

function setupTabs() {
  var book = SpreadsheetApp.getActiveSpreadsheet();
  var s = book.getSheetByName(SETTINGS_TAB) || book.insertSheet(SETTINGS_TAB);
  if (s.getLastRow() === 0) s.getRange(1, 1, 1, 3).setValues([['設定', '值', '說明']]).setFontWeight('bold');
  var existing = s.getLastRow() > 1 ? s.getRange(2, 1, s.getLastRow() - 1, 1).getValues().map(function (r) { return r[0]; }) : [];
  SETTINGS_DEFAULTS.forEach(function (d) {
    if (existing.indexOf(d[0]) < 0) s.appendRow(d);
  });
  // 值一律當文字，避免 2026-07 被轉成日期
  s.getRange(2, 2, Math.max(s.getLastRow() - 1, 1), 1).setNumberFormat('@');
  s.setColumnWidth(1, 180); s.setColumnWidth(2, 360); s.setColumnWidth(3, 520);
  var log = book.getSheetByName(LOG_TAB) || book.insertSheet(LOG_TAB);
  if (log.getLastRow() === 0) {
    log.getRange(1, 1, 1, 8).setValues([['時間', '單號', '摘要', '結果', '寫入位置', '警告', '執行者', '寫入的試算表']]).setFontWeight('bold');
    log.setFrozenRows(1);
  } else if (!log.getRange(1, 8).getValue()) {
    log.getRange(1, 8).setValue('寫入的試算表').setFontWeight('bold');
  }
  var orig = book.getSheetByName(ORIGINALS_TAB) || book.insertSheet(ORIGINALS_TAB);
  if (orig.getLastRow() === 0) {
    orig.getRange(1, 1, 1, 6).setValues([['單號', '原單', '保險等服務費（這一項分到的）', '原單手續費（這一項分到的）', '預付運費（整張原單）', '原單日期']]).setFontWeight('bold');
    orig.setFrozenRows(1);
  }
  SpreadsheetApp.getUi().alert('「設定」、「紀錄」、「原單資料」分頁已建立。請在「設定」填好試算表 ID，再用選單「設定 Shopify 金鑰」。');
}

var SETTINGS_MEMO_ = null;

function getSettings() {
  if (SETTINGS_MEMO_) return SETTINGS_MEMO_;
  var out = {};
  SETTINGS_DEFAULTS.forEach(function (d) { out[d[0]] = d[1]; });
  var s = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SETTINGS_TAB);
  if (!s || s.getLastRow() < 2) { SETTINGS_MEMO_ = out; return out; }
  var tz = Session.getScriptTimeZone();
  s.getRange(2, 1, s.getLastRow() - 1, 2).getValues().forEach(function (r) {
    var key = String(r[0] || '').trim();
    if (!key) return;
    var v = r[1];
    // 試算表會把 2026-07 自動轉成日期
    if (v instanceof Date) v = Utilities.formatDate(v, tz, key === 'SHOPIFY_API_VERSION' ? 'yyyy-MM' : 'yyyy-MM-dd');
    v = String(v == null ? '' : v).trim();
    if (v !== '') out[key] = v;
  });
  // 允許直接貼整個網址
  Object.keys(out).forEach(function (k) {
    if (/_SHEET(_ID|_\d{4})$/.test(k) || k === 'MAIN_SHEET_ID' || k === 'POPW_SHEET_ID') {
      var m = /\/d\/([a-zA-Z0-9_-]+)/.exec(out[k]);
      if (m) out[k] = m[1];
    }
  });
  SETTINGS_MEMO_ = out;
  return out;
}

function promptShopifySecrets() {
  var ui = SpreadsheetApp.getUi();
  var props = PropertiesService.getScriptProperties();
  var a = ui.prompt('Shopify 金鑰', 'Dev Dashboard app 的 Client ID（舊式 custom app 請留空，下一步貼 Admin API token）', ui.ButtonSet.OK_CANCEL);
  if (a.getSelectedButton() !== ui.Button.OK) return;
  var clientId = a.getResponseText().trim();
  if (clientId) {
    var b = ui.prompt('Shopify 金鑰', 'Client secret', ui.ButtonSet.OK_CANCEL);
    if (b.getSelectedButton() !== ui.Button.OK) return;
    props.setProperties({ SHOPIFY_CLIENT_ID: clientId, SHOPIFY_CLIENT_SECRET: b.getResponseText().trim() });
    props.deleteProperty('SHOPIFY_ADMIN_TOKEN');
  } else {
    var c = ui.prompt('Shopify 金鑰', 'Admin API access token（shpat_…）', ui.ButtonSet.OK_CANCEL);
    if (c.getSelectedButton() !== ui.Button.OK) return;
    props.setProperty('SHOPIFY_ADMIN_TOKEN', c.getResponseText().trim());
    props.deleteProperty('SHOPIFY_CLIENT_ID');
    props.deleteProperty('SHOPIFY_CLIENT_SECRET');
  }
  CacheService.getScriptCache().remove('shopify_token');
  ui.alert('已儲存（存在 Apps Script 的指令碼屬性，不會出現在試算表裡）。');
}

function testShopifyConnection() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt('測試 Shopify 連線', '輸入一個單號（例如 CA53126D）', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  var raw = shopifyFetchOrderRaw(r.getResponseText());
  if (!raw) { ui.alert('Shopify 找不到這張單。'); return; }
  (raw.lineItems.nodes || []).forEach(function (li) { if (li.product && li.product.descriptionHtml) li.product.descriptionHtml = li.product.descriptionHtml.slice(0, 200) + '…'; });
  var html = HtmlService.createHtmlOutput('<pre style="font-size:11px;white-space:pre-wrap">' +
    JSON.stringify(raw, null, 2).replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</pre>').setWidth(900).setHeight(650);
  ui.showModalDialog(html, 'Shopify 原始資料：' + raw.name);
}

function openReviewDialog() {
  var html = HtmlService.createHtmlOutputFromFile('Dialog').setWidth(1150).setHeight(760);
  SpreadsheetApp.getUi().showModelessDialog(html, '訂單逐筆／批次處理');
}

// ---- 給 Dialog.html 呼叫的函式 ----

function newSession_() {
  return new SheetsSession(getSettings(), function (base) { return shopifyFetchOrder(base); }, SpreadsheetApp.getActiveSpreadsheet());
}

function planFor_(order, session) {
  var settings = getSettings();
  var plan = planOrder(order, session.context(order), { numbering: settings.NUMBERING || 'stockFirst' });
  if (order.test) plan.errors.push('這是測試訂單（test order），不處理。');
  if (!plan.errors.length) session.resolve(plan);
  var prior = logEntriesFor_(order.name);
  if (prior.length) plan.warnings.unshift('「紀錄」分頁顯示這張單在 ' + prior.join('、') + ' 寫入過。');
  plan.status = classifyPlan(plan);
  return plan;
}

function buildPlan_(orderName, session) {
  var order = shopifyFetchOrder(orderName);
  if (!order) throw new Error('Shopify 找不到單號 ' + orderName);
  session = session || newSession_();
  return { order: order, plan: planFor_(order, session), session: session };
}

function fingerprint_(plan) {
  var core = plan.actions.map(function (a) {
    // 訂貨表：同一批前面的單剛新增過同一個 UPC 時會變成「不新增」，這是正常的，不算內容有變
    var skip = a.op === 'ensureOrdering' ? 0 : (a.skip ? 1 : 0);
    return [a.op, a.key, a.values, a.set, a.addPaid, a.rowColor, skip, a.colors];
  });
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, JSON.stringify(core), Utilities.Charset.UTF_8);
  return Utilities.base64Encode(bytes);
}

function previewPayload_(order, plan) {
  return {
    order: {
      name: order.name, date: order.date, source: order.source, status: order.financialStatus,
      shippingTitle: order.shippingTitle, shippingCharged: order.shippingCharged, country: order.country,
      lines: order.lines.map(function (l) { return { name: l.name, qty: l.qty, unitPrice: l.unitPrice, discount: l.discount, sku: l.sku, barcode: l.barcode, kind: classifyLine(l, order) }; }),
      payments: order.payments
    },
    plan: plan,
    fingerprint: fingerprint_(plan)
  };
}

function apiPreview(orderName) {
  var built = buildPlan_(orderName);
  return previewPayload_(built.order, built.plan);
}

// 寫入一張已經算好 plan 的單。partial＝寫到一半出錯（試算表可能有寫了一部分的列）
function writePlan_(built, fingerprint) {
  var plan = built.plan;
  if (plan.errors.length) return { ok: false, message: '有錯誤，沒有寫入：\n' + plan.errors.join('\n') };
  if (fingerprint_(plan) !== fingerprint) return { ok: false, changed: true, message: '訂單或試算表在預覽之後有變動，請重新預覽再寫入。' };
  try {
    var written = built.session.execute(plan);
  } catch (e) {
    try { appendLog_(plan, [], '失敗：' + e.message); } catch (ignore) {}
    return { ok: false, partial: true, message: '寫入失敗：' + e.message + '\n（已寫入的部分請看「紀錄」分頁和試算表，必要時手動修正。）' };
  }
  var alerts = plan.actions.filter(function (a) { return a.op === 'updatePreorder' && a.diff !== 0; });
  var settings = getSettings();
  if (alerts.length && settings.ALERT_EMAIL) {
    MailApp.sendEmail(settings.ALERT_EMAIL, '[預購] ' + plan.order + ' 應付和已付對不起來',
      alerts.map(function (a) { return a.key + '：應付 $' + a.due + '，已付 $' + a.paidAfter + '，差 $' + a.diff + '（預購表第 ' + a.row + ' 列已標橘色）'; }).join('\n'));
  }
  appendLog_(plan, written, 'OK');
  return { ok: true, written: written, emailed: alerts.length > 0 && !!settings.ALERT_EMAIL };
}

function apiWrite(orderName, fingerprint) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return writePlan_(buildPlan_(orderName), fingerprint);
  } catch (e) {
    return { ok: false, message: '寫入失敗：' + e.message };
  } finally {
    lock.releaseLock();
  }
}

// ---- 批次：找出還沒登記的單、一次寫入 ----

var BATCH_TIME_LIMIT_MS = 270000; // Apps Script 一次最多 6 分鐘，留一點餘裕

// 掃描 fromDate～toDate 的訂單（從 start 開始）。時間快到時回傳 next，畫面會用 next 再呼叫一次
function apiScan(fromDate, toDate, start) {
  var began = Date.now();
  var list = shopifyListOrders(fromDate, toDate);
  var session = null;
  var items = [];
  var i = start || 0;
  for (; i < list.length; i++) {
    if (Date.now() - began > BATCH_TIME_LIMIT_MS) break;
    var o = list[i];
    var item = { name: o.name, createdAt: o.createdAt, source: o.source };
    if (o.cancelled || o.test) {
      item.status = 'skip';
      item.note = o.cancelled ? '已取消' : '測試訂單';
    } else if (logEntriesFor_(o.name).length) {
      item.status = 'done';
      item.note = '「紀錄」分頁顯示已寫入過';
    } else {
      try {
        session = session || newSession_();
        var order = shopifyFetchOrder(o.name);
        if (!order) throw new Error('Shopify 找不到這張單');
        var saved = session.saveRows();
        var plan = planFor_(order, session);
        session.restoreRows(saved);
        var payload = previewPayload_(order, plan);
        item.status = plan.status;
        item.summary = plan.summary;
        item.note = (plan.errors[0] || plan.warnings[0] || '');
        item.preview = payload;
        item.fingerprint = payload.fingerprint;
      } catch (e) {
        item.status = 'error';
        item.note = e.message;
      }
    }
    items.push(item);
  }
  return { items: items, next: i < list.length ? i : null, total: list.length };
}

// 依序寫入多張單。items：[{ name, fingerprint }]（照時間先後）。時間快到時回傳 next
function apiWriteBatch(items, start) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  var began = Date.now();
  var results = [];
  var i = start || 0;
  try {
    var session = newSession_();
    for (; i < items.length; i++) {
      if (Date.now() - began > BATCH_TIME_LIMIT_MS) break;
      var saved = session.saveRows();
      var res;
      try {
        res = writePlan_(buildPlan_(items[i].name, session), items[i].fingerprint);
      } catch (e) {
        res = { ok: false, message: e.message };
      }
      if (!res.ok && !res.partial) session.restoreRows(saved);
      results.push({ name: items[i].name, ok: res.ok, message: res.message || '', written: res.written || [], emailed: !!res.emailed });
      if (res.partial) { i++; return { results: results, next: null, stopped: true }; }
    }
    return { results: results, next: i < items.length ? i : null };
  } finally {
    lock.releaseLock();
  }
}

function apiRecent() {
  var orders = shopifyRecentOrders(25);
  orders.forEach(function (o) { o.done = logEntriesFor_(o.name).length > 0; });
  return orders;
}

var LOG_MEMO_ = null;

function logRows_() {
  if (!LOG_MEMO_) {
    var log = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LOG_TAB);
    LOG_MEMO_ = log && log.getLastRow() > 1 ? log.getRange(2, 1, log.getLastRow() - 1, 8).getValues() : [];
  }
  return LOG_MEMO_;
}

// 這張單寫入「目前設定的庫存/出貨/預購」的紀錄（測試時寫到副本的紀錄，換成正式檔後就不算）
function logEntriesFor_(name) {
  var settings = getSettings();
  var tz = settings.TIMEZONE || 'America/Vancouver';
  return logRows_().filter(function (r) {
    return String(r[1]).trim() === name && String(r[3]).indexOf('OK') === 0 && String(r[7]).trim() === settings.MAIN_SHEET_ID;
  }).map(function (r) { return r[0] instanceof Date ? Utilities.formatDate(r[0], tz, 'yyyy-MM-dd HH:mm') : String(r[0]); });
}

function appendLog_(plan, written, result) {
  var log = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LOG_TAB);
  if (!log) return;
  var row = [
    new Date(), plan.order, plan.summary || '', result,
    written.map(function (w) { return w.tab + '!' + w.row; }).join('\n'),
    (plan.warnings || []).join('\n'),
    Session.getActiveUser().getEmail(),
    getSettings().MAIN_SHEET_ID || ''
  ];
  if (LOG_MEMO_) LOG_MEMO_.push(row);
  log.appendRow(row);
}
