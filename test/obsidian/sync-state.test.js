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

test('sync state store falls back to default state for damaged JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vf1-sync-state-'));
  const file = path.join(dir, 'obsidian-sync.json');
  fs.writeFileSync(file, '{bad json', 'utf8');

  const loaded = createSyncStateStore(file).load();
  assert.deepEqual(loaded, { version: 1, lastSyncAt: null, notes: {}, recentWrites: [] });
});

test('sync state store creates nested directories and saves with private file permissions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vf1-sync-state-'));
  const file = path.join(dir, 'nested', 'state', 'obsidian-sync.json');

  createSyncStateStore(file).save({
    notes: { 'A.md': { mtimeMs: 1, size: 2, hash: 'abc' } }
  });

  assert.equal(fs.existsSync(file), true);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
});

test('sync state store normalizes strange persisted input', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vf1-sync-state-'));
  const cases = [
    ['negative.json', -1],
    ['decimal.json', 1.5],
    ['illegal.json', 'nope']
  ];

  for (const [name, version] of cases) {
    const file = path.join(dir, name);
    const raw = JSON.parse('{"notes":{"A.md":{"mtimeMs":1,"size":2,"hash":"abc"},"__proto__":{"polluted":true},"constructor":{"polluted":true},"prototype":{"polluted":true}}}');
    raw.version = version;
    raw.lastSyncAt = { value: '2026-07-16T00:00:00.000Z' };
    raw.recentWrites = 'A.md';
    fs.writeFileSync(file, JSON.stringify(raw), 'utf8');

    const loaded = createSyncStateStore(file).load();
    assert.equal(loaded.version, 1);
    assert.equal(loaded.lastSyncAt, null);
    assert.deepEqual(loaded.recentWrites, []);
    assert.deepEqual(Object.keys(loaded.notes), ['A.md']);
    assert.equal(Object.hasOwn(loaded.notes, '__proto__'), false);
    assert.equal(Object.hasOwn(loaded.notes, 'constructor'), false);
    assert.equal(Object.hasOwn(loaded.notes, 'prototype'), false);
  }
});

test('sync state store validates metadata types and ISO timestamps', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vf1-sync-state-'));
  const invalidCases = [
    ['string-version.json', '2', 'not-a-date'],
    ['array-version.json', [3], 'not-a-date'],
    ['rolled-date.json', 1, '2026-02-30T00:00:00.000Z'],
    ['non-iso-date.json', 1, '0']
  ];

  for (const [name, version, lastSyncAt] of invalidCases) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify({
      version,
      lastSyncAt
    }), 'utf8');

    const loaded = createSyncStateStore(file).load();
    assert.equal(loaded.version, 1);
    assert.equal(loaded.lastSyncAt, null);
  }

  const validFile = path.join(dir, 'valid-metadata.json');
  fs.writeFileSync(validFile, JSON.stringify({
    version: 2,
    lastSyncAt: '2026-07-16T00:00:00.000Z'
  }), 'utf8');

  const loaded = createSyncStateStore(validFile).load();
  assert.equal(loaded.version, 2);
  assert.equal(loaded.lastSyncAt, '2026-07-16T00:00:00.000Z');
});

test('sync state store does not reuse fixed tmp files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vf1-sync-state-'));
  const file = path.join(dir, 'obsidian-sync.json');
  const fixedTmp = file + '.tmp';
  const oldTmpContent = 'old tmp content';
  fs.writeFileSync(fixedTmp, oldTmpContent, { encoding: 'utf8', mode: 0o644 });

  createSyncStateStore(file).save({
    notes: { 'A.md': { mtimeMs: 1, size: 2, hash: 'new-sensitive-hash' } }
  });

  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.notes['A.md'].hash, 'new-sensitive-hash');
  assert.equal(fs.existsSync(fixedTmp), true);
  assert.equal(fs.readFileSync(fixedTmp, 'utf8'), oldTmpContent);

  const leftovers = fs.readdirSync(dir).filter((name) => name.startsWith(`obsidian-sync.json.${process.pid}.`) && name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});
