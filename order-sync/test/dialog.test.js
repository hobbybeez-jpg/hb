'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// onclick="write()" 會呼叫 document.write() 把整個視窗清空；inline handler 的函式名稱不能和 document 的方法撞名
test('Dialog 按鈕的函式名稱不和 document 的方法撞名', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/Dialog.html'), 'utf8');
  const documentNames = ['write', 'writeln', 'open', 'close', 'clear', 'evaluate', 'append', 'prepend', 'replaceChildren', 'getSelection', 'hasFocus', 'execCommand'];
  const bodies = [...html.matchAll(/\son\w+="([^"]*)"/g)].map((m) => m[1]);
  const handlers = bodies.flatMap((b) => [...b.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\(/g)].map((m) => m[2]))
    .filter((n) => !['if', 'return'].includes(n));
  assert.ok(handlers.length > 0);
  for (const name of handlers) assert.ok(!documentNames.includes(name), `onclick 用了 ${name}()`);
  for (const name of new Set(handlers)) assert.match(html, new RegExp('function ' + name + '\\('), `找不到 function ${name}`);
});
