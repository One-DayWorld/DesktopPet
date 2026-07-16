const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_FILE = path.join(os.homedir(), '.desktop-pet', 'obsidian-sync.json');
const DEFAULT_STATE = { version: 1, lastSyncAt: null, notes: {}, recentWrites: [] };

function mergeState(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const notes = input.notes && typeof input.notes === 'object' && !Array.isArray(input.notes) ? Object.assign({}, input.notes) : {};
  const recentWrites = Array.isArray(input.recentWrites) ? input.recentWrites.slice() : [];
  return {
    version: Number(input.version) || DEFAULT_STATE.version,
    lastSyncAt: input.lastSyncAt || null,
    notes,
    recentWrites
  };
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
      const tmp = filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(mergeState(state), null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, filePath);
      try {
        fs.chmodSync(filePath, 0o600);
      } catch (_) {}
    }
  };
}

module.exports = { createSyncStateStore, DEFAULT_FILE };
