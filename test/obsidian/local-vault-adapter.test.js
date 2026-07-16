const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { LocalVaultAdapter } = require('../../obsidian/local-vault-adapter');

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

test('LocalVaultAdapter lists markdown notes and excludes private/output paths', async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'vf1-vault-'));
  write(path.join(vault, 'A.md'), '# A');
  write(path.join(vault, 'Projects', 'B.md'), '# B');
  write(path.join(vault, '.obsidian', 'config.md'), '# hidden');
  write(path.join(vault, 'Macross', 'Profile.md'), '# generated');
  write(path.join(vault, 'Assets', 'image.png'), 'png');

  const adapter = new LocalVaultAdapter({ vaultPath: vault, outputDir: 'Macross', excludeDirs: ['.obsidian', 'Macross'] });
  const notes = await adapter.listNotes();

  assert.deepEqual(notes.map(n => n.relativePath).sort(), ['A.md', 'Projects/B.md']);
});

test('LocalVaultAdapter reads, writes, and appends notes inside the vault', async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'vf1-vault-'));
  const adapter = new LocalVaultAdapter({ vaultPath: vault, outputDir: 'Macross', excludeDirs: ['.obsidian', 'Macross'] });

  await adapter.writeNote({ relativePath: 'Macross/Inbox.md' }, '# Inbox\n');
  await adapter.appendToNote({ relativePath: 'Macross/Inbox.md' }, '- item\n');
  const note = await adapter.readNote({ relativePath: 'Macross/Inbox.md' });

  assert.match(note.content, /# Inbox/);
  assert.match(note.content, /- item/);
});
