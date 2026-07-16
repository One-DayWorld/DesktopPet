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

function symlinkOrSkip(t, target, linkPath, type) {
  try {
    fs.symlinkSync(target, linkPath, type);
  } catch (err) {
    if (err && ['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP'].includes(err.code)) {
      t.skip(`symlink not supported: ${err.code}`);
      return false;
    }
    throw err;
  }
  return true;
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

test('LocalVaultAdapter skips symlinked markdown files and directories when listing notes', async (t) => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'vf1-vault-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'vf1-outside-'));
  write(path.join(vault, 'A.md'), '# A');
  write(path.join(outside, 'Outside.md'), '# outside');
  write(path.join(outside, 'Linked.md'), '# linked');

  if (!symlinkOrSkip(t, outside, path.join(vault, 'LinkedDir'), 'dir')) return;
  if (!symlinkOrSkip(t, path.join(outside, 'Linked.md'), path.join(vault, 'Link.md'), 'file')) return;

  const adapter = new LocalVaultAdapter({ vaultPath: vault, outputDir: 'Macross', excludeDirs: ['.obsidian'] });
  const notes = await adapter.listNotes();

  assert.deepEqual(notes.map(n => n.relativePath).sort(), ['A.md']);
});

test('LocalVaultAdapter rejects writing through a symlinked note file', async (t) => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'vf1-vault-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'vf1-outside-'));
  const outsideFile = path.join(outside, 'Link.md');
  write(outsideFile, '# outside\n');
  if (!symlinkOrSkip(t, outsideFile, path.join(vault, 'Link.md'), 'file')) return;

  const adapter = new LocalVaultAdapter({ vaultPath: vault, outputDir: 'Macross', excludeDirs: ['.obsidian'] });

  await assert.rejects(() => adapter.writeNote({ relativePath: 'Link.md' }, '# changed\n'), /symlink/i);
  assert.equal(fs.readFileSync(outsideFile, 'utf8'), '# outside\n');
});

test('LocalVaultAdapter rejects appending through a symlinked note file', async (t) => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'vf1-vault-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'vf1-outside-'));
  const outsideFile = path.join(outside, 'Link.md');
  write(outsideFile, '# outside\n');
  if (!symlinkOrSkip(t, outsideFile, path.join(vault, 'Link.md'), 'file')) return;

  const adapter = new LocalVaultAdapter({ vaultPath: vault, outputDir: 'Macross', excludeDirs: ['.obsidian'] });

  await assert.rejects(() => adapter.appendToNote({ relativePath: 'Link.md' }, '- changed\n'), /symlink/i);
  assert.equal(fs.readFileSync(outsideFile, 'utf8'), '# outside\n');
});

test('LocalVaultAdapter rejects writing through a symlinked parent directory', async (t) => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'vf1-vault-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'vf1-outside-'));
  if (!symlinkOrSkip(t, outside, path.join(vault, 'LinkedDir'), 'dir')) return;

  const adapter = new LocalVaultAdapter({ vaultPath: vault, outputDir: 'Macross', excludeDirs: ['.obsidian'] });
  const outsideFile = path.join(outside, 'A.md');

  await assert.rejects(() => adapter.writeNote({ relativePath: 'LinkedDir/A.md' }, '# changed\n'), /vault|symlink/i);
  assert.equal(fs.existsSync(outsideFile), false);
});

test('LocalVaultAdapter rejects reading through a symlinked note file', async (t) => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'vf1-vault-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'vf1-outside-'));
  const outsideFile = path.join(outside, 'Link.md');
  write(outsideFile, '# outside\n');
  if (!symlinkOrSkip(t, outsideFile, path.join(vault, 'Link.md'), 'file')) return;

  const adapter = new LocalVaultAdapter({ vaultPath: vault, outputDir: 'Macross', excludeDirs: ['.obsidian'] });

  await assert.rejects(() => adapter.readNote({ relativePath: 'Link.md' }), /symlink/i);
});
