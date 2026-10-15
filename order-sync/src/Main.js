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
    .addItem('開啟逐筆處理', 'openReviewDialog')
    .addSeparator()
    .addItem('設定 Shopify 金鑰', 'promptShopifySecrets')
    .addItem('測試 Shopify 連線（看一張訂單的原始資料）', 'testShopifyConnection')
    .addItem('建立／補齊「設定」和「紀錄」分頁', 'setupTabs')
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
    log.getRange(1, 1, 1, 7).setValues([['時間', '單號', '摘要', '結果', '寫入位置', '警告', '執行者']]).setFontWeight('bold');
    log.setFrozenRows(1);
  }
  SpreadsheetApp.getUi().alert('「設定」和「紀錄」分頁已建立。請在「設定」填好試算表 ID，再用選單「設定 Shopify 金鑰」。');
}

function getSettings() {
  var out = {};
  SETTINGS_DEFAULTS.forEach(function (d) { out[d[0]] = d[1]; });
  var s = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SETTINGS_TAB);
  if (!s || s.getLastRow() < 2) return out;
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
  SpreadsheetApp.getUi().showModelessDialog(html, '訂單逐筆處理');
}

// ---- 給 Dialog.html 呼叫的函式 ----

function buildPlan_(orderName) {
  var settings = getSettings();
  var order = shopifyFetchOrder(orderName);
  if (!order) throw new Error('Shopify 找不到單號 ' + orderName);
  var session = new SheetsSession(settings, function (base) { return shopifyFetchOrder(base); });
  var plan = planOrder(order, session.context(order), { numbering: settings.NUMBERING || 'stockFirst' });
  if (order.test) plan.errors.push('這是測試訂單（test order），不處理。');
  if (!plan.errors.length) session.resolve(plan);
  var prior = logEntriesFor_(order.name);
  if (prior.length) plan.warnings.unshift('「紀錄」分頁顯示這張單在 ' + prior.join('、') + ' 寫入過。');
  return { order: order, plan: plan, session: session };
}

function fingerprint_(plan) {
  var core = plan.actions.map(function (a) {
    return [a.op, a.key, a.values, a.set, a.addPaid, a.rowColor, a.skip ? 1 : 0, a.colors];
  });
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, JSON.stringify(core), Utilities.Charset.UTF_8);
  return Utilities.base64Encode(bytes);
}

function apiPreview(orderName) {
  var built = buildPlan_(orderName);
  return {
    order: {
      name: built.order.name, date: built.order.date, source: built.order.source, status: built.order.financialStatus,
      shippingTitle: built.order.shippingTitle, shippingCharged: built.order.shippingCharged, country: built.order.country,
      lines: built.order.lines.map(function (l) { return { name: l.name, qty: l.qty, unitPrice: l.unitPrice, discount: l.discount, sku: l.sku, barcode: l.barcode, kind: classifyLine(l, built.order) }; }),
      payments: built.order.payments
    },
    plan: built.plan,
    fingerprint: fingerprint_(built.plan)
  };
}

function apiWrite(orderName, fingerprint) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var built = buildPlan_(orderName);
    var plan = built.plan;
    if (plan.errors.length) return { ok: false, message: '有錯誤，沒有寫入：\n' + plan.errors.join('\n') };
    if (fingerprint_(plan) !== fingerprint) return { ok: false, changed: true, message: '訂單或試算表在預覽之後有變動，請重新預覽再寫入。' };
    var written = built.session.execute(plan);
    var alerts = plan.actions.filter(function (a) { return a.op === 'updatePreorder' && a.diff !== 0; });
    var settings = getSettings();
    if (alerts.length && settings.ALERT_EMAIL) {
      MailApp.sendEmail(settings.ALERT_EMAIL, '[預購] ' + plan.order + ' 應付和已付對不起來',
        alerts.map(function (a) { return a.key + '：應付 $' + a.due + '，已付 $' + a.paidAfter + '，差 $' + a.diff + '（預購表第 ' + a.row + ' 列已標橘色）'; }).join('\n'));
    }
    appendLog_(plan, written, 'OK');
    return { ok: true, written: written, emailed: alerts.length > 0 && !!settings.ALERT_EMAIL };
  } catch (e) {
    try { appendLog_({ order: orderName, summary: '', warnings: [] }, [], '失敗：' + e.message); } catch (ignore) {}
    return { ok: false, message: '寫入失敗：' + e.message + '\n（已寫入的部分請看「紀錄」分頁和試算表，必要時手動修正。）' };
  } finally {
    lock.releaseLock();
  }
}

function apiRecent() {
  var orders = shopifyRecentOrders(25);
  var done = {};
  var log = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LOG_TAB);
  if (log && log.getLastRow() > 1) {
    log.getRange(2, 2, log.getLastRow() - 1, 3).getValues().forEach(function (r) {
      if (String(r[2]).indexOf('OK') === 0) done[String(r[0]).trim()] = true;
    });
  }
  orders.forEach(function (o) { o.done = !!done[o.name]; });
  return orders;
}

function logEntriesFor_(name) {
  var log = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LOG_TAB);
  if (!log || log.getLastRow() < 2) return [];
  var tz = getSettings().TIMEZONE || 'America/Vancouver';
  return log.getRange(2, 1, log.getLastRow() - 1, 4).getValues().filter(function (r) {
    return String(r[1]).trim() === name && String(r[3]).indexOf('OK') === 0;
  }).map(function (r) { return r[0] instanceof Date ? Utilities.formatDate(r[0], tz, 'yyyy-MM-dd HH:mm') : String(r[0]); });
}

function appendLog_(plan, written, result) {
  var log = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LOG_TAB);
  if (!log) return;
  log.appendRow([
    new Date(), plan.order, plan.summary || '', result,
    written.map(function (w) { return w.tab + '!' + w.row; }).join('\n'),
    (plan.warnings || []).join('\n'),
    Session.getActiveUser().getEmail()
  ]);
}
