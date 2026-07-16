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
