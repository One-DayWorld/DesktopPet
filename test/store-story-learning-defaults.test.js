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
