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

function findLevelTwoHeadings(text) {
  const headings = [];
  let index = 0;
  let inFence = false;
  let fenceMarker = '';
  while (index < text.length) {
    const lineStart = index;
    const newline = text.indexOf('\n', index);
    const lineEnd = newline >= 0 ? newline : text.length;
    const line = text.slice(lineStart, lineEnd);
    const fence = line.match(/^\s{0,3}(```|~~~)/);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fence[1];
      } else if (fence[1] === fenceMarker) {
        inFence = false;
        fenceMarker = '';
      }
    } else if (!inFence && /^##\s+.+\s*$/.test(line)) {
      headings.push({
        start: lineStart,
        end: lineEnd,
        isStory: line.trimEnd() === STORY_KNOWLEDGE_HEADING
      });
    }
    index = newline >= 0 ? newline + 1 : text.length;
  }
  return headings;
}

function findStorySections(text) {
  const headings = findLevelTwoHeadings(text);
  const sections = [];
  for (let i = 0; i < headings.length; i += 1) {
    if (headings[i].isStory) {
      sections.push({
        start: headings[i].start,
        end: i + 1 < headings.length ? headings[i + 1].start : text.length
      });
    }
  }
  return sections;
}

function extractStoryKnowledgeSection(memoryText) {
  const text = String(memoryText || '').trim();
  if (!text) return '';
  const sections = findStorySections(text);
  if (!sections.length) return '';
  return text.slice(sections[0].start, sections[0].end).trim();
}

function replaceStoryKnowledgeSection(memoryText, storySection) {
  const base = String(memoryText || '').trim();
  const section = String(storySection || '').trim();
  if (!section) return base;
  const sections = findStorySections(base);
  if (!sections.length) return [base, section].filter(Boolean).join('\n\n');
  const parts = [];
  let cursor = 0;
  let inserted = false;
  for (const oldSection of sections) {
    const before = base.slice(cursor, oldSection.start).trim();
    if (before) parts.push(before);
    if (!inserted) {
      parts.push(section);
      inserted = true;
    }
    cursor = oldSection.end;
  }
  const after = base.slice(cursor).trim();
  if (after) parts.push(after);
  return parts.join('\n\n');
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
    let memoryChanged = false;
    try {
      const state = syncStore.load();
      const all = await adapter.listNotes();
      const changed = await adapter.getChangedNotes(state, all);
      const changedPaths = new Set(changed.map(n => n.relativePath));
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
        let currentSection = extractStoryKnowledgeSection(currentMemory);
        for (const batch of batchNotesByChars(notes, config.maxBatchChars)) {
          const nextSection = await refineStoryKnowledge(currentSection, batch);
          if (nextSection && String(nextSection).trim()) {
            currentSection = String(nextSection).trim();
            currentMemory = replaceStoryKnowledgeSection(currentMemory, currentSection);
            setMemoryText(currentMemory);
            memoryChanged = true;
            saveNoteFingerprints(state, batch);
            syncStore.save(state);
          }
        }
      }
      saveNoteFingerprints(state, all.filter(n => !changedPaths.has(n.relativePath)));
      state.lastLearnAt = new Date().toISOString();
      syncStore.save(state);
      return setStatus({ ok: true, skipped: false, lastLearnAt: state.lastLearnAt, memoryChanged, lastError: '' });
    } catch (e) {
      return setStatus({ ok: false, skipped: false, memoryChanged, lastError: e.message });
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
