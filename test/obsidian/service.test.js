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
