// memory.js — VF-1 长期用户画像记忆
// 独立于 data.json (后者已 2.6MB), 存放对驾驶员的长期理解 + 文章/对话归档.
// 画像层每次 Chat 注入 system prompt; 原始层只存不读, 供回溯/重炼.
const fs = require('fs');
const path = require('path');
const os = require('os');

const MEM_DIR      = path.join(os.homedir(), '.desktop-pet', 'memory');
const PROFILE_FILE = path.join(MEM_DIR, 'profile.json');
const ARTICLE_DIR  = path.join(MEM_DIR, 'articles');
const CHAT_DIR     = path.join(MEM_DIR, 'chat-archive');

// 画像默认结构. commStyle 是结构化的沟通偏好, toneContract 是 VF-1 与本驾驶员的"语气契约".
const DEFAULT_PROFILE = {
  facts:        [],   // 稳定事实: ["在做 VF-1 桌面宠物 Electron 项目", "用 Mac"]
  interests:    [],   // 兴趣领域: ["Macross/机战", "桌面交互设计"]
  commStyle:    { length: '', tone: '', emoji: null, dislikes: [] },
  toneContract: [],   // 与本驾驶员说话的规则: ["闲聊时去掉'驾驶员'腔, 直接说重点"]
  articleCount: 0,
  updatedAt:    ''
};

// 目录收紧到仅本人可读写 (0700), 与 store.js / ~/.macross 一致
function ensureDirs() {
  for (const d of [path.dirname(MEM_DIR), MEM_DIR, ARTICLE_DIR, CHAT_DIR]) {
    try {
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
      else fs.chmodSync(d, 0o700);
    } catch (_) {}
  }
}

function loadProfile() {
  try {
    ensureDirs();
    if (!fs.existsSync(PROFILE_FILE)) return JSON.parse(JSON.stringify(DEFAULT_PROFILE));
    const data = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8'));
    // 浅合并填补缺失字段, commStyle 再深合并一层
    const merged = Object.assign({}, JSON.parse(JSON.stringify(DEFAULT_PROFILE)), data);
    merged.commStyle = Object.assign({}, DEFAULT_PROFILE.commStyle, data.commStyle || {});
    return merged;
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_PROFILE));
  }
}

function saveProfile(profile) {
  try {
    ensureDirs();
    profile.updatedAt = new Date().toISOString().slice(0, 10);
    // 原子写: 先写临时文件再 rename, 避免写到一半崩溃留下损坏 JSON
    const tmp = PROFILE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(profile, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, PROFILE_FILE);
    try { fs.chmodSync(PROFILE_FILE, 0o600); } catch (_) {}
  } catch (e) {
    console.error('[MEMORY] saveProfile failed:', e.message);
    try { fs.unlinkSync(PROFILE_FILE + '.tmp'); } catch (_) {}
  }
}

// 把驾驶员投喂的文章原文归档, 供日后回溯/重炼. 文件名做安全化处理.
function archiveArticle(title, text) {
  try {
    ensureDirs();
    const safe = String(title || 'article').replace(/[^\w一-龥-]+/g, '_').slice(0, 40) || 'article';
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const file = path.join(ARTICLE_DIR, `${stamp}-${safe}.txt`);
    fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
    return file;
  } catch (e) {
    console.error('[MEMORY] archiveArticle failed:', e.message);
    return null;
  }
}

// 追加一轮完整对话到当月 jsonl (不再像 chatHistory 那样砍 40 条). 原始层, 只存不读.
function appendChatArchive(userMsg, reply) {
  try {
    ensureDirs();
    const month = new Date().toISOString().slice(0, 7);   // 2026-06
    const file = path.join(CHAT_DIR, `chat-${month}.jsonl`);
    const line = JSON.stringify({ t: new Date().toISOString(), user: userMsg, reply }) + '\n';
    fs.appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 });
  } catch (e) {
    console.error('[MEMORY] appendChatArchive failed:', e.message);
  }
}

// 清空画像 (记忆面板"一键清空"用). 归档原文不动, 只重置画像.
function clearProfile() {
  saveProfile(JSON.parse(JSON.stringify(DEFAULT_PROFILE)));
}

module.exports = { loadProfile, saveProfile, archiveArticle, appendChatArchive, clearProfile, DEFAULT_PROFILE, MEM_DIR };
