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

test('store clamps zero Obsidian intervals from existing data to one', () => {
  const oldHome = process.env.HOME;
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vf1-store-home-'));
  const dataDir = path.join(process.env.HOME, '.desktop-pet');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'data.json'),
    JSON.stringify({ obsidian: { syncIntervalMin: 0, writeBackEveryTurns: 0 } })
  );
  delete require.cache[require.resolve('../store')];
  try {
    const store = require('../store');
    const state = store.load();

    assert.equal(state.obsidian.syncIntervalMin, 1);
    assert.equal(state.obsidian.writeBackEveryTurns, 1);
  } finally {
    process.env.HOME = oldHome;
    delete require.cache[require.resolve('../store')];
  }
});
