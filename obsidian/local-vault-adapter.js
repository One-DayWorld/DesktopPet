const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseMarkdownNote } = require('./markdown');

function normalizeRel(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function hashText(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex');
}

class LocalVaultAdapter {
  constructor(config) {
    this.config = config || {};
    this.vaultPath = path.resolve(this.config.vaultPath || '');
    this.outputDir = normalizeRel(this.config.outputDir || 'Macross');
    this.excludeDirs = new Set((this.config.excludeDirs || ['.obsidian', this.outputDir]).map(normalizeRel));
  }

  assertVault() {
    if (!this.vaultPath || !fs.existsSync(this.vaultPath)) throw new Error(`Obsidian vault path not found: ${this.vaultPath}`);
    if (!fs.statSync(this.vaultPath).isDirectory()) throw new Error(`Obsidian vault path is not a directory: ${this.vaultPath}`);
  }

  shouldSkipDir(absDir) {
    const rel = normalizeRel(path.relative(this.vaultPath, absDir));
    if (!rel) return false;
    return rel.split('/').some(part => part.startsWith('.') || this.excludeDirs.has(part));
  }

  async listNotes() {
    this.assertVault();
    const out = [];
    const walk = (dir) => {
      if (this.shouldSkipDir(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(abs);
        else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
          const stat = fs.statSync(abs);
          const content = fs.readFileSync(abs, 'utf8');
          const relativePath = normalizeRel(path.relative(this.vaultPath, abs));
          out.push({ path: abs, relativePath, mtimeMs: stat.mtimeMs, size: stat.size, hash: hashText(content) });
        }
      }
    };
    walk(this.vaultPath);
    return out;
  }

  async readNote(noteRef) {
    const relativePath = normalizeRel(noteRef.relativePath);
    const abs = path.join(this.vaultPath, relativePath);
    const content = fs.readFileSync(abs, 'utf8');
    return Object.assign(parseMarkdownNote({ path: abs, relativePath, content }), { content });
  }

  async writeNote(noteRef, content) {
    const relativePath = normalizeRel(noteRef.relativePath);
    const abs = path.join(this.vaultPath, relativePath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, String(content || ''), 'utf8');
    return { relativePath, path: abs };
  }

  async appendToNote(noteRef, content) {
    const relativePath = normalizeRel(noteRef.relativePath);
    const abs = path.join(this.vaultPath, relativePath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.appendFileSync(abs, String(content || ''), 'utf8');
    return { relativePath, path: abs };
  }

  async getChangedNotes(previousState) {
    const stateNotes = (previousState && previousState.notes) || {};
    const listed = await this.listNotes();
    return listed.filter(n => {
      const old = stateNotes[n.relativePath];
      return !old || old.mtimeMs !== n.mtimeMs || old.size !== n.size || old.hash !== n.hash;
    });
  }
}

module.exports = { LocalVaultAdapter, normalizeRel, hashText };
