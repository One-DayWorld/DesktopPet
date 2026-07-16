const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petAPI', {
  getState: () => ipcRenderer.invoke('get-state'),
  saveState: (state) => ipcRenderer.invoke('save-state', state),
  togglePanel: () => ipcRenderer.invoke('toggle-panel'),
  closePanel: () => ipcRenderer.invoke('close-panel'),
  movePet: (x, y) => ipcRenderer.invoke('move-pet', x, y),

  chat: (message) => ipcRenderer.invoke('chat', message),

  getObsidianConfig: () => ipcRenderer.invoke('get-obsidian-config'),
  setObsidianConfig: (cfg) => ipcRenderer.invoke('set-obsidian-config', cfg),
  obsidianSyncNow: () => ipcRenderer.invoke('obsidian-sync-now'),
  getObsidianStatus: () => ipcRenderer.invoke('get-obsidian-status'),
  openObsidianOutputDir: () => ipcRenderer.invoke('open-obsidian-output-dir'),

  // 文章投喂 (记忆系统)
  pickArticleFile: () => ipcRenderer.invoke('pick-article-file'),
  ingestArticleUrl: (url) => ipcRenderer.invoke('ingest-article-url', url),

  // 设定文件 (性格 / 本场规则 / 长期记忆 三合一) + 从头开始
  openConfigFile: () => ipcRenderer.invoke('open-config-file'),
  resetConversation: () => ipcRenderer.invoke('reset-conversation'),

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
  getPersona: () => ipcRenderer.invoke('get-persona'),
  setPersona: (text) => ipcRenderer.invoke('set-persona', text),
  getSessionRules: () => ipcRenderer.invoke('get-session-rules'),
  setSessionRules: (text) => ipcRenderer.invoke('set-session-rules', text),
  getQwenModel: () => ipcRenderer.invoke('get-qwen-model'),
  setQwenModel: (model) => ipcRenderer.invoke('set-qwen-model', model),
  resetPetPosition: () => ipcRenderer.invoke('reset-pet-position'),
  setIgnoreMouse: (ignore) => ipcRenderer.invoke('set-ignore-mouse', ignore),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  notifySpeechEnd: () => ipcRenderer.invoke('notify-speech-end'),

});
