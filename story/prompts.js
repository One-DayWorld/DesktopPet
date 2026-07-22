const STORY_KNOWLEDGE_HEADING = '## Story 成人主题互动知识';

function cleanOneLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function buildStoryLearningPrompt(oldStoryKnowledge, notes) {
  const body = (notes || []).map(n => {
    const tags = Array.isArray(n.tags) ? n.tags.map(cleanOneLine).filter(Boolean).join(', ') : '';
    return `【${cleanOneLine(n.relativePath)}】\n标题: ${cleanOneLine(n.title)}\n标签: ${tags}\n正文:\n${String(n.body || '').slice(0, 8000)}`;
  }).join('\n\n---\n\n');

  return `现有 ${STORY_KNOWLEDGE_HEADING} 小节:\n${String(oldStoryKnowledge || '').trim() || '(空)'}\n\nStory 变更文档:\n${body}\n\n任务:\n请把这些 Story 文档提炼成桌宠聊天时可用的成人主题互动知识。只输出这个小节本身, 第一行必须是 "${STORY_KNOWLEDGE_HEADING}"。\n\n必须包含四个三级标题:\n### 题材与术语理解\n### 用户偏好的互动风格\n### Story 世界观与角色氛围\n### 安全边界\n\n约束:\n- 故事内容不等于用户现实经历, 角色台词不等于用户现实承诺或偏好。\n- 仅在成年人、合意、虚构或明确创作语境中使用这些知识。\n- 可总结捆绑、堵嘴、捂嘴等题材在创作语境中的氛围、心理张力和风险意识。\n- 涉及呼吸受限、无法求助、长时间拘束等高风险内容时, 只保留安全边界和替代方向, 不输出危险实操细节。\n- 保持简明, 默认 800 到 1200 字以内; 不复制可识别的长篇原文。`;
}

module.exports = { STORY_KNOWLEDGE_HEADING, buildStoryLearningPrompt };
