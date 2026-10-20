// Auto.js — 自動執行：每天在「設定」AUTO_HOURS 的時間（例如 9,21）掃描上次之後有更新的訂單，
// 「可寫入」的直接寫，其他（需確認、錯誤、部分已登記）寄信給 ALERT_EMAIL，到逐筆／批次畫面人工處理。
//
// 指令碼屬性：
//   AUTO_CURSOR        這個時間之後有更新的訂單還沒看過（照更新時間處理，時間不夠時停在下一張）
//   AUTO_WINDOW_START  這一輪的起點：在這之前下單的算舊單（之前的輪次處理過，只有之後有新付款才處理）
//   AUTO_LAST          上次執行的摘要（選單「自動執行狀態」顯示）

var AUTO_TIME_LIMIT_MS = 240000;  // 一次最多 6 分鐘，留時間寄信和排下一段
var AUTO_HANDLERS = ['autoRun', 'autoContinue'];

function autoProps_() {
  return PropertiesService.getScriptProperties();
}

function autoHours_() {
  var hours = String(getSettings().AUTO_HOURS || '').split(/[^0-9]+/).filter(String).map(Number);
  if (!hours.length || hours.some(function (h) { return !(h >= 0 && h <= 23 && h === Math.floor(h)); })) {
    throw new Error('「設定」分頁的 AUTO_HOURS 要像 9,21（0～23 點，用逗號分開）。');
  }
  return hours;
}

function autoTriggers_(handlers) {
  return ScriptApp.getProjectTriggers().filter(function (t) { return (handlers || AUTO_HANDLERS).indexOf(t.getHandlerFunction()) >= 0; });
}

function autoDeleteTriggers_(handlers) {
  autoTriggers_(handlers).forEach(function (t) { ScriptApp.deleteTrigger(t); });
}

// 選單：開啟自動執行（重新建立排程，改了 AUTO_HOURS 之後再按一次）
function autoEnable() {
  var ui = SpreadsheetApp.getUi();
  var tz = getSettings().TIMEZONE || 'America/Vancouver';
  var hours;
  try { hours = autoHours_(); } catch (e) { ui.alert(e.message); return; }
  var props = autoProps_();
  if (!props.getProperty('AUTO_CURSOR')) {
    var today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
    var res = ui.prompt('開啟自動執行', '從哪一天開始自動處理？（yyyy-MM-dd，留空＝今天 ' + today + '）\n這天之前下單的只有之後有新付款（例如 INT 補運費）才處理。', ui.ButtonSet.OK_CANCEL);
    if (res.getSelectedButton() !== ui.Button.OK) return;
    var day = res.getResponseText().trim() || today;
    var start = /^\d{4}-\d{2}-\d{2}$/.test(day) ? Utilities.parseDate(day + ' 00:00:00', tz, 'yyyy-MM-dd HH:mm:ss') : null;
    if (!start || isNaN(start.getTime())) { ui.alert('日期格式不對：' + day); return; }
    props.setProperties({ AUTO_CURSOR: start.toISOString(), AUTO_WINDOW_START: start.toISOString() });
  }
  autoDeleteTriggers_();
  hours.forEach(function (h) {
    ScriptApp.newTrigger('autoRun').timeBased().everyDays(1).atHour(h).nearMinute(0).inTimezone(tz).create();
  });
  ui.alert('已開啟自動執行：每天 ' + hours.map(function (h) { return h + ':00'; }).join('、') + '（' + tz + '，前後 15 分鐘內）。\n' +
    '可寫入的單會直接寫入；需要人工確認的單會寄信到 ' + (getSettings().ALERT_EMAIL || '（「設定」的 ALERT_EMAIL 還沒填，不會寄信）') + '。\n' +
    '目前從 ' + autoFormat_(props.getProperty('AUTO_CURSOR')) + ' 之後有更新的訂單開始。');
}

function autoDisable() {
  autoDeleteTriggers_();
  SpreadsheetApp.getUi().alert('已關閉自動執行。之後再開啟會從上次停下的地方繼續。');
}

// 選單：立刻執行一次（和排程一樣，會更新進度）
function autoRunNow() {
  var ui = SpreadsheetApp.getUi();
  if (!autoProps_().getProperty('AUTO_CURSOR')) { ui.alert('請先用「開啟自動執行」設定起始日。'); return; }
  var r = autoExecute_(false);
  ui.alert(r.busy ? '其他寫入正在進行，請稍後再試。' : autoSummaryText_(r));
}

function autoStatus() {
  var props = autoProps_();
  var hours = autoTriggers_(['autoRun']).length;
  var last = props.getProperty('AUTO_LAST');
  SpreadsheetApp.getUi().alert(
    (hours ? '自動執行：開啟（每天 ' + hours + ' 次）' : '自動執行：關閉') + '\n' +
    '下次從 ' + (props.getProperty('AUTO_CURSOR') ? autoFormat_(props.getProperty('AUTO_CURSOR')) : '（還沒設定）') + ' 之後有更新的訂單開始\n\n' +
    '上次執行：' + (last ? autoSummaryText_(JSON.parse(last)) : '（還沒執行過）'));
}

// 排程觸發
function autoRun() {
  autoExecute_(true);
}

// 上一次時間不夠，1 分鐘後接著做
function autoContinue() {
  autoDeleteTriggers_(['autoContinue']);
  autoExecute_(true);
}

function autoScheduleContinue_(ms) {
  autoDeleteTriggers_(['autoContinue']);
  ScriptApp.newTrigger('autoContinue').timeBased().after(ms).create();
}

function autoExecute_(fromTrigger) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    if (fromTrigger) autoScheduleContinue_(5 * 60 * 1000);
    return { busy: true };
  }
  var began = Date.now();
  var r = { at: new Date().toISOString(), written: [], attention: [], waiting: 0, done: 0, skipped: 0, more: false, error: '' };
  try {
    autoProcess_(r, began);
  } catch (e) {
    r.error = e.message;
  } finally {
    lock.releaseLock();
  }
  if (r.more) {
    try { autoScheduleContinue_(60 * 1000); } catch (e) { r.error = r.error || ('排不了下一段：' + e.message); }
  }
  // 時間不夠分好幾段做時，結果先暫存，最後一段做完再一起寄一封信
  var cache = CacheService.getScriptCache();
  var pending = cache.get('auto_pending');
  if (pending) {
    try {
      var p = JSON.parse(pending);
      r.written = p.written.concat(r.written);
      r.attention = p.attention.concat(r.attention);
      ['waiting', 'done', 'skipped'].forEach(function (k) { r[k] += p[k] || 0; });
      r.at = p.at;
    } catch (e) {}
  }
  if (r.more && !r.error) {
    try { cache.put('auto_pending', JSON.stringify(r), 21600); } catch (e) { autoEmail_(r); }
  } else {
    cache.remove('auto_pending');
    autoEmail_(r);
  }
  autoProps_().setProperty('AUTO_LAST', JSON.stringify(r));
  return r;
}

function autoProcess_(r, began) {
  var props = autoProps_();
  var cursor = props.getProperty('AUTO_CURSOR');
  if (!cursor) throw new Error('還沒設定自動處理的起始日，請用選單「開啟自動執行」。');
  var windowStart = new Date(props.getProperty('AUTO_WINDOW_START') || cursor);
  var to = new Date();
  var list = shopifyListUpdated(new Date(cursor), to, windowStart);
  var session = newSession_();
  session.warmUp(Number(Utilities.formatDate(to, getSettings().TIMEZONE || 'America/Vancouver', 'yyyy')));
  for (var i = 0; i < list.length; i++) {
    if (Date.now() - began > AUTO_TIME_LIMIT_MS) {
      autoAdvance_(props, list, i, to);
      r.more = true;
      return;
    }
    var o = list[i];
    var pre = listPrecheck_(o);
    if (pre) {
      if (pre.status === 'done') r.done++; else r.skipped++;
      continue;
    }
    var saved = session.saveRows();
    try {
      var built = buildPlan_(o.name, session);
      var plan = built.plan;
      if (plan.status === 'ready') {
        var w = writePlan_(built, fingerprint_(plan));
        if (w.ok) {
          r.written.push({ name: o.name, summary: plan.summary, emailed: !!w.emailed });
        } else if (w.partial) {
          // 寫到一半失敗：試算表可能有一部分的列，先停下來等人工處理，其他單下次再做
          r.attention.push({ name: o.name, status: 'partial-write', note: w.message });
          r.error = o.name + ' 寫到一半失敗，這次先停止，其他訂單下次排程再處理。';
          autoAdvance_(props, list, i + 1, to);
          return;
        } else {
          session.restoreRows(saved);
          r.attention.push({ name: o.name, status: 'error', note: w.message });
        }
      } else {
        session.restoreRows(saved);
        if (plan.status === 'waiting') r.waiting++;
        else if (plan.status === 'done') r.done++;
        else if (plan.status === 'nothing') r.skipped++;
        else r.attention.push({ name: o.name, status: plan.status, summary: plan.summary, note: plan.errors[0] || plan.warnings[0] || '' });
      }
    } catch (e) {
      session.restoreRows(saved);
      r.attention.push({ name: o.name, status: 'error', note: e.message });
    }
  }
  autoAdvance_(props, list, list.length, to);
}

// 下次從第 next 張（的更新時間）繼續，這一輪的起點不變；全部做完 → 下一輪從這次開始的時間接著
function autoAdvance_(props, list, next, to) {
  if (next < list.length) props.setProperty('AUTO_CURSOR', list[next].updatedAt);
  else props.setProperties({ AUTO_CURSOR: to.toISOString(), AUTO_WINDOW_START: to.toISOString() });
}

var AUTO_STATUS_TEXT = { warn: '需確認', error: '錯誤', partial: '部分已登記', 'partial-write': '寫到一半失敗' };

function autoSummaryText_(r) {
  var lines = [autoFormat_(r.at) + '：寫入 ' + r.written.length + ' 張，要人工處理 ' + r.attention.length + ' 張，等待中 ' + r.waiting +
    ' 張，已登記 ' + r.done + ' 張，略過 ' + r.skipped + ' 張' + (r.more ? '（還沒做完，1 分鐘後繼續）' : '')];
  if (r.error) lines.push('執行失敗：' + r.error);
  if (r.attention.length) {
    lines.push('', '要人工處理（到「開啟逐筆／批次處理」輸入單號檢視）：');
    r.attention.forEach(function (a) { lines.push('・' + a.name + '［' + (AUTO_STATUS_TEXT[a.status] || a.status) + '］' + (a.summary ? a.summary + '：' : '') + a.note); });
  }
  if (r.written.length) {
    lines.push('', '已寫入：');
    r.written.forEach(function (w) { lines.push('・' + w.name + '　' + w.summary + (w.emailed ? '（預購金額對不起來，已另外寄信）' : '')); });
  }
  return lines.join('\n');
}

// 有寫入、要人工處理或執行失敗才寄信
function autoEmail_(r) {
  var to = getSettings().ALERT_EMAIL;
  if (!to || (!r.written.length && !r.attention.length && !r.error)) return;
  var subject = '[記單自動化] ' + (r.error ? '執行失敗　' : '') + '寫入 ' + r.written.length + ' 張' + (r.attention.length ? '，' + r.attention.length + ' 張要人工處理' : '');
  try {
    MailApp.sendEmail(to, subject, autoSummaryText_(r) + '\n\n控制台：' + SpreadsheetApp.getActiveSpreadsheet().getUrl());
  } catch (e) {
    console.error('寄信失敗：' + e.message);
  }
}

function autoFormat_(iso) {
  return Utilities.formatDate(new Date(iso), getSettings().TIMEZONE || 'America/Vancouver', 'yyyy-MM-dd HH:mm');
}
