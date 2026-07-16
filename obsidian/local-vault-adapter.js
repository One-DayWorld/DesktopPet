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

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

class LocalVaultAdapter {
  constructor(config) {
    this.config = config || {};
    this.vaultPath = path.resolve(this.config.vaultPath || '');
    this.outputDir = normalizeRel(this.config.outputDir || 'Macross');
    this.excludeDirs = new Set(['.obsidian', this.outputDir, ...(this.config.excludeDirs || [])].map(normalizeRel).filter(Boolean));
  }

  assertVault() {
    if (!this.vaultPath || !fs.existsSync(this.vaultPath)) throw new Error(`Obsidian vault path not found: ${this.vaultPath}`);
    if (!fs.statSync(this.vaultPath).isDirectory()) throw new Error(`Obsidian vault path is not a directory: ${this.vaultPath}`);
  }

  vaultRealPath() {
    this.assertVault();
    return fs.realpathSync(this.vaultPath);
  }

  shouldSkipDir(absDir) {
    const rel = normalizeRel(path.relative(this.vaultPath, absDir));
    if (!rel) return false;
    if (rel.split('/').some(part => part.startsWith('.'))) return true;
    return [...this.excludeDirs].some(excluded => rel === excluded || rel.startsWith(`${excluded}/`));
  }

  realPathInsideVault(absPath) {
    return isInside(this.vaultRealPath(), fs.realpathSync(absPath));
  }

  assertNotSymlink(absPath) {
    try {
      if (fs.lstatSync(absPath).isSymbolicLink()) throw new Error('Obsidian note path is a symlink');
    } catch (err) {
      if (err && err.code === 'ENOENT') return;
      throw err;
    }
  }

  assertSafeParent(absPath) {
    const vaultRealPath = this.vaultRealPath();
    let current = path.dirname(absPath);
    const root = path.parse(current).root;
    while (true) {
      try {
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink()) throw new Error('Obsidian note parent path is a symlink');
        if (!stat.isDirectory()) throw new Error(`Obsidian note parent path is not a directory: ${current}`);
        if (!isInside(vaultRealPath, fs.realpathSync(current))) throw new Error('Obsidian note path escapes vault');
        return;
      } catch (err) {
        if (!err || err.code !== 'ENOENT') throw err;
      }
      if (current === root) throw new Error('Obsidian note path escapes vault');
      current = path.dirname(current);
    }
  }

  resolveNotePath(relativePath, opts) {
    const rel = normalizeRel(relativePath);
    if (!rel || rel.split('/').includes('..')) throw new Error('Invalid Obsidian note path');
    const abs = path.resolve(this.vaultPath, rel);
    if (!isInside(this.vaultPath, abs)) throw new Error('Obsidian note path escapes vault');
    if (opts && opts.safeParent) this.assertSafeParent(abs);
    if (opts && opts.rejectSymlink) this.assertNotSymlink(abs);
    if (opts && opts.requireRealPathInside && fs.existsSync(abs) && !this.realPathInsideVault(abs)) {
      throw new Error('Obsidian note path escapes vault');
    }
    return { relativePath: rel, path: abs };
  }

  async listNotes() {
    this.assertVault();
    const out = [];
    const walk = (dir) => {
      if (this.shouldSkipDir(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        if (entry.name.startsWith('.')) continue;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(abs);
        else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
          const stat = fs.statSync(abs);
          const relativePath = normalizeRel(path.relative(this.vaultPath, abs));
          out.push({ path: abs, relativePath, mtimeMs: stat.mtimeMs, size: stat.size });
        }
      }
    };
    walk(this.vaultPath);
    return out;
  }

  async readNote(noteRef) {
    const resolved = this.resolveNotePath(noteRef.relativePath, { rejectSymlink: true, requireRealPathInside: true });
    const content = fs.readFileSync(resolved.path, 'utf8');
    return Object.assign(parseMarkdownNote({ path: resolved.path, relativePath: resolved.relativePath, content }), { content });
  }

  async writeNote(noteRef, content) {
    const resolved = this.resolveNotePath(noteRef.relativePath, { safeParent: true, rejectSymlink: true, requireRealPathInside: true });
    fs.mkdirSync(path.dirname(resolved.path), { recursive: true });
    fs.writeFileSync(resolved.path, String(content || ''), 'utf8');
    return resolved;
  }

  async appendToNote(noteRef, content) {
    const resolved = this.resolveNotePath(noteRef.relativePath, { safeParent: true, rejectSymlink: true, requireRealPathInside: true });
    fs.mkdirSync(path.dirname(resolved.path), { recursive: true });
    fs.appendFileSync(resolved.path, String(content || ''), 'utf8');
    return resolved;
  }

  async getChangedNotes(previousState, listedNotes) {
    const stateNotes = (previousState && previousState.notes) || {};
    const listed = listedNotes || await this.listNotes();
    const changed = [];
    for (const n of listed) {
      const old = stateNotes[n.relativePath];
      if (old && old.mtimeMs === n.mtimeMs && old.size === n.size && old.hash) {
        n.hash = old.hash;
        continue;
      }
      const resolved = this.resolveNotePath(n.relativePath, { rejectSymlink: true, requireRealPathInside: true });
      const hash = hashText(fs.readFileSync(resolved.path, 'utf8'));
      n.hash = hash;
      if (!old || old.mtimeMs !== n.mtimeMs || old.size !== n.size || old.hash !== n.hash) changed.push(n);
    }
    return changed;
  }
}

module.exports = { LocalVaultAdapter, normalizeRel, hashText, isInside };
