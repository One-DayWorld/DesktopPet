const { LocalVaultAdapter } = require('../obsidian/local-vault-adapter');
const { STORY_KNOWLEDGE_HEADING } = require('./prompts');

function noteCharLength(note) {
  return String((note && (note.body || note.content || note.title)) || '').length;
}

function batchNotesByChars(notes, maxChars) {
  const limit = Math.max(1, Number(maxChars) || 24000);
  const batches = [];
  let current = [];
  let currentChars = 0;
  for (const note of notes || []) {
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
  for (const n of notes || []) {
    const old = state.notes[n.relativePath] || {};
    state.notes[n.relativePath] = { mtimeMs: n.mtimeMs, size: n.size, hash: n.hash || old.hash || '' };
  }
}

function extractStoryKnowledgeSection(memoryText) {
  const text = String(memoryText || '').trim();
  if (!text) return '';
  const start = text.indexOf(STORY_KNOWLEDGE_HEADING);
  if (start < 0) return '';
  const rest = text.slice(start);
  const next = rest.slice(STORY_KNOWLEDGE_HEADING.length).search(/\n##\s(?!#)/);
  return (next >= 0 ? rest.slice(0, STORY_KNOWLEDGE_HEADING.length + next) : rest).trim();
}

function replaceStoryKnowledgeSection(memoryText, storySection) {
  const base = String(memoryText || '').trim();
  const section = String(storySection || '').trim();
  if (!section) return base;
  const start = base.indexOf(STORY_KNOWLEDGE_HEADING);
  if (start < 0) return [base, section].filter(Boolean).join('\n\n');
  const before = base.slice(0, start).trimEnd();
  const rest = base.slice(start);
  const next = rest.slice(STORY_KNOWLEDGE_HEADING.length).search(/\n##\s(?!#)/);
  const after = next >= 0 ? rest.slice(STORY_KNOWLEDGE_HEADING.length + next).trimStart() : '';
  return [before, section, after].filter(Boolean).join('\n\n');
}

function createStoryAdapter(config) {
  return new LocalVaultAdapter({
    vaultPath: config.storyPath,
    outputDir: 'Macross',
    excludeDirs: ['.obsidian', 'Macross']
  });
}

function createStoryLearningService(deps) {
  const config = deps.config || {};
  const adapter = deps.adapter || createStoryAdapter(config);
  const syncStore = deps.syncStore;
  const getMemoryText = deps.getMemoryText;
  const setMemoryText = deps.setMemoryText;
  const refineStoryKnowledge = deps.refineStoryKnowledge;
  const status = { ok: true, lastLearnAt: null, scannedFiles: 0, changedFiles: 0, memoryChanged: false, lastError: '' };

  function enabled() {
    return config.enabled !== false;
  }

  function setStatus(next) {
    Object.assign(status, next);
    return Object.assign({}, status);
  }

  async function learnNow() {
    if (!enabled()) return setStatus({ ok: true, skipped: true, lastError: '' });
    try {
      const state = syncStore.load();
      const all = await adapter.listNotes();
      const changed = await adapter.getChangedNotes(state, all);
      status.scannedFiles = all.length;
      status.changedFiles = changed.length;
      let memoryChanged = false;
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
        let currentSection = extractStoryKnowledgeSection(currentMemory);
        for (const batch of batchNotesByChars(notes, config.maxBatchChars)) {
          const nextSection = await refineStoryKnowledge(currentSection, batch);
          if (nextSection && String(nextSection).trim()) {
            currentSection = String(nextSection).trim();
            currentMemory = replaceStoryKnowledgeSection(currentMemory, currentSection);
            setMemoryText(currentMemory);
            memoryChanged = true;
          }
          saveNoteFingerprints(state, batch);
          syncStore.save(state);
        }
      }
      saveNoteFingerprints(state, all);
      state.lastLearnAt = new Date().toISOString();
      syncStore.save(state);
      return setStatus({ ok: true, skipped: false, lastLearnAt: state.lastLearnAt, memoryChanged, lastError: '' });
    } catch (e) {
      return setStatus({ ok: false, skipped: false, memoryChanged: false, lastError: e.message });
    }
  }

  return { learnNow, getStatus: () => Object.assign({}, status) };
}

module.exports = {
  STORY_KNOWLEDGE_HEADING,
  batchNotesByChars,
  extractStoryKnowledgeSection,
  replaceStoryKnowledgeSection,
  createStoryLearningService
};
