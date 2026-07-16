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

test('syncNow reuses one scan and refines changed notes in bounded batches', async () => {
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vf1-state-')), 'state.json');
  const syncStore = createSyncStateStore(stateFile);
  const listed = [
    { relativePath: 'A.md', mtimeMs: 1, size: 1, hash: 'a'.repeat(64) },
    { relativePath: 'B.md', mtimeMs: 2, size: 1, hash: 'b'.repeat(64) },
    { relativePath: 'C.md', mtimeMs: 3, size: 1, hash: 'c'.repeat(64) }
  ];
  let listCalls = 0;
  const read = [];
  const batches = [];
  let memory = 'base';
  const service = createObsidianService({
    config: {
      enabled: true,
      vaultPath: '/fake',
      outputDir: 'Macross',
      excludeDirs: ['.obsidian', 'Macross'],
      maxSyncBatchChars: 12
    },
    syncStore,
    adapter: {
      listNotes: async () => {
        listCalls += 1;
        return listed;
      },
      getChangedNotes: async (state, alreadyListed) => alreadyListed.filter(n => !state.notes[n.relativePath]),
      readNote: async (note) => {
        read.push(note.relativePath);
        return { relativePath: note.relativePath, title: note.relativePath, tags: [], body: '1234567890' };
      },
      writeNote: async () => {}
    },
    getMemoryText: () => memory,
    setMemoryText: (txt) => { memory = txt; },
    refineNotes: async (oldMemory, notes) => {
      batches.push({ oldMemory, paths: notes.map(n => n.relativePath) });
      return `${oldMemory}|${notes.map(n => n.relativePath).join('+')}`;
    },
    extractWriteBack: async () => null
  });

  const result = await service.syncNow();

  assert.equal(result.ok, true);
  assert.equal(result.scannedFiles, 3);
  assert.equal(result.changedFiles, 3);
  assert.equal(listCalls, 1);
  assert.deepEqual(read, ['A.md', 'B.md', 'C.md']);
  assert.deepEqual(batches, [
    { oldMemory: 'base', paths: ['A.md'] },
    { oldMemory: 'base|A.md', paths: ['B.md'] },
    { oldMemory: 'base|A.md|B.md', paths: ['C.md'] }
  ]);
  assert.equal(memory, 'base|A.md|B.md|C.md');
});

test('syncNow refreshes Profile after notes update memory', async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'vf1-vault-'));
  write(path.join(vault, 'Note.md'), '# Note\n用户喜欢把知识沉淀到 Obsidian。');
  let memory = '';
  const service = createObsidianService({
    config: { enabled: true, vaultPath: vault, outputDir: 'Macross', excludeDirs: ['.obsidian', 'Macross'] },
    syncStore: createSyncStateStore(path.join(vault, 'state.json')),
    getMemoryText: () => memory,
    setMemoryText: (txt) => { memory = txt; },
    refineNotes: async () => '用户喜欢把知识沉淀到 Obsidian。',
    extractWriteBack: async () => null
  });

  const result = await service.syncNow();

  assert.equal(result.ok, true);
  assert.match(fs.readFileSync(path.join(vault, 'Macross', 'Profile.md'), 'utf8'), /沉淀到 Obsidian/);
});

test('syncNow persists completed batch fingerprints when a later batch fails', async () => {
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vf1-state-')), 'state.json');
  const syncStore = createSyncStateStore(stateFile);
  let calls = 0;
  const service = createObsidianService({
    config: {
      enabled: true,
      vaultPath: '/fake',
      outputDir: 'Macross',
      excludeDirs: ['.obsidian', 'Macross'],
      maxSyncBatchChars: 12
    },
    syncStore,
    adapter: {
      listNotes: async () => [
        { relativePath: 'A.md', mtimeMs: 1, size: 1, hash: 'a'.repeat(64) },
        { relativePath: 'B.md', mtimeMs: 2, size: 1, hash: 'b'.repeat(64) }
      ],
      getChangedNotes: async (state, alreadyListed) => alreadyListed.filter(n => !state.notes[n.relativePath]),
      readNote: async (note) => ({ relativePath: note.relativePath, title: note.relativePath, tags: [], body: '1234567890' }),
      writeNote: async () => {}
    },
    getMemoryText: () => 'base',
    setMemoryText: () => {},
    refineNotes: async (oldMemory, notes) => {
      calls += 1;
      if (calls === 2) throw new Error('batch failed');
      return `${oldMemory}|${notes[0].relativePath}`;
    },
    extractWriteBack: async () => null
  });

  const result = await service.syncNow();
  const saved = syncStore.load();

  assert.equal(result.ok, false);
  assert.deepEqual(saved.notes['A.md'], { mtimeMs: 1, size: 1, hash: 'a'.repeat(64) });
  assert.equal(saved.notes['B.md'], undefined);
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

test('flushWriteBack serializes concurrent calls without duplicating a batch', async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'vf1-vault-'));
  const files = {};
  let extractCalls = 0;
  let releaseExtract;
  const extractStarted = new Promise(resolve => { releaseExtract = resolve; });
  const adapter = {
    writeNote: async (noteRef, content) => {
      files[noteRef.relativePath] = content;
    },
    appendToNote: async (noteRef, content) => {
      files[noteRef.relativePath] = (files[noteRef.relativePath] || '') + content;
    },
    readNote: async (noteRef) => ({ content: files[noteRef.relativePath] || '' })
  };
  const service = createObsidianService({
    config: { enabled: true, vaultPath: vault, outputDir: 'Macross', excludeDirs: ['.obsidian', 'Macross'] },
    adapter,
    syncStore: createSyncStateStore(path.join(vault, 'state.json')),
    getMemoryText: () => '记忆',
    setMemoryText: () => {},
    refineNotes: async () => null,
    extractWriteBack: async () => {
      extractCalls += 1;
      if (extractCalls === 1) await extractStarted;
      return { inbox: ['并发写回'], highlights: [] };
    }
  });
  service.bufferChatTurn('用户问题', 'VF-1 回复');

  const first = service.flushWriteBack('first');
  const second = service.flushWriteBack('second');
  releaseExtract();
  const results = await Promise.all([first, second]);

  assert.deepEqual(results.map(r => r.ok), [true, true]);
  assert.equal(extractCalls, 1);
  assert.equal((files['Macross/Inbox.md'].match(/vf1-writeback:1:inbox/g) || []).length, 1);
});

test('flushWriteBack records failed and successful writeback status', async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'vf1-vault-'));
  let fail = true;
  const service = createObsidianService({
    config: { enabled: true, vaultPath: vault, outputDir: 'Macross', excludeDirs: ['.obsidian', 'Macross'] },
    adapter: {
      writeNote: async () => {
        if (fail) throw new Error('profile write failed');
      },
      appendToNote: async () => {},
      readNote: async () => ({ content: '' })
    },
    syncStore: createSyncStateStore(path.join(vault, 'state.json')),
    getMemoryText: () => '记忆',
    setMemoryText: () => {},
    refineNotes: async () => null,
    extractWriteBack: async () => ({ inbox: ['x'], highlights: [] })
  });

  service.bufferChatTurn('用户问题', 'VF-1 回复');
  const failed = await service.flushWriteBack('first');
  const failedStatus = service.getStatus();
  fail = false;
  const retried = await service.flushWriteBack('second');
  const okStatus = service.getStatus();

  assert.equal(failed.ok, false);
  assert.equal(failedStatus.ok, false);
  assert.match(failedStatus.lastWriteBackError, /profile write failed/);
  assert.equal(retried.ok, true);
  assert.equal(okStatus.ok, true);
  assert.equal(okStatus.lastWriteBackError, '');
  assert.ok(okStatus.lastWriteBackAt);
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

test('flushWriteBack keeps failed retry batch stable when new turns arrive', async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'vf1-vault-'));
  const files = {};
  const seen = [];
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
    extractWriteBack: async (turns) => {
      seen.push(turns.map(t => t.user));
      return {
        inbox: [`inbox ${turns.map(t => t.user).join(',')}`],
        highlights: [{ topic: 'T', reusable: 'R', action: 'A' }]
      };
    }
  });

  service.bufferChatTurn('old', 'turn');
  const failed = await service.flushWriteBack('first');
  service.bufferChatTurn('new', 'turn');
  const retried = await service.flushWriteBack('second');
  const next = await service.flushWriteBack('third');

  const inboxText = files['Macross/Inbox.md'] || '';
  assert.equal(failed.ok, false);
  assert.equal(retried.ok, true);
  assert.equal(next.ok, true);
  assert.deepEqual(seen, [['old'], ['old'], ['new']]);
  assert.equal((inboxText.match(/vf1-writeback:1:inbox/g) || []).length, 1);
  assert.equal((inboxText.match(/vf1-writeback:1-2:inbox/g) || []).length, 0);
  assert.equal((inboxText.match(/vf1-writeback:2:inbox/g) || []).length, 1);
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
