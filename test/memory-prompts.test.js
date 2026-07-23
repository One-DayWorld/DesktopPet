const test = require('node:test');
const assert = require('node:assert/strict');

const { buildRefineProfilePrompt } = require('../memory-prompts');

test('profile refinement prompt keeps user and assistant possessions separate', () => {
  const prompt = buildRefineProfilePrompt('旧记忆', [
    { user: '我的笔记本放桌上了', reply: '我的发卡也在桌上，别把它当成你的。' }
  ]);

  assert.match(prompt.system, /只从\s*\[亲\]\s*发言/);
  assert.match(prompt.system, /不得从\s*\[助手\]\s*发言/);
  assert.match(prompt.system, /助手.*我的.*属于助手/);
  assert.match(prompt.system, /用户.*我的.*属于用户/);
  assert.match(prompt.system, /纠正|删除/);
  assert.match(prompt.user, /\[亲\] 我的笔记本放桌上了/);
  assert.match(prompt.user, /\[助手\] 我的发卡也在桌上/);
});
