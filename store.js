const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = path.join(os.homedir(), '.desktop-pet');
const DATA_FILE = path.join(DATA_DIR, 'data.json');

// 羁绊值阈值 (Lv.1→Lv.10). 羁绊只靠交流涨 (聊天/喂文章/给反馈), 曲线调成合理交流量内可达默契 Lv.6+.
const XP_THRESHOLDS = [0, 40, 100, 200, 350, 550, 800, 1100, 1500, 2000];

const DEFAULT_STATE = {
  pet: { name: '骷髅一号', level: 1, xp: 0, mood: 'happy', avatar: '🐕' },
  chatHistory: [],
  aiProvider: 'qwen',
  apiKeys: { qwen: '', deepseek: '', metaso: '' },
  petPosition: { x: 100, y: 100 },
  workflows: [],
  alertSoundEnabled: true,
  breakReminder: { enabled: true, intervalMin: 60 },
  edgePatrol:    { enabled: true },
  obsidian: {
    enabled: false,
    vaultPath: '/Users/ace/Documents/OneDayWorld',
    readMode: 'root',
    includeTags: [],
    excludeDirs: ['.obsidian', 'Macross'],
    outputDir: 'Macross',
    autoSync: true,
    autoWriteBack: true,
    syncIntervalMin: 30,
    writeBackEveryTurns: 10
  },
  storyLearning: {
    enabled: true,
    storyPath: '/Users/ace/Documents/OneDayWorld/Story',
    autoSync: false,
    maxBatchChars: 24000
  },
  voiceLang:     'zh',           // 语音台词语言: 'zh' 中文 / 'en' 英文
  persona:       '',             // [已迁移] 现存于 ~/.desktop-pet/persona-memory.md; 此字段仅供旧数据一次性迁移(migrateIfNeeded)
  sessionRules:  '',             // [已迁移] 同上, 现存于 persona-memory.md 的「本场规则」段
  qwenModel:     'qwen-plus',    // 千问后台具体型号: 'qwen-plus'(默认/更省) 或 'qwen-max'(更强/更贵)
  deepseekModel: 'deepseek-v4-flash'  // DeepSeek 具体型号: 'deepseek-v4-flash'(默认) 或 'deepseek-v4-pro'(旗舰)
};

function calcLevelFromXP(xp) {
  let level = 1;
  for (let i = 1; i < XP_THRESHOLDS.length; i++) {
    if (xp >= XP_THRESHOLDS[i]) level = i + 1;
    else break;
  }
  return level;
}

function normalizePositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.trunc(n));
}

// data.json 含明文 API Key, 目录/文件都收紧到仅本人可读写 (0700 / 0600)
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  else { try { fs.chmodSync(DATA_DIR, 0o700); } catch (_) {} }
}

function load() {
  try {
    ensureDataDir();
    if (!fs.existsSync(DATA_FILE)) return JSON.parse(JSON.stringify(DEFAULT_STATE));
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const data = JSON.parse(raw);
    const merged = Object.assign({}, JSON.parse(JSON.stringify(DEFAULT_STATE)), data);
    // migrate old single apiKey field (远古版本: 只有一个 apiKey 字段)
    if (data.apiKey && !merged.apiKeys.qwen) {
      merged.apiKeys.qwen = data.apiKey;
      delete merged.apiKey;
    }
    merged.apiKeys = Object.assign({}, DEFAULT_STATE.apiKeys, merged.apiKeys);
    // 清理已下线后台的残留 key 字段 (openai/anthropic/doubao/ollama/claude 均已下线)
    ['doubao', 'ollama', 'claude', 'openai', 'anthropic'].forEach(k => { if (merged.apiKeys[k] !== undefined) delete merged.apiKeys[k]; });
    // 选中的后台若已不在有效集合内, 回退到 qwen
    const VALID_PROVIDERS = ['qwen', 'deepseek'];
    if (!VALID_PROVIDERS.includes(merged.aiProvider)) merged.aiProvider = 'qwen';
    // 千问型号只允许 plus / max, 非法值回退 plus
    const VALID_QWEN = ['qwen-plus', 'qwen-max'];
    if (!VALID_QWEN.includes(merged.qwenModel)) merged.qwenModel = 'qwen-plus';
    // DeepSeek 型号只允许 v4-flash / v4-pro, 非法值回退 v4-flash
    const VALID_DEEPSEEK = ['deepseek-v4-flash', 'deepseek-v4-pro'];
    if (!VALID_DEEPSEEK.includes(merged.deepseekModel)) merged.deepseekModel = 'deepseek-v4-flash';
    // deep merge pet to fill any missing fields
    merged.pet = Object.assign({}, DEFAULT_STATE.pet, merged.pet);
    // deep merge breakReminder for older data files that don't have this field
    merged.breakReminder = Object.assign({}, DEFAULT_STATE.breakReminder, merged.breakReminder || {});
    merged.edgePatrol    = Object.assign({}, DEFAULT_STATE.edgePatrol,    merged.edgePatrol    || {});
    merged.obsidian = Object.assign({}, DEFAULT_STATE.obsidian, merged.obsidian || {});
    merged.obsidian.includeTags = Array.isArray(merged.obsidian.includeTags) ? merged.obsidian.includeTags.slice() : [];
    merged.obsidian.excludeDirs = Array.isArray(merged.obsidian.excludeDirs) ? merged.obsidian.excludeDirs.slice() : DEFAULT_STATE.obsidian.excludeDirs.slice();
    merged.obsidian.vaultPath = String(merged.obsidian.vaultPath || DEFAULT_STATE.obsidian.vaultPath);
    merged.obsidian.outputDir = String(merged.obsidian.outputDir || DEFAULT_STATE.obsidian.outputDir);
    merged.obsidian.syncIntervalMin = normalizePositiveInt(merged.obsidian.syncIntervalMin, DEFAULT_STATE.obsidian.syncIntervalMin);
    merged.obsidian.writeBackEveryTurns = normalizePositiveInt(merged.obsidian.writeBackEveryTurns, DEFAULT_STATE.obsidian.writeBackEveryTurns);
    merged.storyLearning = Object.assign({}, DEFAULT_STATE.storyLearning, merged.storyLearning || {});
    merged.storyLearning.enabled = merged.storyLearning.enabled !== false;
    merged.storyLearning.storyPath = String(merged.storyLearning.storyPath || DEFAULT_STATE.storyLearning.storyPath);
    merged.storyLearning.autoSync = merged.storyLearning.autoSync === true;
    merged.storyLearning.maxBatchChars = normalizePositiveInt(merged.storyLearning.maxBatchChars, DEFAULT_STATE.storyLearning.maxBatchChars);
    // 羁绊系统迁移: 战斗等级语义改为"羁绊/熟悉度", 一次性清零旧战斗经验, 从 Lv.1 重新养羁绊
    if (!merged._bondMigrated) {
      merged.pet.xp = 0;
      merged.pet.level = 1;
      merged._bondMigrated = true;
    }
    // always recalculate level from XP to ensure consistency
    merged.pet.level = calcLevelFromXP(merged.pet.xp || 0);
    return merged;
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
  }
}

function save(state) {
  try {
    ensureDataDir();
    // 原子写: 先写临时文件再 rename, 避免写到一半崩溃/断电留下截断的 JSON 损坏整份配置
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, DATA_FILE);
    try { fs.chmodSync(DATA_FILE, 0o600); } catch (_) {}
  } catch (e) {
    console.error('Failed to save state:', e);
    try { fs.unlinkSync(DATA_FILE + '.tmp'); } catch (_) {}
  }
}

function addXP(state, amount) {
  state.pet.xp += amount;
  state.pet.level = calcLevelFromXP(state.pet.xp);
  return state;
}

function getXPProgress(state) {
  const level = state.pet.level;
  const maxLevel = XP_THRESHOLDS.length;
  if (level >= maxLevel) return { current: state.pet.xp, needed: XP_THRESHOLDS[maxLevel - 1], percent: 100 };
  const currentThreshold = XP_THRESHOLDS[level - 1] || 0;
  const nextThreshold = XP_THRESHOLDS[level];
  const progress = state.pet.xp - currentThreshold;
  const needed = nextThreshold - currentThreshold;
  return { current: state.pet.xp, needed: nextThreshold, percent: Math.floor((progress / needed) * 100) };
}

module.exports = { load, save, addXP, getXPProgress, XP_THRESHOLDS };
