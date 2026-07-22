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

test('story prompt tolerates empty notes and missing note fields', () => {
  assert.doesNotThrow(() => buildStoryLearningPrompt('', [
    null,
    undefined,
    {},
    { relativePath: '  Scene \n One.md  ', title: '  Scene\tOne  ', tags: ['  story\nnote  '] }
  ]));

  const prompt = buildStoryLearningPrompt('', [
    null,
    undefined,
    {},
    { relativePath: '  Scene \n One.md  ', title: '  Scene\tOne  ', tags: ['  story\nnote  '] }
  ]);

  assert.match(prompt, /Story 变更文档/);
  assert.match(prompt, /Scene One\.md/);
  assert.match(prompt, /标题: Scene One/);
  assert.match(prompt, /标签: story note/);
});

test('story prompt limits old knowledge and each note body length', () => {
  const oldTail = 'OLD_TAIL_SHOULD_NOT_APPEAR';
  const noteTail = 'NOTE_TAIL_SHOULD_NOT_APPEAR';
  const oldStoryKnowledge = `${'旧'.repeat(4000)}${oldTail}`;
  const notes = Array.from({ length: 4 }, (_, index) => ({
    relativePath: `Scene-${index}.md`,
    title: `Scene ${index}`,
    tags: ['story'],
    body: `${String(index).repeat(8000)}${noteTail}`
  }));

  const prompt = buildStoryLearningPrompt(oldStoryKnowledge, notes);

  assert.doesNotMatch(prompt, new RegExp(oldTail));
  assert.doesNotMatch(prompt, new RegExp(noteTail));
  assert.equal((prompt.match(/正文:/g) || []).length, 4);
  for (let index = 0; index < 4; index += 1) {
    assert.match(prompt, new RegExp(`Scene-${index}\\.md`));
    assert.match(prompt, new RegExp(`标题: Scene ${index}`));
  }
});
