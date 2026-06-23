const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petAPI', {
  getState: () => ipcRenderer.invoke('get-state'),
  saveState: (state) => ipcRenderer.invoke('save-state', state),
  togglePanel: () => ipcRenderer.invoke('toggle-panel'),
  closePanel: () => ipcRenderer.invoke('close-panel'),
  movePet: (x, y) => ipcRenderer.invoke('move-pet', x, y),

  chat: (message) => ipcRenderer.invoke('chat', message),

  // 文章投喂 (记忆系统)
  pickArticleFile: () => ipcRenderer.invoke('pick-article-file'),
  ingestArticleUrl: (url) => ipcRenderer.invoke('ingest-article-url', url),

  // 记忆面板
  getMemoryProfile: () => ipcRenderer.invoke('get-memory-profile'),
  updateMemoryProfile: (profile) => ipcRenderer.invoke('update-memory-profile', profile),
  clearMemory: () => ipcRenderer.invoke('clear-memory'),


  scanFiles: () => ipcRenderer.invoke('scan-files'),
  deleteFile: (filePath) => ipcRenderer.invoke('delete-file', filePath),
  getAiSuggestions: () => ipcRenderer.invoke('get-ai-suggestions'),

  setApiKey: (provider, key) => ipcRenderer.invoke('set-api-key', provider, key),
  setProvider: (provider) => ipcRenderer.invoke('set-provider', provider),
  setPetName: (name) => ipcRenderer.invoke('set-pet-name', name),
  setPetAvatar: (avatar) => ipcRenderer.invoke('set-pet-avatar', avatar),

  revealInFinder: (filePath) => ipcRenderer.invoke('reveal-in-finder', filePath),

  getWorkflows: () => ipcRenderer.invoke('get-workflows'),
  saveWorkflow: (wf) => ipcRenderer.invoke('save-workflow', wf),
  deleteWorkflow: (id) => ipcRenderer.invoke('delete-workflow', id),
  runWorkflow: (prompt) => ipcRenderer.invoke('run-workflow', prompt),

  onPetUpdate: (cb) => ipcRenderer.on('pet-update', (_, data) => cb(data)),
  offPetUpdate: () => ipcRenderer.removeAllListeners('pet-update'),

  getTerminalSessions: () => ipcRenderer.invoke('get-terminal-sessions'),
  sendTerminalInput: (opts) => ipcRenderer.invoke('send-terminal-input', opts),
  notifyPet: (msg) => ipcRenderer.invoke('notify-pet', msg),
  setTermAlert: (active, session) => ipcRenderer.invoke('set-term-alert', active, session),
  focusTerminalAlert: () => ipcRenderer.invoke('focus-terminal-alert'),
  getAlertSoundEnabled: () => ipcRenderer.invoke('get-alert-sound-enabled'),
  setAlertSoundEnabled: (enabled) => ipcRenderer.invoke('set-alert-sound-enabled', enabled),
  checkAxTrusted: () => ipcRenderer.invoke('check-ax-trusted'),
  openAxSettings: () => ipcRenderer.invoke('open-ax-settings'),


  reportVoices: (voices) => ipcRenderer.invoke('report-voices', voices),

  getBreakReminder: () => ipcRenderer.invoke('get-break-reminder'),
  setBreakReminder: (cfg) => ipcRenderer.invoke('set-break-reminder', cfg),
  triggerBreakReminder: () => ipcRenderer.invoke('trigger-break-reminder'),
  getEdgePatrol: () => ipcRenderer.invoke('get-edge-patrol'),
  setEdgePatrol: (cfg) => ipcRenderer.invoke('set-edge-patrol', cfg),
  getPetVisible: () => ipcRenderer.invoke('get-pet-visible'),
  togglePetVisible: () => ipcRenderer.invoke('toggle-pet-visible'),
  getLite: () => ipcRenderer.invoke('get-lite'),
  getVoiceLines: () => ipcRenderer.invoke('get-voice-lines'),
  getVoiceLang: () => ipcRenderer.invoke('get-voice-lang'),
  setVoiceLang: (lang) => ipcRenderer.invoke('set-voice-lang', lang),
  getPersona: () => ipcRenderer.invoke('get-persona'),
  setPersona: (text) => ipcRenderer.invoke('set-persona', text),
  getSessionRules: () => ipcRenderer.invoke('get-session-rules'),
  setSessionRules: (text) => ipcRenderer.invoke('set-session-rules', text),
  resetPetPosition: () => ipcRenderer.invoke('reset-pet-position'),
  setIgnoreMouse: (ignore) => ipcRenderer.invoke('set-ignore-mouse', ignore),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  notifySpeechEnd: () => ipcRenderer.invoke('notify-speech-end'),

});
