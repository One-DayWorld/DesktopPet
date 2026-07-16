const path = require('path');
const { LocalVaultAdapter } = require('./local-vault-adapter');

function monthName(d = new Date()) {
  return d.toISOString().slice(0, 7);
}

function stamp(d = new Date()) {
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

function cleanOneLine(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

function cleanInbox(value) {
  if (typeof value !== 'string') return '';
  return cleanOneLine(value);
}

function cleanHighlight(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = {
    topic: cleanOneLine(value.topic),
    reusable: cleanOneLine(value.reusable),
    action: cleanOneLine(value.action)
  };
  if (!item.topic && !item.reusable && !item.action) return null;
  return item;
}

function normalizeOutputPart(value, fallback) {
  const raw = cleanOneLine(value).replace(/\\/g, '/').replace(/^\/+/, '');
  const rel = raw || fallback;
  const segments = rel.split('/').filter(Boolean);
  if (segments.includes('..')) throw new Error('Invalid Obsidian output path');
  return segments.join('/');
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
  let nextTurnId = 1;

  function enabled() {
    return !!config.enabled;
  }

  function autoWriteBackEnabled() {
    return config.autoWriteBack !== false;
  }

  function setStatus(next) {
    Object.assign(status, next);
    return Object.assign({}, status);
  }

  function outputRel(name) {
    const outputDir = normalizeOutputPart(config.outputDir, 'Macross');
    const noteName = normalizeOutputPart(name, '');
    return path.posix.join(outputDir, noteName);
  }

  async function syncNow() {
    if (!enabled()) return setStatus({ ok: true, skipped: true, lastError: '' });
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
      }
      for (const n of all) state.notes[n.relativePath] = { mtimeMs: n.mtimeMs, size: n.size, hash: n.hash };
      state.lastSyncAt = new Date().toISOString();
      syncStore.save(state);
      return setStatus({ ok: true, skipped: false, lastSyncAt: state.lastSyncAt, lastError: '' });
    } catch (e) {
      return setStatus({ ok: false, skipped: false, lastError: e.message });
    }
  }

  function bufferChatTurn(user, reply) {
    if (!enabled() || !autoWriteBackEnabled()) return;
    writeBackTurns.push({ id: nextTurnId++, user, reply });
    if (writeBackTurns.length > 50) writeBackTurns = writeBackTurns.slice(-50);
  }

  async function writeProfile() {
    const memory = String(getMemoryText() || '').trim();
    const text = `# VF-1 Profile\n\n> Last updated: ${stamp()}\n\n${memory || '暂无稳定画像。'}\n`;
    return adapter.writeNote({ relativePath: outputRel('Profile.md') }, text);
  }

  async function noteHasMarker(relativePath, marker) {
    if (typeof adapter.readNote !== 'function') return false;
    try {
      const note = await adapter.readNote({ relativePath });
      const content = note && note.content !== undefined ? note.content : note;
      return String(content || '').includes(marker);
    } catch (e) {
      if (e && (e.code === 'ENOENT' || /not found|no such file|不存在/i.test(e.message || ''))) return false;
      throw e;
    }
  }

  async function appendBlockOnce(relativePath, marker, content) {
    if (await noteHasMarker(relativePath, marker)) return false;
    await adapter.appendToNote({ relativePath }, `${marker}\n${content}`);
    return true;
  }

  async function flushWriteBack(reason = 'manual') {
    if (!enabled() || !autoWriteBackEnabled()) return { ok: true, skipped: true };
    const turns = writeBackTurns.slice();
    const processedIds = new Set(turns.map(t => t.id));
    const batchId = turns.length ? turns.map(t => t.id).join('-') : 'profile';
    try {
      await writeProfile();
      if (!turns.length) return { ok: true, wrote: 1 };
      const extracted = await extractWriteBack(turns);
      const inbox = Array.isArray(extracted && extracted.inbox) ? extracted.inbox.map(cleanInbox).filter(Boolean) : [];
      const highlights = Array.isArray(extracted && extracted.highlights) ? extracted.highlights.map(cleanHighlight).filter(Boolean) : [];
      if (inbox.length) {
        const lines = inbox.map(x => `- ${stamp()} [[来源: VF-1 Chat]] ${String(x).trim()}`).join('\n') + '\n';
        await appendBlockOnce(outputRel('Inbox.md'), `<!-- vf1-writeback:${batchId}:inbox -->`, lines);
      }
      if (highlights.length) {
        const lines = `\n## ${stamp()} (${reason})\n\n` + highlights.map(h => `- 主题: ${h.topic || ''}\n- 可复用结论: ${h.reusable || ''}\n- 后续行动: ${h.action || ''}`).join('\n\n') + '\n';
        await appendBlockOnce(outputRel(path.posix.join('Chat Highlights', `${monthName()}.md`)), `<!-- vf1-writeback:${batchId}:highlights -->`, lines);
      }
      writeBackTurns = writeBackTurns.filter(t => !processedIds.has(t.id));
      return { ok: true, wrote: 1 + inbox.length + highlights.length };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  return { syncNow, bufferChatTurn, flushWriteBack, writeProfile, getStatus: () => Object.assign({}, status) };
}

module.exports = { createObsidianService };
