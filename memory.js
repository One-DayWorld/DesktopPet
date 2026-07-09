// memory.js — VF-1 设定与记忆
// 性格(persona)、本场规则(rules)、长期记忆(memory)三合一, 存于单一易读文本文件
// ~/.desktop-pet/persona-memory.md, 用户可直接打开编辑。记忆段由 AI 会话结束时自动提炼更新,
// 用户也可手改(提炼时会保留用户手写内容, 只增量补充)。
// 原始层(文章原文 articles/ + 对话归档 chat-archive/)只存不读, 供回溯/重炼。
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT_DIR     = path.join(os.homedir(), '.desktop-pet');
const MEM_DIR      = path.join(ROOT_DIR, 'memory');
const PROFILE_FILE = path.join(MEM_DIR, 'profile.json');   // 旧结构化画像, 仅作一次性迁移源, 不再读写
const ARTICLE_DIR  = path.join(MEM_DIR, 'articles');
const CHAT_DIR     = path.join(MEM_DIR, 'chat-archive');
const CONFIG_FILE  = path.join(ROOT_DIR, 'persona-memory.md');   // 三合一设定文件(唯一真相源)

// 三个固定区块标题
const H_PERSONA = '# 性格 PERSONA';
const H_RULES   = '# 本场规则 RULES';
const H_MEMORY  = '# 记忆 MEMORY';

const FILE_HEADER =
`<!-- 骷髅一号设定文件 · 三合一(性格 / 本场规则 / 长期记忆)
     直接编辑本文件并保存即可生效, 无需在 CONFIG 面板里改。
     · 性格: 留空 = 默认军事简报腔
     · 本场规则: 留空 = 无规则; 也可在聊天框输入「/规则 …」快速设定
     · 记忆: 骷髅一号会在会话结束时自动补充, 你也可以随时手动增删改
     三个「# 标题」行请勿改动或删除, 否则无法正确解析。 -->
`;

// 目录收紧到仅本人可读写 (0700)
function ensureDirs() {
  for (const d of [ROOT_DIR, MEM_DIR, ARTICLE_DIR, CHAT_DIR]) {
    try {
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
      else fs.chmodSync(d, 0o700);
    } catch (_) {}
  }
}

// ── 三合一设定文件: 解析 / 组装 / 读写 ───────────────────────────────
// 解析: 按行扫描, 依「# 标题」含关键字切段; 标题前的内容(引导注释)忽略。
function parseConfig(text) {
  const out = { persona: '', rules: '', memory: '' };
  if (!text) return out;
  const lines = text.split('\n');
  let cur = null;                    // 'persona' | 'rules' | 'memory' | null
  const buf = { persona: [], rules: [], memory: [] };
  for (const line of lines) {
    if (/^#\s/.test(line)) {
      if (/persona|性格/i.test(line))      cur = 'persona';
      else if (/rules|规则/i.test(line))   cur = 'rules';
      else if (/memory|记忆/i.test(line))  cur = 'memory';
      else cur = null;               // 未知标题: 忽略其内容
      continue;
    }
    if (cur) buf[cur].push(line);
  }
  out.persona = buf.persona.join('\n').trim();
  out.rules   = buf.rules.join('\n').trim();
  out.memory  = buf.memory.join('\n').trim();
  return out;
}

// 组装: 固定顺序 + 引导注释, 段间留空行, 便于人类阅读编辑。
function buildConfig({ persona = '', rules = '', memory = '' } = {}) {
  return `${FILE_HEADER}
${H_PERSONA}

${(persona || '').trim()}

${H_RULES}

${(rules || '').trim()}

${H_MEMORY}

${(memory || '').trim()}
`;
}

function loadConfig() {
  try {
    ensureDirs();
    if (!fs.existsSync(CONFIG_FILE)) return { persona: '', rules: '', memory: '' };
    return parseConfig(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return { persona: '', rules: '', memory: '' };
  }
}

function saveConfig(cfg) {
  try {
    ensureDirs();
    // 原子写: 先写临时文件再 rename, 避免写到一半崩溃留下损坏文件
    const tmp = CONFIG_FILE + '.tmp';
    fs.writeFileSync(tmp, buildConfig(cfg), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, CONFIG_FILE);
    try { fs.chmodSync(CONFIG_FILE, 0o600); } catch (_) {}
  } catch (e) {
    console.error('[MEMORY] saveConfig failed:', e.message);
    try { fs.unlinkSync(CONFIG_FILE + '.tmp'); } catch (_) {}
  }
}

// 单段读写便捷封装 (load → 改一段 → save)
function getPersona()      { return loadConfig().persona; }
function getRules()        { return loadConfig().rules; }
function getMemoryText()   { return loadConfig().memory; }
function setPersona(text)  { const c = loadConfig(); c.persona = String(text || '').trim(); saveConfig(c); }
function setRules(text)    { const c = loadConfig(); c.rules   = String(text || '').trim(); saveConfig(c); }
function setMemoryText(t)  { const c = loadConfig(); c.memory  = String(t || '').trim();    saveConfig(c); }

// 清空记忆 ("从头开始"用): 只清记忆段, 性格/规则/归档原文不动。
function clearProfile() { setMemoryText(''); }

// ── 一次性迁移: 旧 profile.json + data.json 的 persona/sessionRules → 新 md ──
// 把旧结构化画像拼成可读文本作为初始记忆段。旧 profile.json 保留不删(安全兜底)。
function readOldProfileText() {
  try {
    if (!fs.existsSync(PROFILE_FILE)) return '';
    const p = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8')) || {};
    const blocks = [];
    if (Array.isArray(p.facts) && p.facts.length)
      blocks.push('已知事实:\n' + p.facts.map(f => '- ' + f).join('\n'));
    if (Array.isArray(p.interests) && p.interests.length)
      blocks.push('兴趣领域:\n' + p.interests.map(f => '- ' + f).join('\n'));
    const cs = p.commStyle || {};
    const sb = [];
    if (cs.length) sb.push('详略: ' + cs.length);
    if (cs.tone)   sb.push('语气: ' + cs.tone);
    if (cs.emoji === true)  sb.push('可适度用 emoji');
    if (cs.emoji === false) sb.push('不用 emoji');
    if (Array.isArray(cs.dislikes) && cs.dislikes.length) sb.push('反感: ' + cs.dislikes.join('、'));
    if (sb.length) blocks.push('沟通偏好: ' + sb.join(' / '));
    if (Array.isArray(p.toneContract) && p.toneContract.length)
      blocks.push('语气契约:\n' + p.toneContract.map(f => '- ' + f).join('\n'));
    return blocks.join('\n\n');
  } catch {
    return '';
  }
}

// 若新 md 尚不存在, 用旧数据初始化一次。oldPersona/oldRules 来自 data.json。
function migrateIfNeeded(oldPersona = '', oldRules = '') {
  try {
    ensureDirs();
    if (fs.existsSync(CONFIG_FILE)) return false;
    saveConfig({
      persona: String(oldPersona || '').trim(),
      rules:   String(oldRules || '').trim(),
      memory:  readOldProfileText()
    });
    console.log('[MEMORY] migrated persona/rules/profile → persona-memory.md');
    return true;
  } catch (e) {
    console.warn('[MEMORY] migrateIfNeeded failed:', e.message);
    return false;
  }
}

// ── 原始归档层 (不变) ──────────────────────────────────────────────
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

// 追加一轮完整对话到当月 jsonl. 原始层, 只存不读.
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

module.exports = {
  parseConfig, buildConfig,
  loadConfig, saveConfig,
  getPersona, setPersona, getRules, setRules, getMemoryText, setMemoryText,
  clearProfile, migrateIfNeeded,
  archiveArticle, appendChatArchive,
  CONFIG_FILE, MEM_DIR
};
