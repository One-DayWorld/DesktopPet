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

function noteCharLength(note) {
  return String((note && (note.body || note.content || note.title)) || '').length;
}

function batchNotesByChars(notes, maxChars) {
  const limit = Math.max(1, Number(maxChars) || 24000);
  const batches = [];
  let current = [];
  let currentChars = 0;
  for (const note of notes) {
    const chars = Math.max(1, noteCharLength(note));
    if (current.length && currentChars + chars > limit) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(note);
    currentChars += chars;
  }
  if (current.length) batches.push(current);
  return batches;
}

function saveNoteFingerprints(state, notes) {
  for (const n of notes) {
    const old = state.notes[n.relativePath] || {};
    state.notes[n.relativePath] = { mtimeMs: n.mtimeMs, size: n.size, hash: n.hash || old.hash || '' };
  }
}

function createObsidianService(deps) {
  const config = deps.config || {};
  const adapter = deps.adapter || new LocalVaultAdapter(config);
  const syncStore = deps.syncStore;
  const getMemoryText = deps.getMemoryText;
  const setMemoryText = deps.setMemoryText;
  const refineNotes = deps.refineNotes;
  const extractWriteBack = deps.extractWriteBack;
  const status = {
    ok: true,
    lastSyncAt: null,
    lastWriteBackAt: null,
    scannedFiles: 0,
    changedFiles: 0,
    lastError: '',
    lastSyncError: '',
    lastWriteBackError: ''
  };
  let writeBackTurns = [];
  let nextTurnId = 1;
  let pendingWriteBackBatch = null;
  let flushInFlight = null;

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
      const changed = await adapter.getChangedNotes(state, all);
      status.scannedFiles = all.length;
      status.changedFiles = changed.length;
      if (changed.length) {
        const notes = [];
        for (const n of changed) {
          notes.push(Object.assign(await adapter.readNote(n), {
            mtimeMs: n.mtimeMs,
            size: n.size,
            hash: n.hash
          }));
        }
        let currentMemory = String(getMemoryText() || '');
        let memoryChanged = false;
        for (const batch of batchNotesByChars(notes, config.maxSyncBatchChars)) {
          const next = await refineNotes(currentMemory, batch);
          if (next && String(next).trim()) {
            currentMemory = String(next).trim();
            setMemoryText(currentMemory);
            memoryChanged = true;
          }
          saveNoteFingerprints(state, batch);
          syncStore.save(state);
        }
        if (memoryChanged) await writeProfile();
      }
      saveNoteFingerprints(state, all);
      state.lastSyncAt = new Date().toISOString();
      syncStore.save(state);
      return setStatus({ ok: true, skipped: false, lastSyncAt: state.lastSyncAt, lastError: '', lastSyncError: '' });
    } catch (e) {
      return setStatus({ ok: false, skipped: false, lastError: e.message, lastSyncError: e.message });
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

  function createWriteBackBatch(turns) {
    const batchTurns = turns.slice();
    const ids = batchTurns.map(t => t.id);
    return {
      ids,
      turns: batchTurns,
      batchId: ids.length ? ids.join('-') : 'profile'
    };
  }

  async function doFlushWriteBack(reason = 'manual') {
    if (!enabled() || !autoWriteBackEnabled()) return { ok: true, skipped: true };
    const batch = pendingWriteBackBatch || createWriteBackBatch(writeBackTurns);
    const turns = batch.turns;
    try {
      await writeProfile();
      if (!turns.length) {
        const now = new Date().toISOString();
        setStatus({ ok: true, lastWriteBackAt: now, lastError: '', lastWriteBackError: '' });
        return { ok: true, wrote: 1 };
      }
      const extracted = await extractWriteBack(turns);
      const inbox = Array.isArray(extracted && extracted.inbox) ? extracted.inbox.map(cleanInbox).filter(Boolean) : [];
      const highlights = Array.isArray(extracted && extracted.highlights) ? extracted.highlights.map(cleanHighlight).filter(Boolean) : [];
      if (inbox.length) {
        const lines = inbox.map(x => `- ${stamp()} [[来源: VF-1 Chat]] ${String(x).trim()}`).join('\n') + '\n';
        await appendBlockOnce(outputRel('Inbox.md'), `<!-- vf1-writeback:${batch.batchId}:inbox -->`, lines);
      }
      if (highlights.length) {
        const lines = `\n## ${stamp()} (${reason})\n\n` + highlights.map(h => `- 主题: ${h.topic || ''}\n- 可复用结论: ${h.reusable || ''}\n- 后续行动: ${h.action || ''}`).join('\n\n') + '\n';
        await appendBlockOnce(outputRel(path.posix.join('Chat Highlights', `${monthName()}.md`)), `<!-- vf1-writeback:${batch.batchId}:highlights -->`, lines);
      }
      const processedIds = new Set(batch.ids);
      writeBackTurns = writeBackTurns.filter(t => !processedIds.has(t.id));
      pendingWriteBackBatch = null;
      const now = new Date().toISOString();
      setStatus({ ok: true, lastWriteBackAt: now, lastError: '', lastWriteBackError: '' });
      return { ok: true, wrote: 1 + inbox.length + highlights.length };
    } catch (e) {
      if (turns.length) pendingWriteBackBatch = batch;
      setStatus({ ok: false, lastError: e.message, lastWriteBackError: e.message });
      return { ok: false, error: e.message };
    }
  }

  async function flushWriteBack(reason = 'manual') {
    if (flushInFlight) return flushInFlight;
    flushInFlight = doFlushWriteBack(reason).finally(() => {
      flushInFlight = null;
    });
    return flushInFlight;
  }

  return { syncNow, bufferChatTurn, flushWriteBack, writeProfile, getStatus: () => Object.assign({}, status) };
}

module.exports = { createObsidianService };
