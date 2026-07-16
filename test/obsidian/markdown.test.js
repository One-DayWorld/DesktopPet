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

test('parseMarkdownNote ignores tags inside fenced and inline code', () => {
  const note = parseMarkdownNote({
    path: '/vault/Projects/Code Tags.md',
    relativePath: 'Projects/Code Tags.md',
    content: [
      '# Code Tags',
      '',
      '正文 #real 标签。',
      '`const color = "#fff"; // #inline`',
      '```css',
      '.button { color: #fff; }',
      '/* #todo */',
      '```'
    ].join('\n')
  });

  assert.deepEqual(note.tags.sort(), ['real']);
});

test('parseMarkdownNote parses BOM and CRLF frontmatter', () => {
  const note = parseMarkdownNote({
    path: '/vault/Projects/CRLF.md',
    relativePath: 'Projects/CRLF.md',
    content: '\uFEFF---\r\ntags: [windows, vf1]\r\nowner: Ace\r\n---\r\n# CRLF Note\r\n正文 #body'
  });

  assert.equal(note.frontmatter.owner, 'Ace');
  assert.deepEqual(note.frontmatter.tags, ['windows', 'vf1']);
  assert.deepEqual(note.tags.sort(), ['body', 'vf1', 'windows']);
});

test('parseMarkdownNote falls back to relativePath filename when H1 is missing', () => {
  const note = parseMarkdownNote({
    path: '/vault/Projects/Fallback Name.md',
    relativePath: 'Projects/Fallback Name.md',
    content: 'No heading here.'
  });

  assert.equal(note.title, 'Fallback Name');
});

test('parseMarkdownNote parses frontmatter tags string without quotes or hashes', () => {
  const note = parseMarkdownNote({
    path: '/vault/Projects/String Tags.md',
    relativePath: 'Projects/String Tags.md',
    content: [
      '---',
      'tags: "#a #b"',
      '---',
      '# String Tags'
    ].join('\n')
  });

  assert.deepEqual(note.tags.sort(), ['a', 'b']);
});
