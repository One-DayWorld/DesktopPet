const MAX_APPROVED_REPLIES = 20;

function clip(text, max = 700) {
  const s = String(text || '').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function findTurnMessages(chatHistory, turnId) {
  const list = Array.isArray(chatHistory) ? chatHistory : [];
  const user = list.find(m => m && m.turnId === turnId && m.role === 'user');
  const assistant = list.find(m => m && m.turnId === turnId && m.role === 'assistant');
  return { user, assistant };
}

function deleteChatTurn(state, turnId) {
  const id = String(turnId || '');
  if (!id || !Array.isArray(state.chatHistory)) return { deleted: 0 };
  const before = state.chatHistory.length;
  state.chatHistory = state.chatHistory.filter(m => !m || m.turnId !== id);
  return { deleted: before - state.chatHistory.length };
}

function approveAssistantReply(state, turnId, opts = {}) {
  const id = String(turnId || '');
  const { user, assistant } = findTurnMessages(state.chatHistory, id);
  if (!id || !user || !assistant) return { ok: false, error: '未找到对应回合' };

  const now = typeof opts.now === 'function' ? opts.now() : new Date().toISOString();
  const sample = {
    turnId: id,
    user: clip(user.content),
    reply: clip(assistant.content),
    approvedAt: now
  };

  const existing = Array.isArray(state.approvedReplies) ? state.approvedReplies : [];
  state.approvedReplies = existing.filter(s => s && s.turnId !== id);
  state.approvedReplies.push(sample);
  if (state.approvedReplies.length > MAX_APPROVED_REPLIES) {
    state.approvedReplies = state.approvedReplies.slice(-MAX_APPROVED_REPLIES);
  }
  return { ok: true, sample };
}

function buildApprovedRepliesInject(samples) {
  const valid = (Array.isArray(samples) ? samples : [])
    .filter(s => s && s.user && s.reply)
    .slice(-8);
  if (!valid.length) return '';

  const body = valid.map((s, i) =>
    `样例 ${i + 1}\n[用户] ${clip(s.user, 280)}\n[被认可的回复] ${clip(s.reply, 420)}`
  ).join('\n\n');
  return `【用户打勾认可过的回复样例】\n这些是用户明确认为"这次回复是期待的样子"的本地样例。后续回复优先学习它们的详略、语气、边界感、角色连续性和处理方式; 不要机械复读内容。\n\n${body}`;
}

module.exports = {
  MAX_APPROVED_REPLIES,
  deleteChatTurn,
  approveAssistantReply,
  buildApprovedRepliesInject
};
