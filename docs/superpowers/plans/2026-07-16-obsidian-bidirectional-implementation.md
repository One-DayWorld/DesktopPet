# Obsidian Bidirectional Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local-first Obsidian integration that reads `/Users/ace/Documents/OneDayWorld/**/*.md` into VF-1 memory and automatically writes useful chat summaries back to `Macross/`.

**Architecture:** Add a focused `obsidian/` module with a swappable adapter interface, a local vault adapter for the first version, sync-state persistence, markdown parsing, prompt helpers, and a service facade used by `main.js`. Keep Obsidian file-system details out of chat and memory code so a future Local REST API adapter can implement the same adapter methods.

**Tech Stack:** Electron 28 main process, Node.js `fs/path/crypto/os`, built-in `node:test`, existing `store.js`, `memory.js`, `main.js`, `preload.js`, and `panel.html`.

---

## File Structure

- Create `obsidian/markdown.js`: Markdown metadata extraction, frontmatter parsing, body cleanup, tag extraction, and safe text clipping.
- Create `obsidian/sync-state.js`: Read/write `~/.desktop-pet/obsidian-sync.json` with `0600` file permissions and merge defaults.
- Create `obsidian/local-vault-adapter.js`: Recursively scan vault Markdown files, exclude `.obsidian`, hidden paths, and output directory, and read/write/append notes.
- Create `obsidian/prompts.js`: Prompt builders for Obsidian-to-memory refinement and chat write-back extraction.
- Create `obsidian/index.js`: Service facade that creates adapters, finds changed notes, runs LLM callback hooks, writes profile/inbox/highlights, and returns status.
- Create `test/obsidian/*.test.js`: Node test coverage for markdown parsing, sync-state persistence, local vault scanning, and write-back behavior.
- Modify `store.js`: Add default `obsidian` config and deep-merge it during load.
- Modify `main.js`: Initialize Obsidian service, add IPC handlers, schedule sync/write-back, integrate changed-note refinement and chat write-back buffering.
- Modify `preload.js`: Expose Obsidian IPC methods.
- Modify `panel.html`: Add CONFIG Obsidian controls and status UI.
- Modify `package.json`: Add a `test` script that runs `node --test`.

## Task 1: Test Harness And Store Defaults

**Files:**
- Modify: `package.json`
- Modify: `store.js`
- Create: `test/store-obsidian-defaults.test.js`

- [ ] **Step 1: Add a test script**

In `package.json`, add:

```json
"test": "node --test"
```

Keep the existing `start`, `build`, and `build:lite` scripts unchanged.

- [ ] **Step 2: Write the failing store default test**

Create `test/store-obsidian-defaults.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

test('store default state includes local Obsidian configuration', () => {
  const oldHome = process.env.HOME;
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vf1-store-home-'));
  delete require.cache[require.resolve('../store')];
  try {
    const store = require('../store');
    const state = store.load();

    assert.equal(state.obsidian.enabled, false);
    assert.equal(state.obsidian.vaultPath, '/Users/ace/Documents/OneDayWorld');
    assert.equal(state.obsidian.outputDir, 'Macross');
    assert.equal(state.obsidian.autoSync, true);
    assert.equal(state.obsidian.autoWriteBack, true);
    assert.equal(state.obsidian.syncIntervalMin, 30);
    assert.equal(state.obsidian.writeBackEveryTurns, 10);
    assert.deepEqual(state.obsidian.excludeDirs, ['.obsidian', 'Macross']);
  } finally {
    process.env.HOME = oldHome;
    delete require.cache[require.resolve('../store')];
  }
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run:

```bash
npm test -- test/store-obsidian-defaults.test.js
```

Expected: FAIL with an assertion or type error because `state.obsidian` is not defined.

- [ ] **Step 4: Implement store defaults**

In `store.js`, add this field to `DEFAULT_STATE`:

```js
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
}
```

In `load()`, after the existing `merged.edgePatrol` merge, add:

```js
merged.obsidian = Object.assign({}, DEFAULT_STATE.obsidian, merged.obsidian || {});
if (!Array.isArray(merged.obsidian.includeTags)) merged.obsidian.includeTags = [];
if (!Array.isArray(merged.obsidian.excludeDirs)) merged.obsidian.excludeDirs = DEFAULT_STATE.obsidian.excludeDirs.slice();
merged.obsidian.vaultPath = String(merged.obsidian.vaultPath || DEFAULT_STATE.obsidian.vaultPath);
merged.obsidian.outputDir = String(merged.obsidian.outputDir || DEFAULT_STATE.obsidian.outputDir);
merged.obsidian.syncIntervalMin = Math.max(1, Number(merged.obsidian.syncIntervalMin) || DEFAULT_STATE.obsidian.syncIntervalMin);
merged.obsidian.writeBackEveryTurns = Math.max(1, Number(merged.obsidian.writeBackEveryTurns) || DEFAULT_STATE.obsidian.writeBackEveryTurns);
```

- [ ] **Step 5: Run the test to verify it passes**

Run:

```bash
npm test -- test/store-obsidian-defaults.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json store.js test/store-obsidian-defaults.test.js
git commit -m "feat(obsidian): add default sync config"
```

## Task 2: Markdown Parsing Utilities

**Files:**
- Create: `obsidian/markdown.js`
- Create: `test/obsidian/markdown.test.js`

- [ ] **Step 1: Write failing parser tests**

Create `test/obsidian/markdown.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMarkdownNote, clipText } = require('../../obsidian/markdown');

test('parseMarkdownNote extracts title, frontmatter, tags, and clean body', () => {
  const note = parseMarkdownNote({
    path: '/vault/Projects/Test.md',
    relativePath: 'Projects/Test.md',
    content: [
      '---',
      'tags: [project, vf1]',
      'owner: Ace',
      '---',
      '# Test Project',
      '',
      '正文带有 #idea 和 [[Wiki Link]]。',
      '```js',
      'const hidden = true;',
      '```'
    ].join('\n')
  });

  assert.equal(note.title, 'Test Project');
  assert.equal(note.frontmatter.owner, 'Ace');
  assert.deepEqual(note.tags.sort(), ['idea', 'project', 'vf1']);
  assert.match(note.body, /正文带有/);
  assert.doesNotMatch(note.body, /const hidden/);
});

test('clipText limits long text without throwing', () => {
  assert.equal(clipText('abcdef', 3), 'abc');
  assert.equal(clipText('', 3), '');
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
npm test -- test/obsidian/markdown.test.js
```

Expected: FAIL with module not found for `../../obsidian/markdown`.

- [ ] **Step 3: Implement markdown utilities**

Create `obsidian/markdown.js`:

```js
function clipText(text, maxChars) {
  const s = String(text || '');
  const n = Math.max(0, Number(maxChars) || 0);
  return n && s.length > n ? s.slice(0, n) : s;
}

function parseFrontmatter(raw) {
  const frontmatter = {};
  let body = String(raw || '');
  const match = body.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { frontmatter, body };
  body = body.slice(match[0].length);
  for (const line of match[1].split('\n')) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const val = m[2].trim();
    if (/^\[.*\]$/.test(val)) {
      frontmatter[key] = val.slice(1, -1).split(',').map(x => x.trim()).filter(Boolean);
    } else {
      frontmatter[key] = val.replace(/^['"]|['"]$/g, '');
    }
  }
  return { frontmatter, body };
}

function cleanBody(markdown) {
  return String(markdown || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*]\([^)]+\)/g, '')
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/\[\[([^\]|]+)\|?([^\]]*)]]/g, (_, a, b) => b || a)
    .replace(/^[ \t]*#{1,6}\s+/gm, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractTags(body, frontmatter) {
  const tags = new Set();
  const fmTags = frontmatter.tags;
  if (Array.isArray(fmTags)) fmTags.forEach(t => tags.add(String(t).replace(/^#/, '').trim()));
  else if (typeof fmTags === 'string') fmTags.split(/[,\s]+/).forEach(t => tags.add(t.replace(/^#/, '').trim()));
  for (const m of String(body || '').matchAll(/(^|\s)#([\p{L}\p{N}_/-]+)/gu)) {
    tags.add(m[2]);
  }
  return [...tags].filter(Boolean);
}

function extractTitle(relativePath, body) {
  const h1 = String(body || '').match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim();
  return String(relativePath || 'Untitled').split('/').pop().replace(/\.md$/i, '');
}

function parseMarkdownNote({ path, relativePath, content }) {
  const parsed = parseFrontmatter(content);
  const title = extractTitle(relativePath, parsed.body);
  return {
    path,
    relativePath,
    title,
    frontmatter: parsed.frontmatter,
    tags: extractTags(parsed.body, parsed.frontmatter),
    body: cleanBody(parsed.body)
  };
}

module.exports = { clipText, parseMarkdownNote, parseFrontmatter, cleanBody, extractTags };
```

- [ ] **Step 4: Run parser tests**

Run:

```bash
npm test -- test/obsidian/markdown.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add obsidian/markdown.js test/obsidian/markdown.test.js
git commit -m "feat(obsidian): parse markdown notes"
```

## Task 3: Sync State Persistence

**Files:**
- Create: `obsidian/sync-state.js`
- Create: `test/obsidian/sync-state.test.js`

- [ ] **Step 1: Write failing sync-state tests**

Create `test/obsidian/sync-state.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createSyncStateStore } = require('../../obsidian/sync-state');

test('sync state store saves and reloads note fingerprints', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vf1-sync-state-'));
  const file = path.join(dir, 'obsidian-sync.json');
  const store = createSyncStateStore(file);

  const state = store.load();
  state.notes['A.md'] = { mtimeMs: 1, size: 2, hash: 'abc' };
  state.lastSyncAt = '2026-07-16T00:00:00.000Z';
  store.save(state);

  const loaded = store.load();
  assert.equal(loaded.notes['A.md'].hash, 'abc');
  assert.equal(loaded.lastSyncAt, '2026-07-16T00:00:00.000Z');
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
npm test -- test/obsidian/sync-state.test.js
```

Expected: FAIL with module not found.

- [ ] **Step 3: Implement sync state store**

Create `obsidian/sync-state.js`:

```js
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_FILE = path.join(os.homedir(), '.desktop-pet', 'obsidian-sync.json');
const DEFAULT_STATE = { version: 1, lastSyncAt: null, notes: {}, recentWrites: [] };

function mergeState(raw) {
  const s = Object.assign({}, DEFAULT_STATE, raw || {});
  if (!s.notes || typeof s.notes !== 'object') s.notes = {};
  if (!Array.isArray(s.recentWrites)) s.recentWrites = [];
  return s;
}

function createSyncStateStore(filePath = DEFAULT_FILE) {
  return {
    filePath,
    load() {
      try {
        if (!fs.existsSync(filePath)) return mergeState();
        return mergeState(JSON.parse(fs.readFileSync(filePath, 'utf8')));
      } catch {
        return mergeState();
      }
    },
    save(state) {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(mergeState(state), null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, filePath);
      try { fs.chmodSync(filePath, 0o600); } catch (_) {}
    }
  };
}

module.exports = { createSyncStateStore, DEFAULT_FILE };
```

- [ ] **Step 4: Run sync-state tests**

Run:

```bash
npm test -- test/obsidian/sync-state.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add obsidian/sync-state.js test/obsidian/sync-state.test.js
git commit -m "feat(obsidian): persist sync state"
```

## Task 4: Local Vault Adapter

**Files:**
- Create: `obsidian/local-vault-adapter.js`
- Create: `test/obsidian/local-vault-adapter.test.js`

- [ ] **Step 1: Write failing adapter tests**

Create `test/obsidian/local-vault-adapter.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { LocalVaultAdapter } = require('../../obsidian/local-vault-adapter');

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

test('LocalVaultAdapter lists markdown notes and excludes private/output paths', async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'vf1-vault-'));
  write(path.join(vault, 'A.md'), '# A');
  write(path.join(vault, 'Projects', 'B.md'), '# B');
  write(path.join(vault, '.obsidian', 'config.md'), '# hidden');
  write(path.join(vault, 'Macross', 'Profile.md'), '# generated');
  write(path.join(vault, 'Assets', 'image.png'), 'png');

  const adapter = new LocalVaultAdapter({ vaultPath: vault, outputDir: 'Macross', excludeDirs: ['.obsidian', 'Macross'] });
  const notes = await adapter.listNotes();

  assert.deepEqual(notes.map(n => n.relativePath).sort(), ['A.md', 'Projects/B.md']);
});

test('LocalVaultAdapter reads, writes, and appends notes inside the vault', async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'vf1-vault-'));
  const adapter = new LocalVaultAdapter({ vaultPath: vault, outputDir: 'Macross', excludeDirs: ['.obsidian', 'Macross'] });

  await adapter.writeNote({ relativePath: 'Macross/Inbox.md' }, '# Inbox\n');
  await adapter.appendToNote({ relativePath: 'Macross/Inbox.md' }, '- item\n');
  const note = await adapter.readNote({ relativePath: 'Macross/Inbox.md' });

  assert.match(note.content, /# Inbox/);
  assert.match(note.content, /- item/);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
npm test -- test/obsidian/local-vault-adapter.test.js
```

Expected: FAIL with module not found.

- [ ] **Step 3: Implement local vault adapter**

Create `obsidian/local-vault-adapter.js`:

```js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseMarkdownNote } = require('./markdown');

function normalizeRel(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function hashText(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex');
}

class LocalVaultAdapter {
  constructor(config) {
    this.config = config || {};
    this.vaultPath = path.resolve(this.config.vaultPath || '');
    this.outputDir = normalizeRel(this.config.outputDir || 'Macross');
    this.excludeDirs = new Set((this.config.excludeDirs || ['.obsidian', this.outputDir]).map(normalizeRel));
  }

  assertVault() {
    if (!this.vaultPath || !fs.existsSync(this.vaultPath)) throw new Error(`Obsidian vault path not found: ${this.vaultPath}`);
    if (!fs.statSync(this.vaultPath).isDirectory()) throw new Error(`Obsidian vault path is not a directory: ${this.vaultPath}`);
  }

  shouldSkipDir(absDir) {
    const rel = normalizeRel(path.relative(this.vaultPath, absDir));
    if (!rel) return false;
    return rel.split('/').some(part => part.startsWith('.') || this.excludeDirs.has(part));
  }

  async listNotes() {
    this.assertVault();
    const out = [];
    const walk = (dir) => {
      if (this.shouldSkipDir(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(abs);
        else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
          const stat = fs.statSync(abs);
          const content = fs.readFileSync(abs, 'utf8');
          const relativePath = normalizeRel(path.relative(this.vaultPath, abs));
          out.push({ path: abs, relativePath, mtimeMs: stat.mtimeMs, size: stat.size, hash: hashText(content) });
        }
      }
    };
    walk(this.vaultPath);
    return out;
  }

  async readNote(noteRef) {
    const relativePath = normalizeRel(noteRef.relativePath);
    const abs = path.join(this.vaultPath, relativePath);
    const content = fs.readFileSync(abs, 'utf8');
    return Object.assign(parseMarkdownNote({ path: abs, relativePath, content }), { content });
  }

  async writeNote(noteRef, content) {
    const relativePath = normalizeRel(noteRef.relativePath);
    const abs = path.join(this.vaultPath, relativePath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, String(content || ''), 'utf8');
    return { relativePath, path: abs };
  }

  async appendToNote(noteRef, content) {
    const relativePath = normalizeRel(noteRef.relativePath);
    const abs = path.join(this.vaultPath, relativePath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.appendFileSync(abs, String(content || ''), 'utf8');
    return { relativePath, path: abs };
  }

  async getChangedNotes(previousState) {
    const stateNotes = (previousState && previousState.notes) || {};
    const listed = await this.listNotes();
    return listed.filter(n => {
      const old = stateNotes[n.relativePath];
      return !old || old.mtimeMs !== n.mtimeMs || old.size !== n.size || old.hash !== n.hash;
    });
  }
}

module.exports = { LocalVaultAdapter, normalizeRel, hashText };
```

- [ ] **Step 4: Run adapter tests**

Run:

```bash
npm test -- test/obsidian/local-vault-adapter.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add obsidian/local-vault-adapter.js test/obsidian/local-vault-adapter.test.js
git commit -m "feat(obsidian): scan local vault notes"
```

## Task 5: Obsidian Service Facade

**Files:**
- Create: `obsidian/prompts.js`
- Create: `obsidian/index.js`
- Create: `test/obsidian/service.test.js`

- [ ] **Step 1: Write failing service tests**

Create `test/obsidian/service.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createSyncStateStore } = require('../../obsidian/sync-state');
const { createObsidianService } = require('../../obsidian');

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

test('syncNow refines changed notes and saves fingerprints', async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'vf1-vault-'));
  write(path.join(vault, 'Note.md'), '# Note\n用户长期关注桌宠和知识库。');
  const stateFile = path.join(vault, 'state.json');
  let savedMemory = '';

  const service = createObsidianService({
    config: { enabled: true, vaultPath: vault, outputDir: 'Macross', excludeDirs: ['.obsidian', 'Macross'] },
    syncStore: createSyncStateStore(stateFile),
    getMemoryText: () => '',
    setMemoryText: (txt) => { savedMemory = txt; },
    refineNotes: async () => '用户长期关注桌宠和知识库。',
    extractWriteBack: async () => null
  });

  const result = await service.syncNow();
  assert.equal(result.ok, true);
  assert.equal(result.changedFiles, 1);
  assert.equal(savedMemory, '用户长期关注桌宠和知识库。');
  assert.equal(createSyncStateStore(stateFile).load().notes['Note.md'].hash.length, 64);
});

test('flushWriteBack creates profile, inbox, and monthly highlights', async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'vf1-vault-'));
  const service = createObsidianService({
    config: { enabled: true, vaultPath: vault, outputDir: 'Macross', excludeDirs: ['.obsidian', 'Macross'] },
    syncStore: createSyncStateStore(path.join(vault, 'state.json')),
    getMemoryText: () => '用户喜欢短答案。',
    setMemoryText: () => {},
    refineNotes: async () => null,
    extractWriteBack: async () => ({
      inbox: ['把 Obsidian 作为长期知识库。'],
      highlights: [{ topic: 'Obsidian 双向同步', reusable: '本地 adapter 先行', action: '实现 MVP' }]
    })
  });

  service.bufferChatTurn('我们做 Obsidian 集成', '先本地 adapter。');
  const result = await service.flushWriteBack('test');

  assert.equal(result.ok, true);
  assert.match(fs.readFileSync(path.join(vault, 'Macross', 'Profile.md'), 'utf8'), /用户喜欢短答案/);
  assert.match(fs.readFileSync(path.join(vault, 'Macross', 'Inbox.md'), 'utf8'), /Obsidian/);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
npm test -- test/obsidian/service.test.js
```

Expected: FAIL with module not found for `../../obsidian`.

- [ ] **Step 3: Implement prompt helpers**

Create `obsidian/prompts.js`:

```js
function buildNotesRefinePrompt(oldMemory, notes) {
  const body = notes.map(n => `【${n.relativePath}】\n标题: ${n.title}\n标签: ${(n.tags || []).join(', ')}\n正文:\n${String(n.body || '').slice(0, 6000)}`).join('\n\n---\n\n');
  return `现有记忆:\n${String(oldMemory || '').trim() || '(空)'}\n\nObsidian 变更笔记:\n${body}\n\n请输出更新后的完整记忆文本。`;
}

function buildWriteBackPrompt(turns) {
  const convo = turns.map(t => `[用户] ${t.user}\n[VF-1] ${t.reply}`).join('\n\n').slice(0, 12000);
  return `请从以下聊天中提取值得写入 Obsidian 的内容。只返回 JSON: {"inbox":["短条目"],"highlights":[{"topic":"主题","reusable":"可复用结论","action":"后续行动"}]}。如果没有价值, 返回 {"inbox":[],"highlights":[]}。\n\n${convo}`;
}

module.exports = { buildNotesRefinePrompt, buildWriteBackPrompt };
```

- [ ] **Step 4: Implement service facade**

Create `obsidian/index.js`:

```js
const path = require('path');
const { LocalVaultAdapter } = require('./local-vault-adapter');

function monthName(d = new Date()) {
  return d.toISOString().slice(0, 7);
}

function stamp(d = new Date()) {
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

function createObsidianService(deps) {
  const config = deps.config || {};
  const adapter = deps.adapter || new LocalVaultAdapter(config);
  const syncStore = deps.syncStore;
  const getMemoryText = deps.getMemoryText;
  const setMemoryText = deps.setMemoryText;
  const refineNotes = deps.refineNotes;
  const extractWriteBack = deps.extractWriteBack;
  const status = { ok: true, lastSyncAt: null, scannedFiles: 0, changedFiles: 0, lastError: '' };
  let writeBackTurns = [];

  function enabled() {
    return !!config.enabled;
  }

  function outputRel(name) {
    return path.posix.join(config.outputDir || 'Macross', name);
  }

  async function syncNow() {
    if (!enabled()) return Object.assign(status, { ok: true, skipped: true, lastError: '' });
    try {
      const state = syncStore.load();
      const all = await adapter.listNotes();
      const changed = await adapter.getChangedNotes(state);
      status.scannedFiles = all.length;
      status.changedFiles = changed.length;
      if (changed.length) {
        const notes = [];
        for (const n of changed) notes.push(await adapter.readNote(n));
        const next = await refineNotes(getMemoryText(), notes);
        if (next && String(next).trim()) setMemoryText(String(next).trim());
        for (const n of all) state.notes[n.relativePath] = { mtimeMs: n.mtimeMs, size: n.size, hash: n.hash };
      }
      state.lastSyncAt = new Date().toISOString();
      syncStore.save(state);
      return Object.assign(status, { ok: true, lastSyncAt: state.lastSyncAt, lastError: '' });
    } catch (e) {
      return Object.assign(status, { ok: false, lastError: e.message });
    }
  }

  function bufferChatTurn(user, reply) {
    if (!enabled() || !config.autoWriteBack) return;
    writeBackTurns.push({ user, reply });
    if (writeBackTurns.length > 50) writeBackTurns = writeBackTurns.slice(-50);
  }

  async function writeProfile() {
    const memory = String(getMemoryText() || '').trim();
    const text = `# VF-1 Profile\n\n> Last updated: ${stamp()}\n\n${memory || '暂无稳定画像。'}\n`;
    return adapter.writeNote({ relativePath: outputRel('Profile.md') }, text);
  }

  async function flushWriteBack(reason = 'manual') {
    if (!enabled() || !config.autoWriteBack) return { ok: true, skipped: true };
    const turns = writeBackTurns;
    try {
      await writeProfile();
      writeBackTurns = [];
      if (!turns.length) return { ok: true, wrote: 1 };
      const extracted = await extractWriteBack(turns);
      const inbox = Array.isArray(extracted && extracted.inbox) ? extracted.inbox : [];
      const highlights = Array.isArray(extracted && extracted.highlights) ? extracted.highlights : [];
      if (inbox.length) {
        const lines = inbox.map(x => `- ${stamp()} [[来源: VF-1 Chat]] ${String(x).trim()}`).join('\n') + '\n';
        await adapter.appendToNote({ relativePath: outputRel('Inbox.md') }, lines);
      }
      if (highlights.length) {
        const lines = `\n## ${stamp()} (${reason})\n\n` + highlights.map(h => `- 主题: ${h.topic || ''}\n- 可复用结论: ${h.reusable || ''}\n- 后续行动: ${h.action || ''}`).join('\n\n') + '\n';
        await adapter.appendToNote({ relativePath: outputRel(path.posix.join('Chat Highlights', `${monthName()}.md`)) }, lines);
      }
      return { ok: true, wrote: 1 + inbox.length + highlights.length };
    } catch (e) {
      writeBackTurns = turns.concat(writeBackTurns);
      return { ok: false, error: e.message };
    }
  }

  return { syncNow, bufferChatTurn, flushWriteBack, writeProfile, getStatus: () => Object.assign({}, status) };
}

module.exports = { createObsidianService };
```

- [ ] **Step 5: Run service tests**

Run:

```bash
npm test -- test/obsidian/service.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add obsidian/prompts.js obsidian/index.js test/obsidian/service.test.js
git commit -m "feat(obsidian): add sync service facade"
```

## Task 6: Main Process Integration And IPC

**Files:**
- Modify: `main.js`
- Modify: `preload.js`

- [ ] **Step 1: Add imports and service holder**

Near the top of `main.js`, after `const memory = require('./memory');`, add:

```js
const { createSyncStateStore } = require('./obsidian/sync-state');
const { createObsidianService } = require('./obsidian');
const { buildNotesRefinePrompt, buildWriteBackPrompt } = require('./obsidian/prompts');
```

After `let state = store.load();`, add:

```js
let obsidianService = null;
let obsidianSyncTimer = null;
let _obsidianTurnsSinceWrite = 0;
```

- [ ] **Step 2: Add LLM bridge helpers**

Place these helpers near the existing memory refinement functions:

```js
async function refineFromObsidianNotes(oldMemory, notes) {
  const provider = state.aiProvider || 'qwen';
  const apiKey = (state.apiKeys || {})[provider] || '';
  if (!apiKey) throw new Error('请先在设置中填写 API Key 后再同步 Obsidian');
  const metasoKey = (state.apiKeys || {}).metaso || '';
  const system = `你是一个长期记忆整理器。根据用户 Obsidian 笔记更新桌宠对用户的长期记忆。笔记内容不等于用户观点; 只记录稳定事实、长期项目、关注主题和明确偏好。只输出完整记忆文本。`;
  return callAI(provider, apiKey, state.pet.name, [], buildNotesRefinePrompt(oldMemory, notes), metasoKey, {
    systemOverride: system,
    noTools: true,
    temperature: 0.3
  });
}

async function extractObsidianWriteBack(turns) {
  const provider = state.aiProvider || 'qwen';
  const apiKey = (state.apiKeys || {})[provider] || '';
  if (!apiKey) return { inbox: [], highlights: [] };
  const metasoKey = (state.apiKeys || {}).metaso || '';
  const system = `你是知识库整理器。只返回合法 JSON, 不要 markdown 代码块。普通寒暄、情绪陪伴、一次性工具结果不要写入。`;
  const raw = await callAI(provider, apiKey, state.pet.name, [], buildWriteBackPrompt(turns), metasoKey, {
    systemOverride: system,
    noTools: true,
    temperature: 0.2
  });
  try {
    return JSON.parse(String(raw || '').trim().replace(/^```json\s*/i, '').replace(/```$/i, '').trim());
  } catch {
    return { inbox: [], highlights: [] };
  }
}
```

- [ ] **Step 3: Add service initialization**

Place this after `broadcastPetUpdate()` is defined, or before `app.whenReady()` if easier:

```js
function initObsidianService() {
  if (obsidianSyncTimer) {
    clearInterval(obsidianSyncTimer);
    obsidianSyncTimer = null;
  }
  obsidianService = createObsidianService({
    config: state.obsidian || {},
    syncStore: createSyncStateStore(),
    getMemoryText: () => memory.getMemoryText(),
    setMemoryText: (txt) => memory.setMemoryText(txt),
    refineNotes: refineFromObsidianNotes,
    extractWriteBack: extractObsidianWriteBack
  });
  const cfg = state.obsidian || {};
  if (cfg.enabled && cfg.autoSync) {
    const intervalMs = Math.max(1, Number(cfg.syncIntervalMin) || 30) * 60 * 1000;
    obsidianSyncTimer = setInterval(() => {
      obsidianService.syncNow().catch(e => console.warn('[OBSIDIAN] scheduled sync failed:', e.message));
    }, intervalMs);
  }
}
```

In `app.whenReady().then(() => {`, add the call immediately after `createPanelWindow();`:

```js
  createPetWindow();
  createPanelWindow();
  initObsidianService();
```

- [ ] **Step 4: Add IPC handlers**

Near other CONFIG IPC handlers in `main.js`, add:

```js
ipcMain.handle('get-obsidian-config', () => state.obsidian || {});

ipcMain.handle('set-obsidian-config', (_, cfg) => {
  const current = state.obsidian || {};
  state.obsidian = Object.assign({}, current, cfg || {});
  if (!Array.isArray(state.obsidian.excludeDirs)) state.obsidian.excludeDirs = ['.obsidian', state.obsidian.outputDir || 'Macross'];
  if (!state.obsidian.excludeDirs.includes(state.obsidian.outputDir || 'Macross')) state.obsidian.excludeDirs.push(state.obsidian.outputDir || 'Macross');
  store.save(state);
  initObsidianService();
  return { ok: true, config: state.obsidian };
});

ipcMain.handle('obsidian-sync-now', async () => {
  if (!obsidianService) initObsidianService();
  return obsidianService.syncNow();
});

ipcMain.handle('get-obsidian-status', () => {
  if (!obsidianService) initObsidianService();
  return obsidianService.getStatus();
});

ipcMain.handle('open-obsidian-output-dir', async () => {
  try {
    const cfg = state.obsidian || {};
    const target = path.join(cfg.vaultPath || '', cfg.outputDir || 'Macross');
    await shell.openPath(target);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
```

- [ ] **Step 5: Buffer chat turns and trigger write-back**

In the `ipcMain.handle('chat', async (_, message) => {` success path, immediately after `memory.appendChatArchive(message, reply);`, add:

```js
if (obsidianService && state.obsidian && state.obsidian.enabled && state.obsidian.autoWriteBack) {
  obsidianService.bufferChatTurn(message, reply);
  _obsidianTurnsSinceWrite += 1;
  const every = Math.max(1, Number(state.obsidian.writeBackEveryTurns) || 10);
  if (_obsidianTurnsSinceWrite >= every) {
    _obsidianTurnsSinceWrite = 0;
    obsidianService.flushWriteBack('turn-threshold').catch(e => console.warn('[OBSIDIAN] write-back failed:', e.message));
  }
}
```

- [ ] **Step 6: Expose preload methods**

In `preload.js`, add:

```js
getObsidianConfig: () => ipcRenderer.invoke('get-obsidian-config'),
setObsidianConfig: (cfg) => ipcRenderer.invoke('set-obsidian-config', cfg),
obsidianSyncNow: () => ipcRenderer.invoke('obsidian-sync-now'),
getObsidianStatus: () => ipcRenderer.invoke('get-obsidian-status'),
openObsidianOutputDir: () => ipcRenderer.invoke('open-obsidian-output-dir'),
```

- [ ] **Step 7: Run the full test suite**

Run:

```bash
npm test
```

Expected: all tests PASS.

- [ ] **Step 8: Commit**

```bash
git add main.js preload.js
git commit -m "feat(obsidian): wire sync into electron main"
```

## Task 7: CONFIG UI

**Files:**
- Modify: `panel.html`

- [ ] **Step 1: Add Obsidian CONFIG markup**

In `panel.html`, place this new `hud-frame` after the SETTINGS FILE frame:

```html
<div class="hud-frame">
  <div class="hud-pill">OBSIDIAN · 知识库</div>
  <div class="setting-note" style="margin-bottom:10px">读取 OneDayWorld 下的 Markdown 笔记补全人物画像，并自动把高价值聊天摘要写回 Macross 目录。</div>

  <label class="toggle-row">
    <input type="checkbox" id="obsidian-enabled">
    <span>启用 Obsidian 双向关联</span>
  </label>
  <label class="toggle-row">
    <input type="checkbox" id="obsidian-auto-sync">
    <span>自动同步笔记到画像</span>
  </label>
  <label class="toggle-row">
    <input type="checkbox" id="obsidian-auto-write">
    <span>自动写回知识库</span>
  </label>

  <div class="setting-label">Vault 路径</div>
  <input class="setting-input" id="obsidian-vault-path" placeholder="/Users/ace/Documents/OneDayWorld" />

  <div class="setting-label">写回目录</div>
  <input class="setting-input" id="obsidian-output-dir" placeholder="Macross" />

  <div class="key-row" style="margin-top:10px">
    <button class="key-save-btn" onclick="saveObsidianConfig()">保存</button>
    <button class="key-save-btn" onclick="syncObsidianNow()">立即同步</button>
    <button class="key-save-btn" onclick="openObsidianOutputDir()">打开目录</button>
  </div>
  <div class="setting-note" id="obsidian-status" style="margin-top:8px">未同步</div>
</div>
```

- [ ] **Step 2: Add UI functions**

Inside the existing `<script>` block, add:

```js
async function loadObsidianConfig() {
  if (!window.petAPI.getObsidianConfig) return;
  const cfg = await window.petAPI.getObsidianConfig();
  document.getElementById('obsidian-enabled').checked = !!cfg.enabled;
  document.getElementById('obsidian-auto-sync').checked = cfg.autoSync !== false;
  document.getElementById('obsidian-auto-write').checked = cfg.autoWriteBack !== false;
  document.getElementById('obsidian-vault-path').value = cfg.vaultPath || '/Users/ace/Documents/OneDayWorld';
  document.getElementById('obsidian-output-dir').value = cfg.outputDir || 'Macross';
  await refreshObsidianStatus();
}

async function saveObsidianConfig() {
  const outputDir = (document.getElementById('obsidian-output-dir').value || 'Macross').trim();
  const cfg = {
    enabled: document.getElementById('obsidian-enabled').checked,
    autoSync: document.getElementById('obsidian-auto-sync').checked,
    autoWriteBack: document.getElementById('obsidian-auto-write').checked,
    vaultPath: (document.getElementById('obsidian-vault-path').value || '/Users/ace/Documents/OneDayWorld').trim(),
    outputDir,
    excludeDirs: ['.obsidian', outputDir]
  };
  const res = await window.petAPI.setObsidianConfig(cfg);
  const el = document.getElementById('obsidian-status');
  el.textContent = res.ok ? '已保存 Obsidian 设置' : '保存失败';
}

async function syncObsidianNow() {
  const el = document.getElementById('obsidian-status');
  el.textContent = '同步中...';
  const res = await window.petAPI.obsidianSyncNow();
  el.textContent = res.ok
    ? `同步完成: 扫描 ${res.scannedFiles || 0} 个文件, 变更 ${res.changedFiles || 0} 个`
    : `同步失败: ${res.lastError || res.error || '未知错误'}`;
}

async function refreshObsidianStatus() {
  const el = document.getElementById('obsidian-status');
  if (!el || !window.petAPI.getObsidianStatus) return;
  const st = await window.petAPI.getObsidianStatus();
  el.textContent = st.lastSyncAt
    ? `上次同步: ${st.lastSyncAt} · 扫描 ${st.scannedFiles || 0} · 变更 ${st.changedFiles || 0}`
    : '尚未同步';
}

async function openObsidianOutputDir() {
  await window.petAPI.openObsidianOutputDir();
}
```

- [ ] **Step 3: Load config when settings tab opens**

In the existing tab switching code, replace:

```js
if (tab.dataset.tab === 'settings') { loadBreakReminder(); loadEdgePatrol(); loadPetVisible(); loadQwenModel(); }
```

with:

```js
if (tab.dataset.tab === 'settings') {
  loadBreakReminder();
  loadEdgePatrol();
  loadPetVisible();
  loadQwenModel();
  loadObsidianConfig().catch(e => console.log('[OBSIDIAN] load config failed', e));
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
npm test
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add panel.html
git commit -m "feat(obsidian): add config controls"
```

## Task 8: Manual Runtime Verification

**Files:**
- No source changes expected.

- [ ] **Step 1: Run automated tests**

Run:

```bash
npm test
```

Expected: all tests PASS.

- [ ] **Step 2: Start the app**

Run:

```bash
npm start
```

Expected: Electron app starts, pet window appears, CONFIG panel opens normally when clicking the pet.

- [ ] **Step 3: Verify disabled default**

In CONFIG, confirm Obsidian integration is disabled by default.

Expected: app does not scan `/Users/ace/Documents/OneDayWorld` until enabled or manual sync is clicked after enabling.

- [ ] **Step 4: Enable and sync**

Set:

```text
Vault 路径: /Users/ace/Documents/OneDayWorld
写回目录: Macross
启用 Obsidian 双向关联: on
自动同步笔记到画像: on
自动写回知识库: on
```

Click `保存`, then `立即同步`.

Expected: status shows scanned and changed file counts, and no crash if the vault exists.

- [ ] **Step 5: Verify write-back files**

After a threshold write-back or by temporarily setting `writeBackEveryTurns` to `1` in `~/.desktop-pet/data.json` and chatting once, verify:

```text
/Users/ace/Documents/OneDayWorld/Macross/Profile.md
/Users/ace/Documents/OneDayWorld/Macross/Inbox.md
/Users/ace/Documents/OneDayWorld/Macross/Chat Highlights/2026-07.md
```

Expected: files are created only under `Macross/`.

- [ ] **Step 6: Stop the app cleanly**

Close the Electron app from the normal UI or terminal.

Expected: no running command session remains.

- [ ] **Step 7: Commit verification notes if code changed**

If runtime verification required source changes, commit them:

```bash
git add main.js preload.js panel.html obsidian test package.json store.js
git commit -m "fix(obsidian): complete runtime verification"
```

If no source changes were required, do not create an empty commit.

## Self-Review

- Spec coverage: Tasks cover default `/Users/ace/Documents/OneDayWorld` recursive Markdown reading, `.obsidian`/hidden/output exclusions, `Macross/` write-back files, adapter boundary, sync state, IPC, CONFIG UI, disabled default, error reporting, and automated/manual verification.
- Placeholder scan: The plan contains no `TBD`, no unspecified handler names, and each implementation step includes concrete code or exact UI markup.
- Type consistency: The config keys are consistently `enabled`, `vaultPath`, `outputDir`, `excludeDirs`, `autoSync`, `autoWriteBack`, `syncIntervalMin`, and `writeBackEveryTurns`; service methods are consistently `syncNow`, `bufferChatTurn`, `flushWriteBack`, `writeProfile`, and `getStatus`.
