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
  apiKeys: { qwen: '', deepseek: '', openai: '', anthropic: '', metaso: '' },
  petPosition: { x: 100, y: 100 },
  workflows: [],
  alertSoundEnabled: true,
  breakReminder: { enabled: true, intervalMin: 60 },
  edgePatrol:    { enabled: true },
  voiceLang:     'zh',           // 语音台词语言: 'zh' 中文 / 'en' 英文
  persona:       '',             // 自定义性格人设(空=默认军事腔骷髅一号); 非空时聊天里完全接管语气/自称/称呼
  sessionRules:  ''              // 本场规则(空=无); 非空时钉在 system prompt 顶部, 每轮强制遵守, 永不被对话长度挤掉
};

function calcLevelFromXP(xp) {
  let level = 1;
  for (let i = 1; i < XP_THRESHOLDS.length; i++) {
    if (xp >= XP_THRESHOLDS[i]) level = i + 1;
    else break;
  }
  return level;
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
    // provider 集合迁移: 下线 doubao/ollama, 改用 openai/anthropic
    // 清理已下线后台的残留 key 字段 (claude 为更早的旧命名)
    ['doubao', 'ollama', 'claude'].forEach(k => { if (merged.apiKeys[k] !== undefined) delete merged.apiKeys[k]; });
    // 选中的后台若已不在有效集合内, 回退到 qwen
    const VALID_PROVIDERS = ['qwen', 'deepseek', 'openai', 'anthropic'];
    if (!VALID_PROVIDERS.includes(merged.aiProvider)) merged.aiProvider = 'qwen';
    // deep merge pet to fill any missing fields
    merged.pet = Object.assign({}, DEFAULT_STATE.pet, merged.pet);
    // deep merge breakReminder for older data files that don't have this field
    merged.breakReminder = Object.assign({}, DEFAULT_STATE.breakReminder, merged.breakReminder || {});
    merged.edgePatrol    = Object.assign({}, DEFAULT_STATE.edgePatrol,    merged.edgePatrol    || {});
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
