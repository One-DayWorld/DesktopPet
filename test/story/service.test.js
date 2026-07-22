const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createSyncStateStore } = require('../../obsidian/sync-state');
const {
  STORY_KNOWLEDGE_HEADING,
  batchNotesByChars,
  extractStoryKnowledgeSection,
  replaceStoryKnowledgeSection,
  createStoryLearningService
} = require('../../story');

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

test('replaceStoryKnowledgeSection appends and then replaces only the Story section', () => {
  const base = '已知事实:\n- 用户喜欢本地工具。';
  const firstSection = `${STORY_KNOWLEDGE_HEADING}\n\n### 题材与术语理解\n第一版`;
  const secondSection = `${STORY_KNOWLEDGE_HEADING}\n\n### 题材与术语理解\n第二版`;

  const appended = replaceStoryKnowledgeSection(base, firstSection);
  assert.match(appended, /用户喜欢本地工具/);
  assert.match(appended, /第一版/);

  const replaced = replaceStoryKnowledgeSection(appended, secondSection);
  assert.match(replaced, /用户喜欢本地工具/);
  assert.match(replaced, /第二版/);
  assert.doesNotMatch(replaced, /第一版/);
  assert.equal((replaced.match(/## Story 成人主题互动知识/g) || []).length, 1);
});

test('extractStoryKnowledgeSection returns existing Story section only', () => {
  const memory = `其他记忆\n\n${STORY_KNOWLEDGE_HEADING}\n\n### 安全边界\n只在创作语境使用。\n\n## 其他小节\n保留`;

  assert.equal(
    extractStoryKnowledgeSection(memory),
    `${STORY_KNOWLEDGE_HEADING}\n\n### 安全边界\n只在创作语境使用。`
  );
});

test('batchNotesByChars splits notes by configured character budget', () => {
  const notes = [
    { relativePath: 'A.md', body: '12345' },
    { relativePath: 'B.md', body: '12345' },
    { relativePath: 'C.md', body: '12345' }
  ];

  assert.deepEqual(batchNotesByChars(notes, 10).map(batch => batch.map(n => n.relativePath)), [
    ['A.md', 'B.md'],
    ['C.md']
  ]);
});

test('learnNow scans changed Story markdown and updates memory section', async () => {
  const storyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vf1-story-'));
  write(path.join(storyRoot, '0_总纲.md'), '# 总纲\n成人互动氛围。');
  write(path.join(storyRoot, 'Assets', 'image.png'), 'png');
  const stateFile = path.join(storyRoot, 'state.json');
  let memoryText = '已知事实:\n- 用户使用 Macross。';
  const refineCalls = [];
  const service = createStoryLearningService({
    config: { enabled: true, storyPath: storyRoot, maxBatchChars: 24000 },
    syncStore: createSyncStateStore(stateFile),
    getMemoryText: () => memoryText,
    setMemoryText: (txt) => { memoryText = txt; },
    refineStoryKnowledge: async (oldSection, notes) => {
      refineCalls.push({ oldSection, paths: notes.map(n => n.relativePath) });
      return `${STORY_KNOWLEDGE_HEADING}\n\n### 题材与术语理解\n理解 Story 成人互动语境。`;
    }
  });

  const result = await service.learnNow();

  assert.equal(result.ok, true);
  assert.equal(result.scannedFiles, 1);
  assert.equal(result.changedFiles, 1);
  assert.equal(result.memoryChanged, true);
  assert.deepEqual(refineCalls, [{ oldSection: '', paths: ['0_总纲.md'] }]);
  assert.match(memoryText, /用户使用 Macross/);
  assert.match(memoryText, /理解 Story 成人互动语境/);
  assert.equal(createSyncStateStore(stateFile).load().notes['0_总纲.md'].hash.length, 64);
});

test('learnNow skips refinement when files are unchanged', async () => {
  const storyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vf1-story-'));
  write(path.join(storyRoot, 'Scene.md'), '# Scene\n内容。');
  const stateFile = path.join(storyRoot, 'state.json');
  let calls = 0;
  const service = createStoryLearningService({
    config: { enabled: true, storyPath: storyRoot, maxBatchChars: 24000 },
    syncStore: createSyncStateStore(stateFile),
    getMemoryText: () => '',
    setMemoryText: () => {},
    refineStoryKnowledge: async () => {
      calls += 1;
      return `${STORY_KNOWLEDGE_HEADING}\n\n### 安全边界\n只在创作语境使用。`;
    }
  });

  await service.learnNow();
  const second = await service.learnNow();

  assert.equal(second.ok, true);
  assert.equal(second.changedFiles, 0);
  assert.equal(calls, 1);
});
