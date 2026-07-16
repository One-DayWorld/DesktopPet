function buildNotesRefinePrompt(oldMemory, notes) {
  const body = notes.map(n => `【${n.relativePath}】\n标题: ${n.title}\n标签: ${(n.tags || []).join(', ')}\n正文:\n${String(n.body || '').slice(0, 6000)}`).join('\n\n---\n\n');
  return `现有记忆:\n${String(oldMemory || '').trim() || '(空)'}\n\nObsidian 变更笔记:\n${body}\n\n更新约束:\n- 笔记内容不等于用户观点。\n- 不把引用/外部文章观点当用户事实。\n- 保留已有记忆，尤其用户手写内容。\n- 只记录稳定事实、长期项目、关注主题和明确偏好。\n- 总量精简，避免把知识库全文塞入记忆。\n\n请输出更新后的完整记忆文本。`;
}

function buildWriteBackPrompt(turns) {
  const convo = turns.map(t => `[用户] ${t.user}\n[VF-1] ${t.reply}`).join('\n\n').slice(0, 12000);
  return `请从以下聊天中提取值得写入 Obsidian 的内容。只返回 JSON: {"inbox":["短条目"],"highlights":[{"topic":"主题","reusable":"可复用结论","action":"后续行动"}]}。如果没有价值, 返回 {"inbox":[],"highlights":[]}。\n\n${convo}`;
}

module.exports = { buildNotesRefinePrompt, buildWriteBackPrompt };
