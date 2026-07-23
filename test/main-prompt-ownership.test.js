const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('chat system prompt treats two-person third-person references as assistant-owned', () => {
  const mainJs = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

  assert.match(mainJs, /两人对话/);
  assert.match(mainJs, /用户.*他\/她.*桌宠.*你.*指向.*助手/);
  assert.match(mainJs, /没有明确第三方/);
  assert.match(mainJs, /不是用户/);
});
