const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createSyncStateStore } = require('../../obsidian/sync-state');
const { createObsidianService } = require('../../obsidian');
const { buildNotesRefinePrompt } = require('../../obsidian/prompts');

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

test('syncNow saves fingerprints even when no notes changed', async () => {
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vf1-state-')), 'state.json');
  const syncStore = createSyncStateStore(stateFile);
  const note = { relativePath: 'Stable.md', mtimeMs: 10, size: 20, hash: 'a'.repeat(64) };
  const service = createObsidianService({
    config: { enabled: true, vaultPath: '/fake', outputDir: 'Macross', excludeDirs: ['.obsidian', 'Macross'] },
    syncStore,
    adapter: {
      listNotes: async () => [note],
      getChangedNotes: async () => [],
      readNote: async () => { throw new Error('unchanged note should not be read'); }
    },
    getMemoryText: () => '',
    setMemoryText: () => {},
    refineNotes: async () => { throw new Error('unchanged note should not be refined'); },
    extractWriteBack: async () => null
  });

  const result = await service.syncNow();

  assert.equal(result.ok, true);
  assert.deepEqual(syncStore.load().notes['Stable.md'], { mtimeMs: 10, size: 20, hash: 'a'.repeat(64) });
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

test('flushWriteBack does not duplicate buffered turns after profile write failure', async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'vf1-vault-'));
  const writes = [];
  let failProfile = true;
  let extractedTurnCount = 0;
  const adapter = {
    writeNote: async (noteRef, content) => {
      if (failProfile) throw new Error('profile failed');
      writes.push({ noteRef, content });
    },
    appendToNote: async (noteRef, content) => {
      writes.push({ noteRef, content });
    }
  };
  const service = createObsidianService({
    config: { enabled: true, vaultPath: vault, outputDir: 'Macross', excludeDirs: ['.obsidian', 'Macross'] },
    adapter,
    syncStore: createSyncStateStore(path.join(vault, 'state.json')),
    getMemoryText: () => '用户喜欢短答案。',
    setMemoryText: () => {},
    refineNotes: async () => null,
    extractWriteBack: async (turns) => {
      extractedTurnCount = turns.length;
      return { inbox: ['一条'], highlights: [] };
    }
  });

  service.bufferChatTurn('用户问题', 'VF-1 回复');
  const failed = await service.flushWriteBack('test');
  failProfile = false;
  const retried = await service.flushWriteBack('test');

  assert.equal(failed.ok, false);
  assert.equal(retried.ok, true);
  assert.equal(extractedTurnCount, 1);
  assert.equal(writes.length, 2);
});

test('flushWriteBack keeps turns buffered during flush when queue is capped', async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'vf1-vault-'));
  const seen = [];
  let service;
  let appendCalls = 0;
  const adapter = {
    writeNote: async () => {},
    appendToNote: async () => {
      appendCalls += 1;
      if (appendCalls === 1) service.bufferChatTurn('new', 'turn');
    },
    readNote: async () => ({ content: '' })
  };
  service = createObsidianService({
    config: { enabled: true, vaultPath: vault, outputDir: 'Macross', excludeDirs: ['.obsidian', 'Macross'] },
    adapter,
    syncStore: createSyncStateStore(path.join(vault, 'state.json')),
    getMemoryText: () => '记忆',
    setMemoryText: () => {},
    refineNotes: async () => null,
    extractWriteBack: async (turns) => {
      seen.push(turns.map(t => t.user));
      return { inbox: ['条目'], highlights: [] };
    }
  });
  for (let i = 0; i < 50; i += 1) service.bufferChatTurn(`old-${i}`, 'reply');

  await service.flushWriteBack('first');
  await service.flushWriteBack('second');

  assert.equal(seen.length, 2);
  assert.equal(seen[0].length, 50);
  assert.deepEqual(seen[1], ['new']);
});

test('flushWriteBack skips already written inbox block when highlights retry succeeds', async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'vf1-vault-'));
  const files = {};
  let failHighlights = true;
  const adapter = {
    writeNote: async (noteRef, content) => {
      files[noteRef.relativePath] = content;
    },
    appendToNote: async (noteRef, content) => {
      if (noteRef.relativePath.includes('Chat Highlights') && failHighlights) {
        failHighlights = false;
        throw new Error('highlights failed');
      }
      files[noteRef.relativePath] = (files[noteRef.relativePath] || '') + content;
    },
    readNote: async (noteRef) => {
      if (!Object.prototype.hasOwnProperty.call(files, noteRef.relativePath)) {
        const err = new Error('not found');
        err.code = 'ENOENT';
        throw err;
      }
      return { content: files[noteRef.relativePath] };
    }
  };
  const service = createObsidianService({
    config: { enabled: true, vaultPath: vault, outputDir: 'Macross', excludeDirs: ['.obsidian', 'Macross'] },
    adapter,
    syncStore: createSyncStateStore(path.join(vault, 'state.json')),
    getMemoryText: () => '记忆',
    setMemoryText: () => {},
    refineNotes: async () => null,
    extractWriteBack: async () => ({
      inbox: ['只写一次'],
      highlights: [{ topic: 'T', reusable: 'R', action: 'A' }]
    })
  });

  service.bufferChatTurn('用户问题', 'VF-1 回复');
  const failed = await service.flushWriteBack('first');
  const retried = await service.flushWriteBack('second');

  const inboxText = files['Macross/Inbox.md'] || '';
  assert.equal(failed.ok, false);
  assert.equal(retried.ok, true);
  assert.equal((inboxText.match(/vf1-writeback:1:inbox/g) || []).length, 1);
});

test('flushWriteBack filters and flattens extracted writeback content', async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'vf1-vault-'));
  const appended = [];
  const adapter = {
    writeNote: async () => {},
    appendToNote: async (noteRef, content) => {
      appended.push({ noteRef, content });
    },
    readNote: async () => ({ content: '' })
  };
  const service = createObsidianService({
    config: { enabled: true, vaultPath: vault, outputDir: 'Macross', excludeDirs: ['.obsidian', 'Macross'] },
    adapter,
    syncStore: createSyncStateStore(path.join(vault, 'state.json')),
    getMemoryText: () => '记忆',
    setMemoryText: () => {},
    refineNotes: async () => null,
    extractWriteBack: async () => ({
      inbox: ['ok', '', null, undefined, 'a\n# injected'],
      highlights: [null, {}, { topic: 'T\n# bad', reusable: null, action: 'A' }]
    })
  });

  service.bufferChatTurn('用户问题', 'VF-1 回复');
  const result = await service.flushWriteBack('clean');
  const output = appended.map(x => x.content).join('\n');

  assert.equal(result.ok, true);
  assert.doesNotMatch(output, /undefined/);
  assert.doesNotMatch(output, /\n# injected/);
  assert.doesNotMatch(output, /\n# bad/);
  assert.match(output, /- .* ok/);
  assert.match(output, /a # injected/);
  assert.match(output, /主题: T # bad/);
});

test('syncNow clears skipped status after disabled service is enabled', async () => {
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vf1-state-')), 'state.json');
  const config = { enabled: false, vaultPath: '/fake', outputDir: 'Macross', excludeDirs: ['.obsidian', 'Macross'] };
  const service = createObsidianService({
    config,
    syncStore: createSyncStateStore(stateFile),
    adapter: {
      listNotes: async () => [],
      getChangedNotes: async () => [],
      readNote: async () => { throw new Error('no notes'); }
    },
    getMemoryText: () => '',
    setMemoryText: () => {},
    refineNotes: async () => null,
    extractWriteBack: async () => null
  });

  const disabled = await service.syncNow();
  config.enabled = true;
  const enabledResult = await service.syncNow();

  assert.equal(disabled.skipped, true);
  assert.equal(enabledResult.ok, true);
  assert.equal(enabledResult.skipped, false);
});

test('flushWriteBack rejects unsafe outputDir path segments', async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'vf1-vault-'));
  const service = createObsidianService({
    config: { enabled: true, vaultPath: vault, outputDir: '../Bad', excludeDirs: ['.obsidian', 'Macross'] },
    syncStore: createSyncStateStore(path.join(vault, 'state.json')),
    getMemoryText: () => '记忆',
    setMemoryText: () => {},
    refineNotes: async () => null,
    extractWriteBack: async () => ({ inbox: ['x'], highlights: [] })
  });

  service.bufferChatTurn('用户问题', 'VF-1 回复');
  const result = await service.flushWriteBack('unsafe');

  assert.equal(result.ok, false);
  assert.equal(fs.existsSync(path.resolve(vault, '..', 'Bad')), false);
});

test('buildNotesRefinePrompt includes memory safety constraints', () => {
  const prompt = buildNotesRefinePrompt('旧记忆', [{ relativePath: 'A.md', title: 'A', tags: [], body: '正文' }]);

  assert.match(prompt, /笔记内容不等于用户观点/);
  assert.match(prompt, /不把引用\/外部文章观点当用户事实/);
  assert.match(prompt, /保留已有记忆，尤其用户手写内容/);
  assert.match(prompt, /只记录稳定事实、长期项目、关注主题和明确偏好/);
  assert.match(prompt, /总量精简，避免把知识库全文塞入记忆/);
});
