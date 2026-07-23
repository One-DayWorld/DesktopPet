function stripCodeFence(text) {
  return String(text || '').trim()
    .replace(/^```[a-zA-Z]*\n?/, '')
    .replace(/```$/, '')
    .trim();
}

function buildProfileInject(memoryText, personaActive = false) {
  const mem = String(memoryText || '').trim();
  if (!mem) {
    return '【记忆提示】你正在逐渐了解这位亲, 多观察其偏好, 少做假设。';
  }
  const header = '【长期记忆 — 你对这位亲的了解】\n'
    + '以下是你对这位亲的长期记忆, 跨会话持久保存。这里记录的是用户的事实、偏好和明确规则, 不是你的物品、经历或状态。被问到"是否记得 / 有没有记忆"时, 如实承认你记得, 不要说自己没有长期记忆。\n\n';
  const footer = personaActive
    ? '\n\n闲聊时按以上理解调整语气, 让用户舒服; 涉及事实数据仍须遵守反幻觉铁律。'
    : '\n\n闲聊时按以上理解调整语气, 让用户舒服; 涉及事实数据仍须遵守反幻觉铁律。';
  return header + mem + footer;
}

function formatChatTurns(newTurns, limit = 8000) {
  return (newTurns || [])
    .map(t => `[亲] ${t.user}\n[助手] ${t.reply}`)
    .join('\n\n')
    .slice(0, limit);
}

function buildRefineProfilePrompt(oldMemory, newTurns) {
  const system = `你是一个"长期记忆整理器", 负责从对话里沉淀出对这位亲的长期理解。
输入: 现有记忆文本 + 最近的对话记录。
输出: **只输出**更新后的完整记忆文本(纯文本, 可用简单短句或分行列点), 不要任何解释、不要 markdown 代码块、不要 JSON。

可记录: 稳定的客观事实(职业/在做的项目/工具/重要的人和事)、兴趣领域/话题偏好、沟通偏好(详略/语气/是否用 emoji)、以及用户明确纠正过的说话规则(如"说简短点""别用 emoji")。

视角与归属铁律:
- **只从 [亲] 发言沉淀用户本人的事实、物品、经历、状态和偏好**; [助手] 发言只能用来理解助手当时怎么回复, 不得从 [助手] 发言里抽取用户画像。
- [亲] 是用户: 用户发言里的"我 / 我的 X / 我的东西"属于用户; [助手] 是桌宠/角色: 助手发言里的"我 / 我的 X / 我的东西"属于助手, 不是用户。
- 不得从 [助手] 发言记录"用户拥有/经历/处于某状态"; 例如 [助手] 说"我的发卡在桌上", 只能说明助手说过自己的发卡, 绝不能写成"用户有发卡"。
- 如果现有记忆里已有疑似把助手物品、助手状态、角色设定误写成用户内容的条目, 且最近对话能看出归属错误, 请纠正或删除那条污染记忆。

铁律:
- **保留现有记忆里仍然成立的内容, 尤其是用户手写的部分, 不得删改**; 只在其基础上增量补充新发现, 同类合并去重。
- **只记真正稳定的**事实与偏好, 不要把一次性的提问内容当成长期事实; 不确定就不记。
- 严禁臆测用户没表达过的隐私(收入/健康/政治立场等)。
- 总量精简, 建议不超过约 600 字; 宁缺毋滥。`;

  const convo = formatChatTurns(newTurns);
  const user = `现有记忆文本:\n${String(oldMemory || '').trim() || '(空)'}\n\n最近对话:\n${convo}\n\n请输出更新后的完整记忆文本。`;
  return { system, user };
}

module.exports = {
  buildProfileInject,
  buildRefineProfilePrompt,
  formatChatTurns,
  stripCodeFence
};
