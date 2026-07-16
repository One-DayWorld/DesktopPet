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

test('sync state store isolates default notes and recent writes between loads', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vf1-sync-state-'));
  const first = createSyncStateStore(path.join(dir, 'first.json'));
  const second = createSyncStateStore(path.join(dir, 'second.json'));

  const state = first.load();
  state.notes['A.md'] = { mtimeMs: 1, size: 2, hash: 'abc' };
  state.recentWrites.push('A.md');

  const loaded = second.load();
  assert.deepEqual(loaded.notes, {});
  assert.deepEqual(loaded.recentWrites, []);
});
