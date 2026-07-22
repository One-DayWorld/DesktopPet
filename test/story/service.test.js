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

test('Story heading must be an independent level-2 heading line', () => {
  const memory = `正文提到 ${STORY_KNOWLEDGE_HEADING} 只是普通文本。\n- ${STORY_KNOWLEDGE_HEADING} 也只是列表内容。`;
  const section = `${STORY_KNOWLEDGE_HEADING}\n\n### 安全边界\n只在创作语境使用。`;

  assert.equal(extractStoryKnowledgeSection(memory), '');

  const replaced = replaceStoryKnowledgeSection(memory, section);
  assert.match(replaced, /普通文本/);
  assert.match(replaced, /列表内容/);
  assert.equal((replaced.match(/^## Story 成人主题互动知识\s*$/gm) || []).length, 1);
});

test('four-backtick fences keep shorter backtick fences from exposing Story headings', () => {
  const memory = [
    '````js',
    'const hidden = `',
    '```',
    STORY_KNOWLEDGE_HEADING,
    '```',
    '`;',
    '````',
    '代码块后内容'
  ].join('\n');
  const section = `${STORY_KNOWLEDGE_HEADING}\n\n### 安全边界\n新版`;

  assert.equal(extractStoryKnowledgeSection(memory), '');

  const replaced = replaceStoryKnowledgeSection(memory, section);
  assert.match(replaced, /const hidden/);
  assert.match(replaced, /代码块后内容/);
  assert.match(replaced, /### 安全边界\n新版/);
});

test('four-tilde fences keep shorter tilde fences from exposing Story headings', () => {
  const memory = [
    '~~~~md',
    '嵌套样例',
    '~~~',
    STORY_KNOWLEDGE_HEADING,
    '~~~',
    '~~~~',
    '波浪围栏后内容'
  ].join('\n');
  const section = `${STORY_KNOWLEDGE_HEADING}\n\n### 题材与术语理解\n新版`;

  assert.equal(extractStoryKnowledgeSection(memory), '');

  const replaced = replaceStoryKnowledgeSection(memory, section);
  assert.match(replaced, /嵌套样例/);
  assert.match(replaced, /波浪围栏后内容/);
  assert.match(replaced, /### 题材与术语理解\n新版/);
});

test('replaceStoryKnowledgeSection removes duplicate Story sections and keeps non-Story sections', () => {
  const memory = `开头记忆\n\n${STORY_KNOWLEDGE_HEADING}\n\n旧版一\n\n## 其他小节 A\n保留 A\n\n${STORY_KNOWLEDGE_HEADING}\n\n旧版二\n\n## 其他小节 B\n保留 B`;
  const section = `${STORY_KNOWLEDGE_HEADING}\n\n### 题材与术语理解\n新版`;

  const replaced = replaceStoryKnowledgeSection(memory, section);

  assert.match(replaced, /开头记忆/);
  assert.match(replaced, /保留 A/);
  assert.match(replaced, /保留 B/);
  assert.match(replaced, /新版/);
  assert.doesNotMatch(replaced, /旧版一/);
  assert.doesNotMatch(replaced, /旧版二/);
  assert.equal((replaced.match(/^## Story 成人主题互动知识\s*$/gm) || []).length, 1);
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

test('learnNow retries changed notes when refinement returns blank', async () => {
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
      return '   ';
    }
  });

  const first = await service.learnNow();
  const stateAfterFirst = createSyncStateStore(stateFile).load();
  const second = await service.learnNow();

  assert.equal(first.ok, true);
  assert.equal(first.memoryChanged, false);
  assert.equal(stateAfterFirst.notes['Scene.md'], undefined);
  assert.equal(second.changedFiles, 1);
  assert.equal(calls, 2);
});

test('learnNow keeps successful batch state when a later batch fails', async () => {
  const storyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vf1-story-'));
  write(path.join(storyRoot, 'A.md'), '# A\n12345');
  write(path.join(storyRoot, 'B.md'), '# B\n12345');
  const stateFile = path.join(storyRoot, 'state.json');
  let memoryText = '';
  let calls = 0;
  const service = createStoryLearningService({
    config: { enabled: true, storyPath: storyRoot, maxBatchChars: 6 },
    syncStore: createSyncStateStore(stateFile),
    getMemoryText: () => memoryText,
    setMemoryText: (txt) => { memoryText = txt; },
    refineStoryKnowledge: async (_oldSection, notes) => {
      calls += 1;
      if (calls === 2) throw new Error('refine failed');
      return `${STORY_KNOWLEDGE_HEADING}\n\n### 题材与术语理解\n已学习 ${notes[0].relativePath}`;
    }
  });

  const result = await service.learnNow();
  const state = createSyncStateStore(stateFile).load();

  assert.equal(result.ok, false);
  assert.equal(result.memoryChanged, true);
  assert.match(result.lastError, /refine failed/);
  assert.match(memoryText, /已学习 A\.md/);
  assert.equal(state.notes['A.md'].hash.length, 64);
  assert.equal(state.notes['B.md'], undefined);
});
