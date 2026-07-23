const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(name) {
  return fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
}

test('chat panel no longer exposes article attachment UI or URL ingest flow', () => {
  const panel = read('panel.html');

  assert.doesNotMatch(panel, /attach-btn/);
  assert.doesNotMatch(panel, /attachArticle/);
  assert.doesNotMatch(panel, /ingestUrlFlow/);
  assert.doesNotMatch(panel, /showIngestResult/);
  assert.doesNotMatch(panel, /投喂文章/);
});

test('renderer preload no longer exposes article ingest APIs', () => {
  const preload = read('preload.js');

  assert.doesNotMatch(preload, /pickArticleFile/);
  assert.doesNotMatch(preload, /ingestArticleUrl/);
});

test('main process no longer registers article ingest IPC handlers', () => {
  const main = read('main.js');

  assert.doesNotMatch(main, /pick-article-file/);
  assert.doesNotMatch(main, /ingest-article-url/);
  assert.doesNotMatch(main, /function ingestArticle/);
});
