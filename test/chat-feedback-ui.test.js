const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(name) {
  return fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
}

test('preload exposes chat delete and approve APIs', () => {
  const preload = read('preload.js');

  assert.match(preload, /deleteChatTurn/);
  assert.match(preload, /delete-chat-turn/);
  assert.match(preload, /approveAiReply/);
  assert.match(preload, /approve-ai-reply/);
});

test('main registers chat delete and approve handlers', () => {
  const main = read('main.js');

  assert.match(main, /delete-chat-turn/);
  assert.match(main, /approve-ai-reply/);
  assert.match(main, /buildApprovedRepliesInject/);
});

test('panel renders delete controls and assistant approval controls', () => {
  const panel = read('panel.html');

  assert.match(panel, /makeDeleteBtn/);
  assert.match(panel, /makeApproveBtn/);
  assert.match(panel, /deleteChatTurn/);
  assert.match(panel, /approveAiReply/);
  assert.match(panel, /data-turn-id/);
});
