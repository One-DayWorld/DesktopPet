const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildRecentHistoryForPrompt
} = require('../chat-history');

test('recent history labels ownership for user and assistant turns', () => {
  const history = buildRecentHistoryForPrompt([
    { role: 'user', content: '我的杯子在左边，她的发卡在右边。' },
    { role: 'assistant', content: '我的发卡别拿错了，你的杯子我记着。' }
  ], 60000);

  assert.equal(history[0].role, 'user');
  assert.match(history[0].content, /历史用户发言/);
  assert.match(history[0].content, /我\/我的.*用户本人/);
  assert.match(history[0].content, /他\/她\/桌宠.*助手/);
  assert.match(history[0].content, /没有明确第三方/);
  assert.match(history[0].content, /我的杯子在左边/);

  assert.equal(history[1].role, 'assistant');
  assert.match(history[1].content, /历史助手发言/);
  assert.match(history[1].content, /我\/我的.*助手/);
  assert.match(history[1].content, /你\/你的.*用户本人/);
  assert.match(history[1].content, /我的发卡别拿错了/);
});

test('recent history still respects character budget from the newest turns', () => {
  const history = buildRecentHistoryForPrompt([
    { role: 'user', content: '很早以前的长消息'.repeat(2000) },
    { role: 'assistant', content: '早期回复'.repeat(2000) },
    { role: 'user', content: '最近用户消息' },
    { role: 'assistant', content: '最近助手回复' }
  ], 100);

  assert.equal(history.length, 2);
  assert.match(history[0].content, /最近用户消息/);
  assert.match(history[1].content, /最近助手回复/);
});
