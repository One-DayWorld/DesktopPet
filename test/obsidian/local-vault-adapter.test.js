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

test('LocalVaultAdapter always excludes outputDir even when excludeDirs omits it', async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'vf1-vault-'));
  write(path.join(vault, 'A.md'), '# A');
  write(path.join(vault, 'Macross', 'Profile.md'), '# generated');

  const adapter = new LocalVaultAdapter({ vaultPath: vault, outputDir: 'Macross', excludeDirs: ['.obsidian'] });
  const notes = await adapter.listNotes();

  assert.deepEqual(notes.map(n => n.relativePath).sort(), ['A.md']);
});

test('LocalVaultAdapter excludes nested outputDir by full relative path', async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'vf1-vault-'));
  write(path.join(vault, 'A.md'), '# A');
  write(path.join(vault, 'Generated', 'Keep.md'), '# keep');
  write(path.join(vault, 'Generated', 'Macross', 'Profile.md'), '# generated');

  const adapter = new LocalVaultAdapter({ vaultPath: vault, outputDir: 'Generated/Macross', excludeDirs: ['.obsidian'] });
  const notes = await adapter.listNotes();

  assert.deepEqual(notes.map(n => n.relativePath).sort(), ['A.md', 'Generated/Keep.md']);
});

test('LocalVaultAdapter rejects write and append paths that escape the vault', async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'vf1-vault-'));
  const escaped = path.resolve(vault, '..', 'escaped.md');
  const adapter = new LocalVaultAdapter({ vaultPath: vault, outputDir: 'Macross', excludeDirs: ['.obsidian'] });

  if (fs.existsSync(escaped)) fs.unlinkSync(escaped);
  await assert.rejects(() => adapter.writeNote({ relativePath: '../escaped.md' }, '# escaped\n'), /Invalid Obsidian note path/);
  await assert.rejects(() => adapter.appendToNote({ relativePath: '../escaped.md' }, '# escaped\n'), /Invalid Obsidian note path/);
  assert.equal(fs.existsSync(escaped), false);
});

test('LocalVaultAdapter rejects read paths that escape the vault', async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'vf1-vault-'));
  const adapter = new LocalVaultAdapter({ vaultPath: vault, outputDir: 'Macross', excludeDirs: ['.obsidian'] });

  await assert.rejects(() => adapter.readNote({ relativePath: '../escaped.md' }), /Invalid Obsidian note path/);
});
