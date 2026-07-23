function pickRecentHistory(history, budget) {
  const picked = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const m = history[i] || {};
    const len = m.content ? String(m.content).length : 0;
    if (picked.length >= 2 && used + len > budget) break;
    picked.push({ role: m.role, content: m.content });
    used += len;
  }
  return picked.reverse();
}

function ownershipPrefix(role) {
  if (role === 'user') {
    return '【历史用户发言：这条里的“我/我的”=用户本人；“你/你的/他/她/桌宠”=助手或角色；没有明确第三方时不要新开第三人】';
  }
  if (role === 'assistant') {
    return '【历史助手发言：这条里的“我/我的”=助手或角色；“你/你的”=用户本人】';
  }
  return '';
}

function annotateHistoryForOwnership(history) {
  return (history || []).map((m) => {
    const role = m && m.role;
    const prefix = ownershipPrefix(role);
    const content = String((m && m.content) || '');
    if (!prefix || content.startsWith(prefix)) return { role, content };
    return { role, content: `${prefix}\n${content}` };
  });
}

function buildRecentHistoryForPrompt(history, budget) {
  return annotateHistoryForOwnership(pickRecentHistory(history || [], budget));
}

module.exports = {
  pickRecentHistory,
  annotateHistoryForOwnership,
  buildRecentHistoryForPrompt
};
