const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_FILE = path.join(os.homedir(), '.desktop-pet', 'obsidian-sync.json');
const DEFAULT_STATE = { version: 1, lastSyncAt: null, notes: {}, recentWrites: [] };
const DANGEROUS_NOTE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
let tmpCounter = 0;

function normalizeLastSyncAt(value) {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return value;
}

function mergeState(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const notes = {};
  if (input.notes && typeof input.notes === 'object' && !Array.isArray(input.notes)) {
    for (const [key, value] of Object.entries(input.notes)) {
      if (!DANGEROUS_NOTE_KEYS.has(key)) notes[key] = value;
    }
  }
  const recentWrites = Array.isArray(input.recentWrites) ? input.recentWrites.slice() : [];
  return {
    version: typeof input.version === 'number' && Number.isInteger(input.version) && input.version > 0 ? input.version : DEFAULT_STATE.version,
    lastSyncAt: normalizeLastSyncAt(input.lastSyncAt),
    notes,
    recentWrites
  };
}

function createTmpPath(filePath) {
  tmpCounter = (tmpCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `${filePath}.${process.pid}.${Date.now()}.${tmpCounter}.tmp`;
}

function createSyncStateStore(filePath = DEFAULT_FILE) {
  return {
    filePath,
    load() {
      try {
        if (!fs.existsSync(filePath)) return mergeState();
        return mergeState(JSON.parse(fs.readFileSync(filePath, 'utf8')));
      } catch {
        return mergeState();
      }
    },
    save(state) {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = createTmpPath(filePath);
      try {
        fs.writeFileSync(tmp, JSON.stringify(mergeState(state), null, 2), { encoding: 'utf8', mode: 0o600 });
        fs.chmodSync(tmp, 0o600);
        fs.renameSync(tmp, filePath);
        fs.chmodSync(filePath, 0o600);
      } catch (err) {
        try {
          if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
        } catch (_) {}
        throw err;
      }
    }
  };
}

module.exports = { createSyncStateStore, DEFAULT_FILE };
