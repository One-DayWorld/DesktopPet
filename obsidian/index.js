const path = require('path');
const { LocalVaultAdapter } = require('./local-vault-adapter');

function monthName(d = new Date()) {
  return d.toISOString().slice(0, 7);
}

function stamp(d = new Date()) {
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

function createObsidianService(deps) {
  const config = deps.config || {};
  const adapter = deps.adapter || new LocalVaultAdapter(config);
  const syncStore = deps.syncStore;
  const getMemoryText = deps.getMemoryText;
  const setMemoryText = deps.setMemoryText;
  const refineNotes = deps.refineNotes;
  const extractWriteBack = deps.extractWriteBack;
  const status = { ok: true, lastSyncAt: null, scannedFiles: 0, changedFiles: 0, lastError: '' };
  let writeBackTurns = [];

  function enabled() {
    return !!config.enabled;
  }

  function autoWriteBackEnabled() {
    return config.autoWriteBack !== false;
  }

  function outputRel(name) {
    return path.posix.join(config.outputDir || 'Macross', name);
  }

  async function syncNow() {
    if (!enabled()) return Object.assign(status, { ok: true, skipped: true, lastError: '' });
    try {
      const state = syncStore.load();
      const all = await adapter.listNotes();
      const changed = await adapter.getChangedNotes(state);
      status.scannedFiles = all.length;
      status.changedFiles = changed.length;
      if (changed.length) {
        const notes = [];
        for (const n of changed) notes.push(await adapter.readNote(n));
        const next = await refineNotes(getMemoryText(), notes);
        if (next && String(next).trim()) setMemoryText(String(next).trim());
        for (const n of all) state.notes[n.relativePath] = { mtimeMs: n.mtimeMs, size: n.size, hash: n.hash };
      }
      state.lastSyncAt = new Date().toISOString();
      syncStore.save(state);
      return Object.assign(status, { ok: true, lastSyncAt: state.lastSyncAt, lastError: '' });
    } catch (e) {
      return Object.assign(status, { ok: false, lastError: e.message });
    }
  }

  function bufferChatTurn(user, reply) {
    if (!enabled() || !autoWriteBackEnabled()) return;
    writeBackTurns.push({ user, reply });
    if (writeBackTurns.length > 50) writeBackTurns = writeBackTurns.slice(-50);
  }

  async function writeProfile() {
    const memory = String(getMemoryText() || '').trim();
    const text = `# VF-1 Profile\n\n> Last updated: ${stamp()}\n\n${memory || '暂无稳定画像。'}\n`;
    return adapter.writeNote({ relativePath: outputRel('Profile.md') }, text);
  }

  async function flushWriteBack(reason = 'manual') {
    if (!enabled() || !autoWriteBackEnabled()) return { ok: true, skipped: true };
    const turns = writeBackTurns;
    try {
      await writeProfile();
      writeBackTurns = [];
      if (!turns.length) return { ok: true, wrote: 1 };
      const extracted = await extractWriteBack(turns);
      const inbox = Array.isArray(extracted && extracted.inbox) ? extracted.inbox : [];
      const highlights = Array.isArray(extracted && extracted.highlights) ? extracted.highlights : [];
      if (inbox.length) {
        const lines = inbox.map(x => `- ${stamp()} [[来源: VF-1 Chat]] ${String(x).trim()}`).join('\n') + '\n';
        await adapter.appendToNote({ relativePath: outputRel('Inbox.md') }, lines);
      }
      if (highlights.length) {
        const lines = `\n## ${stamp()} (${reason})\n\n` + highlights.map(h => `- 主题: ${h.topic || ''}\n- 可复用结论: ${h.reusable || ''}\n- 后续行动: ${h.action || ''}`).join('\n\n') + '\n';
        await adapter.appendToNote({ relativePath: outputRel(path.posix.join('Chat Highlights', `${monthName()}.md`)) }, lines);
      }
      return { ok: true, wrote: 1 + inbox.length + highlights.length };
    } catch (e) {
      writeBackTurns = turns.concat(writeBackTurns);
      return { ok: false, error: e.message };
    }
  }

  return { syncNow, bufferChatTurn, flushWriteBack, writeProfile, getStatus: () => Object.assign({}, status) };
}

module.exports = { createObsidianService };
