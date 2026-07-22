# Story Adult Interaction Learning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a manual Story learning flow that scans `/Users/ace/Documents/OneDayWorld/Story`, distills adult/BDSM interaction knowledge into long-term memory, and exposes it through CONFIG.

**Architecture:** Add a focused `story/` service beside the existing `obsidian/` service. The service scans Markdown notes with a safe adapter boundary, tracks fingerprints with `obsidian/sync-state.js`, asks the main process LLM wrapper to refine a bounded Story knowledge section, then replaces only `## Story 成人主题互动知识` inside the memory text. Main process owns API keys, IPC, and UI wiring.

**Tech Stack:** Electron main/preload IPC, Node.js CommonJS, `node:test`, existing `memory.js`, existing `obsidian/local-vault-adapter.js`, existing `obsidian/sync-state.js`.

---

## File Structure

- Create `story/index.js`: Story learning service, note batching, section replacement, sync status.
- Create `story/prompts.js`: prompt builder and Story knowledge heading constants.
- Create `test/story/service.test.js`: service tests for scanning, batching, unchanged files, and section replacement.
- Create `test/story/prompts.test.js`: prompt safety and source-boundary tests.
- Modify `store.js`: add and normalize `storyLearning` config.
- Create `test/store-story-learning-defaults.test.js`: default and normalization tests.
- Modify `main.js`: initialize Story service, add LLM refinement wrapper, add IPC handlers.
- Modify `preload.js`: expose `getStoryLearningConfig`, `setStoryLearningConfig`, `storyLearnNow`, `getStoryLearningStatus`.
- Modify `panel.html`: add CONFIG controls and status for Story learning.
- Modify `package.json` build files list: include `story/**/*`.

---

### Task 1: Story Prompt Builder

**Files:**
- Create: `story/prompts.js`
- Create: `test/story/prompts.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/story/prompts.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify RED**

Run: `npm test test/story/prompts.test.js`

Expected: FAIL with `Cannot find module '../../story/prompts'`.

- [ ] **Step 3: Implement minimal prompt module**

Create `story/prompts.js`:

```js
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
```

- [ ] **Step 4: Run tests to verify GREEN**

Run: `npm test test/story/prompts.test.js`

Expected: PASS, 2 tests passing.

- [ ] **Step 5: Commit**

```bash
git add story/prompts.js test/story/prompts.test.js
git commit -m "feat: add story learning prompt"
```

---

### Task 2: Story Service and Memory Section Replacement

**Files:**
- Create: `story/index.js`
- Create: `test/story/service.test.js`

- [ ] **Step 1: Write the failing service tests**

Create `test/story/service.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify RED**

Run: `npm test test/story/service.test.js`

Expected: FAIL with `Cannot find module '../../story'`.

- [ ] **Step 3: Implement `story/index.js`**

Create `story/index.js`:

```js
const { LocalVaultAdapter } = require('../obsidian/local-vault-adapter');
const { STORY_KNOWLEDGE_HEADING } = require('./prompts');

function noteCharLength(note) {
  return String((note && (note.body || note.content || note.title)) || '').length;
}

function batchNotesByChars(notes, maxChars) {
  const limit = Math.max(1, Number(maxChars) || 24000);
  const batches = [];
  let current = [];
  let currentChars = 0;
  for (const note of notes || []) {
    const chars = Math.max(1, noteCharLength(note));
    if (current.length && currentChars + chars > limit) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(note);
    currentChars += chars;
  }
  if (current.length) batches.push(current);
  return batches;
}

function saveNoteFingerprints(state, notes) {
  for (const n of notes || []) {
    const old = state.notes[n.relativePath] || {};
    state.notes[n.relativePath] = { mtimeMs: n.mtimeMs, size: n.size, hash: n.hash || old.hash || '' };
  }
}

function extractStoryKnowledgeSection(memoryText) {
  const text = String(memoryText || '').trim();
  if (!text) return '';
  const start = text.indexOf(STORY_KNOWLEDGE_HEADING);
  if (start < 0) return '';
  const rest = text.slice(start);
  const next = rest.slice(STORY_KNOWLEDGE_HEADING.length).search(/\n##\s(?!#)/);
  return (next >= 0 ? rest.slice(0, STORY_KNOWLEDGE_HEADING.length + next) : rest).trim();
}

function replaceStoryKnowledgeSection(memoryText, storySection) {
  const base = String(memoryText || '').trim();
  const section = String(storySection || '').trim();
  if (!section) return base;
  const start = base.indexOf(STORY_KNOWLEDGE_HEADING);
  if (start < 0) return [base, section].filter(Boolean).join('\n\n');
  const before = base.slice(0, start).trimEnd();
  const rest = base.slice(start);
  const next = rest.slice(STORY_KNOWLEDGE_HEADING.length).search(/\n##\s(?!#)/);
  const after = next >= 0 ? rest.slice(STORY_KNOWLEDGE_HEADING.length + next).trimStart() : '';
  return [before, section, after].filter(Boolean).join('\n\n');
}

function createStoryAdapter(config) {
  return new LocalVaultAdapter({
    vaultPath: config.storyPath,
    outputDir: 'Macross',
    excludeDirs: ['.obsidian', 'Macross']
  });
}

function createStoryLearningService(deps) {
  const config = deps.config || {};
  const adapter = deps.adapter || createStoryAdapter(config);
  const syncStore = deps.syncStore;
  const getMemoryText = deps.getMemoryText;
  const setMemoryText = deps.setMemoryText;
  const refineStoryKnowledge = deps.refineStoryKnowledge;
  const status = { ok: true, lastLearnAt: null, scannedFiles: 0, changedFiles: 0, memoryChanged: false, lastError: '' };

  function enabled() {
    return config.enabled !== false;
  }

  function setStatus(next) {
    Object.assign(status, next);
    return Object.assign({}, status);
  }

  async function learnNow() {
    if (!enabled()) return setStatus({ ok: true, skipped: true, lastError: '' });
    try {
      const state = syncStore.load();
      const all = await adapter.listNotes();
      const changed = await adapter.getChangedNotes(state, all);
      status.scannedFiles = all.length;
      status.changedFiles = changed.length;
      let memoryChanged = false;
      if (changed.length) {
        const notes = [];
        for (const n of changed) {
          notes.push(Object.assign(await adapter.readNote(n), {
            mtimeMs: n.mtimeMs,
            size: n.size,
            hash: n.hash
          }));
        }
        let currentMemory = String(getMemoryText() || '');
        let currentSection = extractStoryKnowledgeSection(currentMemory);
        for (const batch of batchNotesByChars(notes, config.maxBatchChars)) {
          const nextSection = await refineStoryKnowledge(currentSection, batch);
          if (nextSection && String(nextSection).trim()) {
            currentSection = String(nextSection).trim();
            currentMemory = replaceStoryKnowledgeSection(currentMemory, currentSection);
            setMemoryText(currentMemory);
            memoryChanged = true;
          }
          saveNoteFingerprints(state, batch);
          syncStore.save(state);
        }
      }
      saveNoteFingerprints(state, all);
      state.lastLearnAt = new Date().toISOString();
      syncStore.save(state);
      return setStatus({ ok: true, skipped: false, lastLearnAt: state.lastLearnAt, memoryChanged, lastError: '' });
    } catch (e) {
      return setStatus({ ok: false, skipped: false, memoryChanged: false, lastError: e.message });
    }
  }

  return { learnNow, getStatus: () => Object.assign({}, status) };
}

module.exports = {
  STORY_KNOWLEDGE_HEADING,
  batchNotesByChars,
  extractStoryKnowledgeSection,
  replaceStoryKnowledgeSection,
  createStoryLearningService
};
```

- [ ] **Step 4: Run tests to verify GREEN**

Run: `npm test test/story/service.test.js`

Expected: PASS, 5 tests passing.

- [ ] **Step 5: Run Story test group**

Run: `npm test test/story`

Expected: PASS, all Story tests passing.

- [ ] **Step 6: Commit**

```bash
git add story/index.js test/story/service.test.js
git commit -m "feat: add story learning service"
```

---

### Task 3: Store Configuration

**Files:**
- Modify: `store.js`
- Create: `test/store-story-learning-defaults.test.js`

- [ ] **Step 1: Write failing store tests**

Create `test/store-story-learning-defaults.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function withFreshStore(data, fn) {
  const oldHome = process.env.HOME;
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vf1-store-home-'));
  if (data) {
    const dataDir = path.join(process.env.HOME, '.desktop-pet');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'data.json'), JSON.stringify(data));
  }
  delete require.cache[require.resolve('../store')];
  try {
    const store = require('../store');
    fn(store.load());
  } finally {
    process.env.HOME = oldHome;
    delete require.cache[require.resolve('../store')];
  }
}

test('store default state includes Story learning configuration', () => {
  withFreshStore(null, (state) => {
    assert.equal(state.storyLearning.enabled, true);
    assert.equal(state.storyLearning.storyPath, '/Users/ace/Documents/OneDayWorld/Story');
    assert.equal(state.storyLearning.autoSync, false);
    assert.equal(state.storyLearning.maxBatchChars, 24000);
  });
});

test('store normalizes Story learning maxBatchChars', () => {
  withFreshStore({ storyLearning: { maxBatchChars: 0, storyPath: '' } }, (state) => {
    assert.equal(state.storyLearning.maxBatchChars, 1);
    assert.equal(state.storyLearning.storyPath, '/Users/ace/Documents/OneDayWorld/Story');
  });
});
```

- [ ] **Step 2: Run tests to verify RED**

Run: `npm test test/store-story-learning-defaults.test.js`

Expected: FAIL because `state.storyLearning` is undefined.

- [ ] **Step 3: Add defaults and normalization**

Modify `store.js`:

```js
const DEFAULT_STATE = {
  // existing fields stay unchanged
  obsidian: {
    enabled: false,
    vaultPath: '/Users/ace/Documents/OneDayWorld',
    readMode: 'root',
    includeTags: [],
    excludeDirs: ['.obsidian', 'Macross'],
    outputDir: 'Macross',
    autoSync: true,
    autoWriteBack: true,
    syncIntervalMin: 30,
    writeBackEveryTurns: 10
  },
  storyLearning: {
    enabled: true,
    storyPath: '/Users/ace/Documents/OneDayWorld/Story',
    autoSync: false,
    maxBatchChars: 24000
  },
  voiceLang: 'zh',
  // rest of existing fields
};
```

In `load()`, after Obsidian normalization, add:

```js
merged.storyLearning = Object.assign({}, DEFAULT_STATE.storyLearning, merged.storyLearning || {});
merged.storyLearning.enabled = merged.storyLearning.enabled !== false;
merged.storyLearning.storyPath = String(merged.storyLearning.storyPath || DEFAULT_STATE.storyLearning.storyPath);
merged.storyLearning.autoSync = merged.storyLearning.autoSync === true;
merged.storyLearning.maxBatchChars = normalizePositiveInt(merged.storyLearning.maxBatchChars, DEFAULT_STATE.storyLearning.maxBatchChars);
```

- [ ] **Step 4: Run tests to verify GREEN**

Run: `npm test test/store-story-learning-defaults.test.js test/store-obsidian-defaults.test.js`

Expected: PASS, Story and Obsidian store tests passing.

- [ ] **Step 5: Commit**

```bash
git add store.js test/store-story-learning-defaults.test.js
git commit -m "feat: add story learning config"
```

---

### Task 4: Main Process IPC and LLM Refinement

**Files:**
- Modify: `main.js`
- Modify: `package.json`

- [ ] **Step 1: Write a failing integration-style test using the service seam**

Add a test to `test/story/service.test.js`:

```js
test('learnNow reports disabled Story learning as skipped', async () => {
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vf1-story-state-')), 'state.json');
  const service = createStoryLearningService({
    config: { enabled: false, storyPath: '/fake', maxBatchChars: 24000 },
    syncStore: createSyncStateStore(stateFile),
    adapter: {
      listNotes: async () => { throw new Error('disabled service should not scan'); },
      getChangedNotes: async () => [],
      readNote: async () => null
    },
    getMemoryText: () => '',
    setMemoryText: () => {},
    refineStoryKnowledge: async () => ''
  });

  const result = await service.learnNow();

  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
});
```

- [ ] **Step 2: Run test to verify RED or current behavior**

Run: `npm test test/story/service.test.js`

Expected: PASS if Task 2 already implemented `enabled()`, otherwise FAIL and fix Task 2 before modifying `main.js`.

- [ ] **Step 3: Wire Story service in `main.js`**

At the top of `main.js`, add:

```js
const { createStoryLearningService } = require('./story');
const { buildStoryLearningPrompt } = require('./story/prompts');
```

Near Obsidian service globals, add:

```js
let storyLearningService = null;
```

Add defaults and normalization near `DEFAULT_OBSIDIAN_CONFIG`:

```js
const DEFAULT_STORY_LEARNING_CONFIG = {
  enabled: true,
  storyPath: '/Users/ace/Documents/OneDayWorld/Story',
  autoSync: false,
  maxBatchChars: 24000
};

function normalizeStoryLearningConfig(cfg) {
  const src = Object.assign({}, DEFAULT_STORY_LEARNING_CONFIG, cfg || {});
  return {
    enabled: src.enabled !== false,
    storyPath: String(src.storyPath || DEFAULT_STORY_LEARNING_CONFIG.storyPath),
    autoSync: src.autoSync === true,
    maxBatchChars: normalizePositiveInt(src.maxBatchChars, DEFAULT_STORY_LEARNING_CONFIG.maxBatchChars)
  };
}
```

Add refinement helper near `refineFromObsidianNotes`:

```js
async function refineFromStoryNotes(oldStoryKnowledge, notes) {
  const provider = state.aiProvider || 'qwen';
  const apiKey = (state.apiKeys || {})[provider] || '';
  if (!apiKey) throw new Error('请先在设置中填写 API Key 后再学习 Story 文档');
  const metasoKey = (state.apiKeys || {}).metaso || '';
  const system = `你是桌宠的成人主题互动知识整理器。只从 Story 文档提炼创作语境、互动偏好和安全边界。故事内容不等于用户现实经历; 不输出危险实操细节; 只输出指定 Markdown 小节。`;
  return callAI(provider, apiKey, state.pet.name, [], buildStoryLearningPrompt(oldStoryKnowledge, notes), metasoKey, {
    systemOverride: system,
    noTools: true,
    temperature: 0.25
  });
}
```

Add initialization near `initObsidianService()`:

```js
function initStoryLearningService() {
  storyLearningService = createStoryLearningService({
    config: state.storyLearning || DEFAULT_STORY_LEARNING_CONFIG,
    syncStore: createSyncStateStore(path.join(memory.MEM_DIR, 'story-learning-sync.json')),
    getMemoryText: () => memory.getMemoryText(),
    setMemoryText: (txt) => memory.setMemoryText(txt),
    refineStoryKnowledge: refineFromStoryNotes
  });
}
```

Call it in `app.whenReady()` after `initObsidianService();`:

```js
initStoryLearningService();
```

Add IPC handlers near Obsidian IPC:

```js
ipcMain.handle('get-story-learning-config', () => state.storyLearning || DEFAULT_STORY_LEARNING_CONFIG);

ipcMain.handle('set-story-learning-config', (_, cfg) => {
  try {
    state.storyLearning = normalizeStoryLearningConfig(Object.assign({}, state.storyLearning || {}, cfg || {}));
    store.save(state);
    initStoryLearningService();
    return { ok: true, config: state.storyLearning };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('story-learn-now', async () => {
  if (!storyLearningService) initStoryLearningService();
  return storyLearningService.learnNow();
});

ipcMain.handle('get-story-learning-status', () => {
  if (!storyLearningService) initStoryLearningService();
  return storyLearningService.getStatus();
});
```

Modify `package.json` build `files` list to include:

```json
"story/**/*",
```

- [ ] **Step 4: Run tests**

Run: `npm test test/story test/store-story-learning-defaults.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add main.js package.json test/story/service.test.js
git commit -m "feat: wire story learning ipc"
```

---

### Task 5: Preload and CONFIG Panel Controls

**Files:**
- Modify: `preload.js`
- Modify: `panel.html`

- [ ] **Step 1: Add preload API**

Modify `preload.js` inside the `petAPI` object passed to `contextBridge.exposeInMainWorld`:

```js
  getStoryLearningConfig: () => ipcRenderer.invoke('get-story-learning-config'),
  setStoryLearningConfig: (cfg) => ipcRenderer.invoke('set-story-learning-config', cfg),
  storyLearnNow: () => ipcRenderer.invoke('story-learn-now'),
  getStoryLearningStatus: () => ipcRenderer.invoke('get-story-learning-status'),
```

- [ ] **Step 2: Add CONFIG UI markup**

In `panel.html`, near the Obsidian CONFIG block, add:

```html
    <h3>STORY · 成人主题互动知识</h3>
    <label class="setting-toggle">
      <span>启用 Story 学习入口</span>
      <input type="checkbox" id="story-learning-enabled">
    </label>
    <div class="setting-label">Story 路径</div>
    <input class="setting-input" id="story-learning-path" placeholder="/Users/ace/Documents/OneDayWorld/Story" />
    <div class="key-row obsidian-actions" style="margin-top:10px">
      <button class="secondary-btn" onclick="saveStoryLearningConfig()">保存 Story 设置</button>
      <button class="secondary-btn" onclick="learnStoryNow()">学习 Story 文档</button>
    </div>
    <div class="setting-note" id="story-learning-status" style="margin-top:8px">未学习</div>
```

- [ ] **Step 3: Add panel JavaScript**

Add functions near existing Obsidian functions:

```js
function setStoryLearningStatus(text) {
  const el = document.getElementById('story-learning-status');
  if (el) el.textContent = text;
}

function getStoryLearningEls() {
  const els = {
    enabled: document.getElementById('story-learning-enabled'),
    storyPath: document.getElementById('story-learning-path'),
    status: document.getElementById('story-learning-status')
  };
  const missing = Object.entries(els).filter(([, el]) => !el).map(([name]) => name);
  if (missing.length) {
    console.log('[STORY] missing DOM elements:', missing.join(', '));
    return null;
  }
  return els;
}

async function loadStoryLearningConfig() {
  const els = getStoryLearningEls();
  if (!els || !window.petAPI || !window.petAPI.getStoryLearningConfig) return;
  try {
    const cfg = await window.petAPI.getStoryLearningConfig();
    els.enabled.checked = cfg.enabled !== false;
    els.storyPath.value = cfg.storyPath || '/Users/ace/Documents/OneDayWorld/Story';
    await refreshStoryLearningStatus();
  } catch (e) {
    setStoryLearningStatus(`加载失败: ${e.message || '未知错误'}`);
  }
}

async function saveStoryLearningConfig(options = {}) {
  const els = getStoryLearningEls();
  if (!els || !window.petAPI || !window.petAPI.setStoryLearningConfig) return false;
  const cfg = {
    enabled: els.enabled.checked,
    storyPath: ((els.storyPath.value || '/Users/ace/Documents/OneDayWorld/Story').trim() || '/Users/ace/Documents/OneDayWorld/Story')
  };
  try {
    const res = await window.petAPI.setStoryLearningConfig(cfg);
    if (!res || res.ok === false) {
      setStoryLearningStatus(`保存失败: ${(res && res.error) || '未知错误'}`);
      return false;
    }
    if (!options.silentSuccess) setStoryLearningStatus('已保存 Story 设置');
    return true;
  } catch (e) {
    setStoryLearningStatus(`保存失败: ${e.message || '未知错误'}`);
    return false;
  }
}

async function refreshStoryLearningStatus() {
  if (!window.petAPI || !window.petAPI.getStoryLearningStatus) return;
  try {
    const status = await window.petAPI.getStoryLearningStatus();
    if (status && status.lastError) {
      setStoryLearningStatus(`上次失败: ${status.lastError}`);
    } else if (status && status.lastLearnAt) {
      setStoryLearningStatus(`上次学习: ${status.lastLearnAt} · 扫描 ${status.scannedFiles || 0} 个文件, 变更 ${status.changedFiles || 0} 个`);
    } else {
      setStoryLearningStatus('未学习');
    }
  } catch (e) {
    setStoryLearningStatus(`状态读取失败: ${e.message || '未知错误'}`);
  }
}

async function learnStoryNow() {
  setStoryLearningStatus('学习前保存设置中');
  const saved = await saveStoryLearningConfig({ silentSuccess: true });
  if (!saved || !window.petAPI || !window.petAPI.storyLearnNow) return;
  setStoryLearningStatus('学习中');
  try {
    const res = await window.petAPI.storyLearnNow();
    setStoryLearningStatus(res && res.ok !== false
      ? `学习完成: 扫描 ${res.scannedFiles || 0} 个文件, 变更 ${res.changedFiles || 0} 个${res.memoryChanged ? ', 已更新记忆' : ''}`
      : `学习失败: ${(res && res.lastError) || (res && res.error) || '未知错误'}`);
  } catch (e) {
    setStoryLearningStatus(`学习失败: ${e.message || '未知错误'}`);
  }
}
```

Where CONFIG initializes existing settings, add:

```js
loadStoryLearningConfig();
```

- [ ] **Step 4: Run static sanity checks**

Run: `npm test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add preload.js panel.html
git commit -m "feat: add story learning config controls"
```

---

### Task 6: End-to-End Verification

**Files:**
- No required file edits unless verification exposes a bug.

- [ ] **Step 1: Run all automated tests**

Run: `npm test`

Expected: PASS, all `node --test` suites pass.

- [ ] **Step 2: Run packaging surface check**

Run: `node -e "const pkg=require('./package.json'); if(!pkg.build.files.includes('story/**/*')) throw new Error('story files missing from build config'); console.log('story files included')"`

Expected: `story files included`

- [ ] **Step 3: Optional runtime smoke test**

Run: `npm start`

Expected: Electron app launches. In CONFIG, Story learning controls are visible. Clicking “学习 Story 文档” shows a learning status. If no API key is configured, status should show `请先在设置中填写 API Key 后再学习 Story 文档`.

- [ ] **Step 4: Commit any verification fixes**

Only if Step 1, 2, or 3 required fixes:

```bash
git add <changed-files>
git commit -m "fix: harden story learning verification"
```

---

## Self-Review

- Spec coverage: The plan covers Story-only scanning, dedicated prompt, memory section replacement, manual CONFIG trigger, API-key-gated LLM refinement, safe fiction/adult boundaries, tests, and build inclusion.
- Placeholder scan: No placeholder steps remain. Code snippets define the key functions and IPC names used later.
- Type consistency: Config uses `storyLearning`, IPC uses `story-learning-*`, service API uses `learnNow()` and `getStatus()`, prompt exports `STORY_KNOWLEDGE_HEADING` and `buildStoryLearningPrompt()`.
