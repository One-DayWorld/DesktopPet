const test = require('node:test');
const assert = require('node:assert/strict');

const {
  deleteChatTurn,
  approveAssistantReply,
  buildApprovedRepliesInject
} = require('../chat-feedback');

test('deleteChatTurn removes a whole user/assistant turn by turn id', () => {
  const state = {
    chatHistory: [
      { id: 't1-user', turnId: 't1', role: 'user', content: '第一问' },
      { id: 't1-assistant', turnId: 't1', role: 'assistant', content: '第一答' },
      { id: 't2-user', turnId: 't2', role: 'user', content: '第二问' },
      { id: 't2-assistant', turnId: 't2', role: 'assistant', content: '第二答' }
    ]
  };

  const result = deleteChatTurn(state, 't1');

  assert.equal(result.deleted, 2);
  assert.deepEqual(state.chatHistory.map(m => m.content), ['第二问', '第二答']);
});

test('approveAssistantReply stores the paired user prompt and assistant reply as learning sample', () => {
  const state = {
    pet: { xp: 0, level: 1 },
    chatHistory: [
      { id: 't1-user', turnId: 't1', role: 'user', content: '说短一点' },
      { id: 't1-assistant', turnId: 't1', role: 'assistant', content: '好，短答。' }
    ],
    approvedReplies: []
  };

  const result = approveAssistantReply(state, 't1');

  assert.equal(result.ok, true);
  assert.equal(state.approvedReplies.length, 1);
  assert.equal(state.approvedReplies[0].user, '说短一点');
  assert.equal(state.approvedReplies[0].reply, '好，短答。');
  assert.equal(state.approvedReplies[0].turnId, 't1');
});

test('approveAssistantReply deduplicates samples and keeps only the newest twenty', () => {
  const state = {
    chatHistory: [
      { turnId: 'latest', role: 'user', content: '最新问题' },
      { turnId: 'latest', role: 'assistant', content: '最新回答' }
    ],
    approvedReplies: Array.from({ length: 20 }, (_, i) => ({
      turnId: `old-${i}`,
      user: `旧问题 ${i}`,
      reply: `旧回答 ${i}`,
      approvedAt: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`
    }))
  };

  approveAssistantReply(state, 'latest', { now: () => '2026-02-01T00:00:00.000Z' });
  approveAssistantReply(state, 'latest', { now: () => '2026-02-02T00:00:00.000Z' });

  assert.equal(state.approvedReplies.length, 20);
  assert.equal(state.approvedReplies.filter(s => s.turnId === 'latest').length, 1);
  assert.equal(state.approvedReplies[19].approvedAt, '2026-02-02T00:00:00.000Z');
  assert.equal(state.approvedReplies[0].turnId, 'old-1');
});

test('buildApprovedRepliesInject summarizes approved samples for future chats', () => {
  const inject = buildApprovedRepliesInject([
    { user: '别长篇', reply: '收到，短答。' }
  ]);

  assert.match(inject, /用户打勾认可过的回复样例/);
  assert.match(inject, /别长篇/);
  assert.match(inject, /收到，短答。/);
});
