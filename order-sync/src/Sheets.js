// Sheets.js — 依照 plan 讀寫試算表（庫存/出貨/預購、各年份已出貨、PW/PO）
//
// resolvePlan：預覽時用，找出每個動作要寫到哪個分頁的第幾列，順便檢查重複。
// executePlan：真正寫入。寫入前會重新 resolve，列號以寫入當下為準。

var SHEETS_COL = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, I: 9, J: 10, K: 11, L: 12, M: 13, N: 14, O: 15, P: 16, Q: 17 };

var ORIGINALS_TAB = '原單資料';

// control：控制台試算表（放「原單資料」分頁）
function SheetsSession(settings, fetchOriginal, control) {
  this.settings = settings;
  this.control = control || null;
  this.fetchOriginal = fetchOriginal || function () { return null; };
  this.books = {};
  this.columns = {};
  this.originals = {};
  this.nextRows = {};
}

SheetsSession.prototype.book = function (id) {
  if (!id) return null;
  if (!this.books[id]) this.books[id] = SpreadsheetApp.openById(id);
  return this.books[id];
};

SheetsSession.prototype.tz = function () {
  return this.settings.TIMEZONE || 'America/Vancouver';
};

SheetsSession.prototype.preorderTabName = function () { return this.settings.PREORDER_TAB || '預購'; };
SheetsSession.prototype.orderingTabName = function () { return this.settings.ORDERING_TAB || '訂貨'; };
SheetsSession.prototype.popwTabName = function () { return this.settings.POPW_TAB || 'PO/PW'; };

SheetsSession.prototype.mainSheet = function (name) {
  var book = this.book(this.settings.MAIN_SHEET_ID);
  if (!book) throw new Error('「設定」分頁的 MAIN_SHEET_ID 還沒填。');
  var sheet = book.getSheetByName(name);
  if (!sheet) throw new Error('庫存/出貨/預購 找不到分頁「' + name + '」。');
  return { book: book, sheet: sheet, file: 'main' };
};

SheetsSession.prototype.popwSheet = function () {
  var book = this.book(this.settings.POPW_SHEET_ID);
  if (!book) throw new Error('「設定」分頁的 POPW_SHEET_ID（PW/PO 試算表）還沒填。');
  var sheet = book.getSheetByName(this.popwTabName());
  if (!sheet) throw new Error('PW/PO 試算表找不到分頁「' + this.popwTabName() + '」。');
  return { book: book, sheet: sheet, file: 'popw' };
};

// 「2026已出貨 CA」先找主檔，找不到再找該年份的獨立檔（YEAR_SHEET_2025 …）
SheetsSession.prototype.shippedSheet = function (year, region) {
  var name = year + '已出貨 ' + region;
  var main = this.book(this.settings.MAIN_SHEET_ID);
  var sheet = main && main.getSheetByName(name);
  if (sheet) return { book: main, sheet: sheet, file: 'main', tab: name };
  var id = this.settings['YEAR_SHEET_' + year];
  var book = this.book(id);
  sheet = book && book.getSheetByName(name);
  if (sheet) return { book: book, sheet: sheet, file: 'year' + year, tab: name };
  return null;
};

SheetsSession.prototype.shippedYears = function (fromYear) {
  var years = {};
  years[fromYear] = true;
  years[fromYear - 1] = true;
  Object.keys(this.settings).forEach(function (k) {
    var m = /^YEAR_SHEET_(\d{4})$/.exec(k);
    if (m && this.settings[k]) years[Number(m[1])] = true;
  }, this);
  return Object.keys(years).map(Number).sort(function (a, b) { return b - a; });
};

// 欄位資料：A～O 欄一次讀進來（找單號、找最後一列、PW 出貨要看的 L／O 都在這裡），大試算表少讀幾次比較快
var SHEETS_BLOCK_COLS = 15;

SheetsSession.prototype.columnValues = function (ref, col) {
  var id = ref.sheet.getSheetId ? ref.sheet.getSheetId() : ref.sheet.getName();
  var sheetKey = (ref.book.getId ? ref.book.getId() : '') + '|' + id;
  var cacheKey = sheetKey + '|' + col;
  if (!this.columns[cacheKey]) {
    var last = ref.sheet.getLastRow();
    if (col <= SHEETS_BLOCK_COLS) {
      this.blocks = this.blocks || {};
      if (!this.blocks[sheetKey]) this.blocks[sheetKey] = last ? ref.sheet.getRange(1, 1, last, SHEETS_BLOCK_COLS).getValues() : [];
      this.columns[cacheKey] = this.blocks[sheetKey].map(function (r) { return r[col - 1]; });
    } else {
      this.columns[cacheKey] = last ? ref.sheet.getRange(1, col, last, 1).getValues().map(function (r) { return r[0]; }) : [];
    }
  }
  return this.columns[cacheKey];
};

SheetsSession.prototype.findRow = function (ref, key, col) {
  var values = this.columnValues(ref, col || 1);
  var want = String(key).trim().toUpperCase();
  for (var i = 0; i < values.length; i++) {
    if (String(values[i]).trim().toUpperCase() === want) return i + 1;
  }
  return 0;
};

// 最後一筆資料在第幾列（看指定的幾欄）；試算表預先填好格式／公式的空白列不算資料
SheetsSession.prototype.lastDataRow = function (ref, cols) {
  var cacheKey = (ref.book.getId ? ref.book.getId() : '') + '|' + ref.sheet.getName();
  this.lastRows = this.lastRows || {};
  if (!(cacheKey in this.lastRows)) {
    var last = 0;
    cols.forEach(function (c) {
      var values = this.columnValues(ref, c);
      for (var i = values.length - 1; i >= 0; i--) {
        if (values[i] !== '' && values[i] !== null) { last = Math.max(last, i + 1); break; }
      }
    }, this);
    this.lastRows[cacheKey] = last;
  }
  return this.lastRows[cacheKey];
};

// 最後一筆資料的下一列；同一個 session 連續要好幾列時依序往下
SheetsSession.prototype.nextRow = function (ref, cols) {
  var cacheKey = (ref.book.getId ? ref.book.getId() : '') + '|' + ref.sheet.getName();
  if (this.nextRows[cacheKey]) return this.nextRows[cacheKey]++;
  var last = this.lastDataRow(ref, cols);
  this.nextRows[cacheKey] = last + 2;
  return last + 1;
};

// 批次寫入前先把會用到的分頁都讀好（寫入之後再讀，大試算表就得先整份重算）
SheetsSession.prototype.warmUp = function (year) {
  var self = this;
  function touch(ref, cols) {
    if (!ref) return;
    self.lastDataRow(ref, cols);
    self.template(ref);
  }
  this.shippedYears(year).forEach(function (y) {
    ['CA', 'INT'].forEach(function (r) { touch(self.shippedSheet(y, r), [1, 2, 3, 4]); });
  });
  try { touch(this.mainSheet(this.preorderTabName()), [1, 3, 4]); this.preorderData(); } catch (e) { /* 沒有這個分頁時，寫入時會再報錯 */ }
  try { touch(this.mainSheet(this.orderingTabName()), [1, 2]); } catch (e) { /* 同上 */ }
  try { touch(this.popwSheet(), [SHEETS_COL.E, SHEETS_COL.F]); } catch (e) { /* 同上 */ }
  var orig = this.originalsSheet();
  if (orig) { touch(orig, [1]); this.savedData(); }
};

SheetsSession.prototype.formatDate = function (v) {
  if (v instanceof Date) {
    if (typeof Utilities !== 'undefined') return Utilities.formatDate(v, this.tz(), 'yyyy-MM-dd');
    return v.getFullYear() + '-' + ('0' + (v.getMonth() + 1)).slice(-2) + '-' + ('0' + v.getDate()).slice(-2);
  }
  return String(v || '').slice(0, 10);
};

SheetsSession.prototype.originalsSheet = function () {
  var sheet = this.control && this.control.getSheetByName(ORIGINALS_TAB);
  return sheet ? { book: this.control, sheet: sheet, file: 'control', tab: ORIGINALS_TAB } : null;
};

// 控制台「原單資料」：{ 單號: { extras, fee, prepaid } }
SheetsSession.prototype.savedData = function () {
  if (!this._saved) {
    this._saved = {};
    var ref = this.originalsSheet();
    var last = ref ? ref.sheet.getLastRow() : 0;
    if (last > 1) {
      ref.sheet.getRange(2, 1, last - 1, 5).getValues().forEach(function (r) {
        var code = String(r[0]).trim().toUpperCase();
        if (code) this._saved[code] = { extras: Number(r[2]) || 0, fee: r[3] === '' ? '' : Number(r[3]), prepaid: Number(r[4]) || 0 };
      }, this);
    }
  }
  return this._saved;
};

SheetsSession.prototype.preorderData = function () {
  if (!this._pre) {
    var ref = this.mainSheet(this.preorderTabName());
    var last = ref.sheet.getLastRow();
    this._pre = {
      ref: ref,
      values: last ? ref.sheet.getRange(1, 1, last, 15).getValues() : [],
      nFormulas: last ? ref.sheet.getRange(1, SHEETS_COL.N, last, 1).getFormulas() : []
    };
  }
  return this._pre;
};

// 給 Rules.planOrder 用的 ctx
SheetsSession.prototype.context = function (order) {
  var self = this;
  var orderYear = Number(String(order.date).slice(0, 4));
  return {
    findPreorder: function (code) {
      var d = self.preorderData();
      var want = code.toUpperCase();
      for (var i = 0; i < d.values.length; i++) {
        if (String(d.values[i][0]).trim().toUpperCase() !== want) continue;
        var v = d.values[i];
        return {
          row: i + 1, B: v[1], C: self.formatDate(v[2]), D: String(v[3]).trim(), I: v[8], L: v[11], M: v[12],
          N: d.nFormulas[i][0] || v[13], Nvalue: Number(v[13]) || 0
        };
      }
      return null;
    },
    findShipped: function (code) {
      var years = self.shippedYears(orderYear);
      for (var y = 0; y < years.length; y++) {
        var regions = ['CA', 'INT'];
        for (var r = 0; r < regions.length; r++) {
          var ref = self.shippedSheet(years[y], regions[r]);
          if (!ref) continue;
          var row = self.findRow(ref, code, 1);
          if (row) {
            return { file: ref.file, tab: ref.tab, row: row, L: self.columnValues(ref, SHEETS_COL.L)[row - 1], O: self.columnValues(ref, SHEETS_COL.O)[row - 1], C: self.columnValues(ref, SHEETS_COL.C)[row - 1] };
          }
        }
      }
      return null;
    },
    baseShipped: function (base) {
      var years = self.shippedYears(orderYear);
      var re = new RegExp('^' + base + '(-\\d+)?$', 'i');
      for (var y = 0; y < years.length; y++) {
        var regions = ['CA', 'INT'];
        for (var r = 0; r < regions.length; r++) {
          var ref = self.shippedSheet(years[y], regions[r]);
          if (!ref) continue;
          var col = self.columnValues(ref, 1);
          for (var i = 0; i < col.length; i++) if (re.test(String(col[i]).trim())) return true;
        }
      }
      return false;
    },
    findSaved: function (code) {
      return self.savedData()[String(code).toUpperCase()] || null;
    },
    findOriginal: function (base) {
      if (!(base in self.originals)) self.originals[base] = self.fetchOriginal(base) || null;
      return self.originals[base];
    }
  };
};

SheetsSession.prototype.duplicate = function (plan, a, where, row) {
  plan.duplicates = plan.duplicates || [];
  plan.duplicates.push(a.key);
  plan.errors.push(a.key + ' 已經記錄在「' + where.replace(/^「|」$/g, '') + '」第 ' + row + ' 列。');
};

// 批次寫入時，一張單沒寫成就把預留的列號還回去，下一張單才不會空出列
SheetsSession.prototype.saveRows = function () { return JSON.parse(JSON.stringify(this.nextRows)); };
SheetsSession.prototype.restoreRows = function (saved) { this.nextRows = saved; };

// 寫入後更新快取，同一批後面的單才看得到（避免重複、訂貨表同一個 UPC 新增兩次）
SheetsSession.prototype.remember = function (ref, row, values) {
  var id = ref.sheet.getSheetId ? ref.sheet.getSheetId() : ref.sheet.getName();
  var sheetKey = (ref.book.getId ? ref.book.getId() : '') + '|' + id;
  var block = this.blocks && this.blocks[sheetKey];
  Object.keys(values).forEach(function (letter) {
    var col = SHEETS_COL[letter];
    var arr = this.columns[sheetKey + '|' + col];
    if (arr) { while (arr.length < row) arr.push(''); arr[row - 1] = values[letter]; }
    if (block && col <= SHEETS_BLOCK_COLS) {
      while (block.length < row) block.push(new Array(SHEETS_BLOCK_COLS).fill(''));
      block[row - 1][col - 1] = values[letter];
    }
  }, this);
};

// 找出每個動作的目標分頁和列，檢查重複；結果寫在 action.target / action.skip，錯誤加到 plan.errors
SheetsSession.prototype.resolve = function (plan) {
  var self = this;
  plan.actions.forEach(function (a) {
    try {
      var ref, dup;
      if (a.op === 'appendShipped') {
        ref = self.shippedSheet(a.year, a.region);
        if (!ref) { plan.errors.push('找不到分頁「' + a.year + '已出貨 ' + a.region + '」（主檔和 YEAR_SHEET_' + a.year + ' 都沒有）。'); return; }
        dup = self.findRow(ref, a.key, 1);
        if (dup) { self.duplicate(plan, a, ref.tab, dup); return; }
        a.target = { file: ref.file, tab: ref.tab, row: self.nextRow(ref, [1, 2, 3, 4]) };
      } else if (a.op === 'appendPreorder') {
        ref = self.mainSheet(self.preorderTabName());
        dup = self.findRow(ref, a.key, 1);
        if (dup) { self.duplicate(plan, a, '預購', dup); return; }
        a.target = { file: 'main', tab: ref.sheet.getName(), row: self.nextRow(ref, [1, 3, 4]) };
      } else if (a.op === 'appendPW') {
        ref = self.popwSheet();
        dup = self.findRow(ref, a.key, SHEETS_COL.E);
        if (dup) { self.duplicate(plan, a, 'PW/PO「' + ref.sheet.getName() + '」', dup); return; }
        a.target = { file: 'popw', tab: ref.sheet.getName(), row: self.nextRow(ref, [SHEETS_COL.E, SHEETS_COL.F]) };
      } else if (a.op === 'ensureOrdering') {
        ref = self.mainSheet(self.orderingTabName());
        var col = self.columnValues(ref, SHEETS_COL.B);
        for (var i = 0; i < col.length; i++) {
          if (rulesUpcKey(col[i]) === a.key) { a.skip = true; a.skipReason = '訂貨表第 ' + (i + 1) + ' 列已有這個 UPC，不新增'; return; }
        }
        a.target = { file: 'main', tab: ref.sheet.getName(), row: self.nextRow(ref, [1, 2]) };
        if (a.missingDeadline) plan.warnings.push(a.missingDeadline);
      } else if (a.op === 'saveOriginal') {
        ref = self.originalsSheet();
        if (!ref) { a.skip = true; a.skipReason = '控制台沒有「原單資料」分頁，沒有存（請按選單「建立／補齊分頁」）'; return; }
        if (self.savedData()[a.key.toUpperCase()]) { a.skip = true; a.skipReason = '原單資料已經有這個單號'; return; }
        a.target = { file: 'control', tab: ORIGINALS_TAB, row: self.nextRow(ref, [1]) };
      } else if (a.op === 'updatePreorder') {
        ref = self.mainSheet(self.preorderTabName());
        a.target = { file: 'main', tab: ref.sheet.getName(), row: a.row };
      } else if (a.op === 'updateShipped') {
        a.target = { file: a.file, tab: a.tab, row: a.row };
      }
    } catch (e) {
      plan.errors.push(e.message);
    }
  });
  return plan;
};

SheetsSession.prototype.refFor = function (target) {
  if (target.file === 'popw') return this.popwSheet();
  if (target.file === 'control') return this.originalsSheet();
  if (target.file === 'main') return this.mainSheet(target.tab);
  var m = /^year(\d{4})$/.exec(target.file);
  var book = this.book(this.settings['YEAR_SHEET_' + m[1]]);
  return { book: book, sheet: book.getSheetByName(target.tab), file: target.file };
};

function sheetsToDate_(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : s;
}

// ---- 寫入 ----
// 試算表很大（預購、訂貨每一列都有 VLOOKUP／SUMIF），寫入之後只要再讀任何東西，Google 就得先把整份重算一次。
// 所以寫入前先一次讀好需要的東西（範本列的公式、格式、總列數），寫入時只寫不讀。

var SHEETS_TEMPLATE_COLS = 17; // A～Q

SheetsSession.prototype.sheetKeyOf = function (ref) {
  return (ref.book.getId ? ref.book.getId() : '') + '|' + ref.sheet.getName();
};

// 範本：最後一筆資料往上 30 列內，每一欄最近的公式（R1C1，相對位置）、最後一筆資料那一列的數字格式、總列數、連結
SheetsSession.prototype.template = function (ref) {
  var key = this.sheetKeyOf(ref);
  this.templates = this.templates || {};
  if (this.templates[key]) return this.templates[key];
  var sheet = ref.sheet;
  var last = (this.lastRows && this.lastRows[key]) || sheet.getLastRow();
  var width = Math.min(SHEETS_TEMPLATE_COLS, sheet.getMaxColumns ? sheet.getMaxColumns() : SHEETS_TEMPLATE_COLS);
  var formulas = [], formats = [];
  if (last >= 2) {
    var start = Math.max(2, last - 29);
    var block = sheet.getRange(start, 1, last - start + 1, width).getFormulasR1C1();
    for (var c = 0; c < width; c++) {
      for (var r = block.length - 1; r >= 0; r--) { if (block[r][c]) { formulas[c + 1] = block[r][c]; break; } }
    }
    sheet.getRange(last, 1, 1, width).getNumberFormats()[0].forEach(function (f, i) { formats[i + 1] = f; });
  }
  this.templates[key] = {
    formulas: formulas, formats: formats, maxRows: sheet.getMaxRows(),
    url: ref.book.getUrl() + '#gid=' + sheet.getSheetId() + '&range=A'
  };
  return this.templates[key];
};

// 寫入前把這張單會用到的範本都讀好
SheetsSession.prototype.prefetch = function (plan) {
  plan.actions.forEach(function (a) {
    if (!a.skip && a.target) this.template(this.refFor(a.target));
  }, this);
};

function sheetsEnsureRows_(sheet, row, tpl) {
  if (row > tpl.maxRows) {
    sheet.insertRowsAfter(tpl.maxRows, row - tpl.maxRows);
    tpl.maxRows = row;
  }
}

function sheetsFormulas_(sheet, row, cols, tpl) {
  cols.forEach(function (c) { if (tpl.formulas[c]) sheet.getRange(row, c).setFormulaR1C1(tpl.formulas[c]); });
}

function sheetsFormats_(sheet, row, cols, tpl) {
  cols.forEach(function (c) { if (tpl.formats[c]) sheet.getRange(row, c).setNumberFormat(tpl.formats[c]); });
}

function sheetsMerge_(sheet, row, col, width) {
  try { sheet.getRange(row, col, 1, width).merge(); } catch (e) { /* 已經合併過或合併失敗都不影響資料 */ }
}

// 相鄰的欄位一次寫入
function sheetsSetValues_(sheet, row, values) {
  var cols = Object.keys(values).map(function (c) { return SHEETS_COL[c]; }).sort(function (a, b) { return a - b; });
  var byCol = {};
  Object.keys(values).forEach(function (c) { byCol[SHEETS_COL[c]] = values[c]; });
  var i = 0;
  while (i < cols.length) {
    var j = i;
    while (j + 1 < cols.length && cols[j + 1] === cols[j] + 1) j++;
    var run = [];
    for (var k = i; k <= j; k++) run.push(byCol[cols[k]]);
    sheet.getRange(row, cols[i], 1, run.length).setValues([run]);
    i = j + 1;
  }
}

function sheetsNewPaidFormula_(current, add) {
  var a = Math.round(add * 100) / 100;
  if (typeof current === 'string' && current.charAt(0) === '=') return current + '+' + a;
  if (current === '' || current === null || current === undefined) return a;
  return '=' + current + '+' + a;
}

// 寫入。回傳 [{ label, tab, row, url }]
SheetsSession.prototype.execute = function (plan) {
  var self = this;
  var settings = this.settings;
  var written = [];
  this.prefetch(plan);
  plan.actions.forEach(function (a) {
    if (a.skip || !a.target) return;
    var ref = self.refFor(a.target);
    var sheet = ref.sheet;
    var tpl = self.template(ref);
    var row = a.target.row;
    if (a.op === 'appendShipped') {
      sheetsEnsureRows_(sheet, row, tpl);
      sheetsSetValues_(sheet, row, Object.assign({}, a.values, { B: sheetsToDate_(a.values.B) }));
      sheetsMerge_(sheet, row, SHEETS_COL.D, 4);
      sheetsFormats_(sheet, row, [SHEETS_COL.B, SHEETS_COL.K, SHEETS_COL.L, SHEETS_COL.N, SHEETS_COL.O], tpl);
      sheet.getRange(row, SHEETS_COL.M).setBackground((a.colors && a.colors.M) || settings.M_DEFAULT_COLOR || RULES_COLORS.yellow);
      self.remember(ref, row, a.values);
    } else if (a.op === 'appendPreorder') {
      sheetsEnsureRows_(sheet, row, tpl);
      sheetsSetValues_(sheet, row, Object.assign({}, a.values, { C: sheetsToDate_(a.values.C) }));
      sheetsMerge_(sheet, row, SHEETS_COL.D, 5);
      sheetsFormats_(sheet, row, [SHEETS_COL.C, SHEETS_COL.M, SHEETS_COL.N], tpl);
      sheetsFormulas_(sheet, row, [SHEETS_COL.J, SHEETS_COL.K], tpl);
      if (a.deposit) sheet.getRange(row, SHEETS_COL.O).setFormula('=M' + row + '*L' + row + '-N' + row);
      else sheet.getRange(row, SHEETS_COL.O).setValue('---');
      if (a.colors && a.colors.B) sheet.getRange(row, SHEETS_COL.B).setBackground(a.colors.B);
      self.remember(ref, row, a.values);
      if (self._pre) {
        self._pre.values[row - 1] = [a.values.A, a.values.B, a.values.C, a.values.D, '', '', '', '', a.values.I, '', '', a.values.L, a.values.M, a.values.N, ''];
        self._pre.nFormulas[row - 1] = [''];
      }
    } else if (a.op === 'appendPW') {
      sheetsEnsureRows_(sheet, row, tpl);
      sheetsSetValues_(sheet, row, Object.assign({}, a.values, { D: sheetsToDate_(a.values.D) }));
      sheetsFormats_(sheet, row, [SHEETS_COL.D], tpl);
      sheetsFormulas_(sheet, row, [SHEETS_COL.H, SHEETS_COL.L, SHEETS_COL.M, SHEETS_COL.P, SHEETS_COL.Q], tpl);
      if (a.colors && a.colors.C) sheet.getRange(row, SHEETS_COL.C).setBackground(a.colors.C);
      self.remember(ref, row, a.values);
    } else if (a.op === 'ensureOrdering') {
      sheetsEnsureRows_(sheet, row, tpl);
      sheetsSetValues_(sheet, row, Object.assign({}, a.values, { C: a.values.C ? sheetsToDate_(a.values.C) : '' }));
      sheetsFormats_(sheet, row, [SHEETS_COL.C], tpl);
      sheetsFormulas_(sheet, row, [SHEETS_COL.D, SHEETS_COL.E], tpl);
      self.remember(ref, row, a.values);
    } else if (a.op === 'saveOriginal') {
      sheetsEnsureRows_(sheet, row, tpl);
      sheetsSetValues_(sheet, row, Object.assign({}, a.values, { F: sheetsToDate_(a.values.F) }));
      self.remember(ref, row, a.values);
      self.savedData()[a.key.toUpperCase()] = { extras: a.values.C, fee: a.values.D, prepaid: a.values.E };
    } else if (a.op === 'updatePreorder') {
      var found = self.findRow(ref, a.key, 1);
      if (found !== row) throw new Error(a.key + '：預購表的列號變了（原本第 ' + row + ' 列），請重新預覽。');
      sheet.getRange(row, SHEETS_COL.B).setValue('Y');
      var pre = self.preorderData();
      if (a.addPaid) {
        var current = (pre.nFormulas[row - 1] && pre.nFormulas[row - 1][0]) || (pre.values[row - 1] ? pre.values[row - 1][13] : '');
        var f = sheetsNewPaidFormula_(current, a.addPaid);
        if (typeof f === 'string') sheet.getRange(row, SHEETS_COL.N).setFormula(f); else sheet.getRange(row, SHEETS_COL.N).setValue(f);
        pre.nFormulas[row - 1] = [typeof f === 'string' ? f : ''];
      }
      sheet.getRange(row, 1, 1, 15).setBackground(a.rowColor);
      if (pre.values[row - 1]) {
        pre.values[row - 1][1] = 'Y';
        pre.values[row - 1][13] = a.paidAfter;
      }
    } else if (a.op === 'updateShipped') {
      var check = self.findRow(ref, a.key, 1);
      if (check !== row) throw new Error(a.key + '：已出貨表的列號變了（原本第 ' + row + ' 列），請重新預覽。');
      sheetsSetValues_(sheet, row, a.set);
      self.remember(ref, row, a.set);
    }
    written.push({ label: a.label, key: a.key, tab: sheet.getName(), row: row, url: tpl.url + row });
  });
  return written;
};

if (typeof module !== 'undefined') {
  module.exports = { SheetsSession: SheetsSession, sheetsNewPaidFormula_: sheetsNewPaidFormula_ };
}
