const test = require('node:test');
const assert = require('node:assert/strict');
const { STORY_KNOWLEDGE_HEADING, buildStoryLearningPrompt } = require('../../story/prompts');

test('story prompt asks for the fixed Story knowledge section', () => {
  const prompt = buildStoryLearningPrompt('旧知识', [
    { relativePath: '0_总纲.md', title: '总纲', tags: ['story'], body: '角色关系和成人互动氛围。' }
  ]);

  assert.equal(STORY_KNOWLEDGE_HEADING, '## Story 成人主题互动知识');
  assert.match(prompt, /旧知识/);
  assert.match(prompt, /0_总纲\.md/);
  assert.match(prompt, /Story 成人主题互动知识/);
  assert.match(prompt, /只输出这个小节/);
});

test('story prompt preserves fiction and safety boundaries', () => {
  const prompt = buildStoryLearningPrompt('', [
    { relativePath: 'Scene.md', title: 'Scene', tags: [], body: '捆绑 堵嘴 捂嘴 呼吸受限' }
  ]);

  assert.match(prompt, /故事内容不等于用户现实经历/);
  assert.match(prompt, /成年人、合意、虚构或明确创作语境/);
  assert.match(prompt, /不输出危险实操细节/);
  assert.match(prompt, /捆绑、堵嘴、捂嘴/);
  assert.match(prompt, /呼吸受限/);
});
