// 測試用的假 SpreadsheetApp：只實作 Sheets.js 用到的部分
'use strict';

function colLetter(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// 把公式裡沒有 $ 的列號平移 delta（夠測試用）
function shiftRows(formula, delta) {
  return formula.replace(/(\$?)([A-Z]{1,3})(\$?)(\d+)/g, (all, d1, col, d2, row) => (d2 ? all : d1 + col + (Number(row) + delta)));
}

class FakeRange {
  constructor(sheet, row, col, rows, cols) { Object.assign(this, { sheet, row, col, rows, cols }); }
  cells(fn) {
    const out = [];
    for (let r = 0; r < this.rows; r++) {
      const line = [];
      for (let c = 0; c < this.cols; c++) line.push(fn(this.sheet.cell(this.row + r, this.col + c), this.row + r, this.col + c));
      out.push(line);
    }
    return out;
  }
  getValues() { return this.cells((x) => (x.v === undefined ? '' : x.v)); }
  getValue() { return this.getValues()[0][0]; }
  getFormulas() { return this.cells((x) => x.f || ''); }
  getFormula() { return this.getFormulas()[0][0]; }
  getFormulaR1C1() { const x = this.sheet.cell(this.row, this.col); return x.f ? `R1C1|${this.row}|${x.f}` : ''; }
  setFormulaR1C1(enc) {
    const [, src, f] = enc.split('|');
    this.setFormula(shiftRows(f, this.row - Number(src)));
    return this;
  }
  setValue(v) { this.cells((x) => { x.v = v; delete x.f; }); return this; }
  setValues(rows) { this.cells((x, r, c) => { x.v = rows[r - this.row][c - this.col]; delete x.f; }); return this; }
  setFormula(f) { this.cells((x) => { x.f = f; x.v = ''; }); return this; }
  setBackground(c) { this.cells((x) => { x.bg = c; }); return this; }
  getNumberFormat() { return this.sheet.cell(this.row, this.col).fmt || ''; }
  setNumberFormat(f) { this.cells((x) => { x.fmt = f; }); return this; }
  isPartOfMerge() {
    return this.sheet.merges.some((m) => m.row === this.row && this.col < m.col + m.cols && m.col < this.col + this.cols);
  }
  merge() { this.sheet.merges.push({ row: this.row, col: this.col, cols: this.cols }); return this; }
}

class FakeSheet {
  constructor(name, id, rows) {
    this.name = name; this.id = id; this.data = new Map(); this.merges = []; this.maxRows = 0;
    (rows || []).forEach((r, i) => this.setRow(i + 1, r));
  }
  cell(r, c) {
    const k = r + ',' + c;
    if (!this.data.has(k)) this.data.set(k, {});
    return this.data.get(k);
  }
  // row 是 { A: 值或 '=公式', ... , bg: { M: '#ffff00' } }
  setRow(r, row) {
    this.maxRows = Math.max(this.maxRows, r);
    for (const [k, v] of Object.entries(row)) {
      if (k === 'bg') { for (const [c, color] of Object.entries(v)) this.cell(r, c.charCodeAt(0) - 64).bg = color; continue; }
      const x = this.cell(r, k.charCodeAt(0) - 64);
      if (typeof v === 'string' && v.startsWith('=')) { x.f = v; x.v = ''; } else x.v = v;
    }
  }
  get(a1) { const m = /^([A-Z])(\d+)$/.exec(a1); return this.cell(Number(m[2]), m[1].charCodeAt(0) - 64); }
  getName() { return this.name; }
  getSheetId() { return this.id; }
  getRange(row, col, rows, cols) { return new FakeRange(this, row, col, rows || 1, cols || 1); }
  getLastRow() {
    let last = 0;
    for (const [k, x] of this.data) if ((x.v !== undefined && x.v !== '') || x.f) last = Math.max(last, Number(k.split(',')[0]));
    return last;
  }
  getMaxRows() { return this.maxRows; }
  insertRowsAfter(after, n) { this.maxRows += n; }
}

class FakeBook {
  constructor(id, sheets) { this.id = id; this.sheets = sheets; }
  getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
  getId() { return this.id; }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/' + this.id + '/edit'; }
}

function installFake(books) {
  global.SpreadsheetApp = { openById: (id) => { const b = books[id]; if (!b) throw new Error('no book ' + id); return b; } };
}

module.exports = { FakeSheet, FakeBook, installFake, colLetter };
