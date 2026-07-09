# 施工蓝图 — 配置整合 + 界面精简(2026-07)

> 本文件是 sonnet 的**严格施工参照**。行号为撰写时快照,仅供定位;实际以 `grep` 搜索函数/字符串为准。
> 每完成一个需求,`node -c` 无法校验 html,但可 `node --check main.js`、`node --check memory.js`、`node --check store.js`、`node --check preload.js` 确认无语法错误。
> 涉及文件:`panel.html` `main.js` `memory.js` `store.js` `preload.js`。三需求都动 `panel.html`,**必须串行**,不可并行编辑同一文件。

---

## 需求1 — 删除 Chat 的 QUICK ORDERS 侧栏 + 分析电脑功能

### 1.1 panel.html
- 删除整个 `#chat-side` 块:`<div id="chat-side" class="hud-frame">` ... `</div>`(快照 1583-1604),含 QUICK ORDERS pill、快捷指令、AI 助手、体育、系统状态、AI 智能建议、`#suggestion-list`。
- 删除 `getSuggestions()` 函数(`grep -n "function getSuggestions" panel.html`),以及任何只被它用到的辅助(如渲染建议项、`suggestion-file-btn` 点击处理)。若某辅助也被别处用,保留。
- 删除仅服务建议/侧栏的 CSS:`.suggestion-item` `.suggestion-num` `.suggestion-text` `.suggestion-arrow` `.suggestions-loading` `.suggestion-file-btn` `#suggestion-list`(快照 380-446、1129-1221 一带)。`.file-item` 若 WORKFLOW 仍用则保留其共用部分。
- 布局:`#chat-main` 改为占满 Chat 面板。原本 `#pane-chat` 是 `chat-main` + `chat-side` 并排;删 side 后让 `chat-main` 撑满宽度。检查 `#pane-chat` / `#chat-main` / `#chat-side` 相关 CSS(flex 布局),移除对 side 的宽度分配,`chat-main` 用 `flex:1` / 占满。

### 1.2 preload.js
- 删除 `getAiSuggestions: () => ipcRenderer.invoke('get-ai-suggestions'),`(第 25 行)。

### 1.3 main.js
- 删除 `ipcMain.handle('get-ai-suggestions', async () => { ... })` 整段(快照 2609 起,到该 handler 结束的 `});`,约百行,含大段建议 prompt)。确认删干净、括号配平。

### 1.4 验证
- `node --check main.js`、启动 app,Chat 面板无右侧栏、输入区正常、无控制台报错。

---

## 需求2 — 记忆 / 性格 / 本场规则 合并为单一易读文本文件(重构)

### 2.0 目标与架构决策
- **唯一真相源**:`~/.desktop-pet/persona-memory.md`,三个固定 H1 区块。性格、规则手写;记忆由 AI 自动提炼写入**且用户可手改**。
- **记忆存储从结构化 JSON 改为自由文本**。这是本次重构核心。原 `facts[]/interests[]/commStyle{}/toneContract[]` 分层结构废弃,记忆变成一段人类可读文本。
- **行为变化(需在 PR/汇报里说明)**:记忆不再按羁绊等级分层解锁注入(Lv1 facts / Lv3 兴趣 / Lv6 语气契约的机制取消),改为整段注入。羁绊等级/XP 系统**保留**(称谓、XP 条、提炼加分照旧)。
- 旧 `profile.json`、`data.json` 里的 `persona`/`sessionRules` 作为**迁移源**,迁移后 md 为准;旧文件不删(安全兜底)。

### 2.1 文件格式(persona-memory.md)
```markdown
# 性格 PERSONA

<用户手写性格人设。留空 = 默认军事简报腔。>

# 本场规则 RULES

<用户手写本场硬性规则。留空 = 无规则。>

# 记忆 MEMORY

<骷髅一号对驾驶员的长期了解。AI 会在会话结束时自动更新此段,你也可随时手动增删改。留空 = 尚无记忆。>
```
- 解析规则:按行扫描,遇到 `# 性格`/`# PERSONA`、`# 本场规则`/`# RULES`、`# 记忆`/`# MEMORY`(容错:匹配标题行包含 PERSONA/RULES/MEMORY 关键字即可)切段,区块内容 = 该标题到下一标题之间去除首尾空行的文本。
- 组装:三段固定顺序,标题固定,段间空行。

### 2.2 memory.js — 重写为读写 md 三区块
保留文件的原子写(tmp+rename)、0700/0600 权限、`MEM_DIR`、articles/chat-archive 归档(**不动**,仍用于文章原文与对话归档)。改动:
- 新增 `CONFIG_FILE = path.join(MEM_DIR 的父目录 ~/.desktop-pet, 'persona-memory.md')`。注意:放 `~/.desktop-pet/` 根,不是 memory 子目录,便于用户找。
- 新增:
  - `loadConfig()` → `{ persona, rules, memory }`(三段字符串,文件不存在返回三空串)。
  - `saveConfig({persona, rules, memory})` → 组装 md 原子写。**部分更新**:提供便捷 `setSection(name, text)` 或在调用处先 load 再改一段再 save。
  - `getMemoryText()` / `setMemoryText(text)`、`getPersona()`/`setPersona()`、`getRules()`/`setRules()` 薄封装(各自 load→改一段→save)。
- 保留 `archiveArticle`、`appendChatArchive` 原样。
- `clearProfile()` → 改为把 memory 段置空(`setMemoryText('')`)。
- 删除 `DEFAULT_PROFILE`、`loadProfile`、`saveProfile` 的结构化语义;若怕引用残留,可保留 `loadProfile()` 返回 `{ memory: getMemoryText() }` 的兼容壳,但**优先改所有调用点**用新 API,能删则删。
- **一次性迁移** `migrateIfNeeded(oldPersona, oldRules)`:若 `persona-memory.md` 不存在:
  - 读旧 `profile.json`(若存在),把 `facts/interests/commStyle/toneContract` 拼成可读文本作为初始 memory 段(例:`已知事实:\n- ...\n\n兴趣:\n- ...`)。
  - persona 段 = 传入的旧 `state.persona`;rules 段 = 旧 `state.sessionRules`。
  - 写出 md。旧 profile.json 保留不删。
- `module.exports` 增补新函数。

### 2.3 main.js — 改造所有记忆/性格/规则接入点
逐一处理(用 grep 定位):

1. **persona / sessionRules 来源**(chat 主路径,快照 2329-2332):
   - 现:`callOpts.persona = state.persona`、`callOpts.sessionRules = state.sessionRules`、`profileInject = buildProfileInject(memory.loadProfile(), level, ...)`。
   - 改:`const cfg = memory.loadConfig();` → `callOpts.persona = cfg.persona; callOpts.sessionRules = cfg.rules; callOpts.profileInject = buildProfileInject(cfg.memory, !!cfg.persona);`

2. **`buildProfileInject`**(快照 2062):重写签名 `buildProfileInject(memoryText, personaActive)`:
   - `memoryText` 为空 → 返回起步提示 `'【记忆提示】你正在逐渐了解这位驾驶员, 多观察其偏好, 少做假设。'`(或空串,二选一,建议保留起步提示)。
   - 非空 → 返回 header(`【长期记忆 — 你对这位驾驶员的了解】`+"跨会话持久保存,被问到记忆时如实承认"那段)+ memoryText + footer(personaActive 分支保留原有两种措辞)。
   - 删除所有 facts/interests/commStyle/toneContract/bondLevel 分层逻辑。

3. **`refineProfile`**(快照 2107):改为输出**记忆文本**:
   - refineSystem 改为:"你是用户画像提炼器。输入:现有记忆文本 + 最近对话。输出:更新后的**完整记忆文本**(纯文本,可用简单短句/分行),不要 JSON、不要 markdown 代码块。铁律:保留现有记忆里仍成立的内容(**尤其用户手写的部分,不得删改**),只增量补充新发现的稳定事实/兴趣/沟通偏好/被明确纠正的语气规则;同类去重;宁缺毋滥;不臆测隐私;总量精简(建议不超过 ~600 字)。"
   - userPrompt:`现有记忆:\n${oldMemoryText||'(空)'}\n\n最近对话:\n${convo}\n\n请输出更新后的完整记忆文本。`
   - 返回:清理后的纯文本(去掉可能的 ``` 包裹),`return String(raw||'').trim()`。失败返回 `null`。

4. **`commitRefinedProfile`**(快照 2149):改为 `commitRefinedMemory(newText)`:
   - `const old = memory.getMemoryText(); if(!newText || newText===old) return false; memory.setMemoryText(newText); return true;`

5. **`runRefine`**(快照 2167):`oldProfile = memory.getMemoryText()`;`refined = await refineProfile(..., oldMemoryText, turns, ...)`;`changed = commitRefinedMemory(refined)`;changed 时 addXP(15) 照旧。

6. **`refineFromArticle`**(快照 2196)+ **`ingestArticle`**(快照 2233):同样改为输入/输出记忆文本。refineSystem 强调"只从驾驶员读了此文推断其**关注/兴趣**,追加进记忆文本;不把文章观点当事实;保留旧记忆"。ingest 里 `oldProfile`→`memory.getMemoryText()`,commit 用 `commitRefinedMemory`,articleCount 加分逻辑(+25)保留(articleCount 可不再持久化,直接每次 +25 XP)。

7. **IPC 改造**:
   - `get-memory-profile`(1024):改为返回 `{ memory: memory.getMemoryText(), level, xp }`(前端已不展示画像面板,此 IPC 可保留供调试或删除;若前端不再调用则删,并从 preload 删 `getMemoryProfile`)。
   - `update-memory-profile`(1029):前端不再用(改为打开文件),**删除**该 handler + preload 的 `updateMemoryProfile`。
   - `get-persona`/`set-persona`(2948/2952):改为 `memory.getPersona()` / `memory.setPersona(text)`。**保留** IPC(可能别处用),但内部走 md。
   - `get-session-rules`/`set-session-rules`(2966/2970):同理走 `memory.getRules()`/`setRules()`。
   - `clear-memory`(1049):`memory.clearProfile()`(=清 memory 段)。
   - `reset-conversation`(1056):`state.chatHistory=[]; _turnsSinceRefine=[]; memory.setRules(''); memory.clearProfile(); xp/level 归零`。注意:原来清 `state.sessionRules`,现改为清 md 的 rules 段。persona 段**保留不清**(与原逻辑"保留 persona"一致)。
   - 新增 `ipcMain.handle('open-config-file', () => { shell.openPath(memory.CONFIG_FILE 路径); return {ok:true}; })`。确认 `shell` 已 require(main.js 顶部 `const { ..., shell } = require('electron')`;若无则加)。

8. **`/规则` 快捷指令**(快照 2293-2305):`state.sessionRules` 相关改为读写 `memory.getRules()`/`setRules()`。清除→`setRules('')`;设定→`setRules(arg.slice(0,2000))`;回显用 `memory.getRules()`。

9. **启动迁移**:在 app ready / state 载入后,调用 `memory.migrateIfNeeded(state.persona||'', state.sessionRules||'')`(找 `app.whenReady` 或 state load 之后的初始化处)。

### 2.4 store.js
- `DEFAULT_STATE` 的 `persona` / `sessionRules` 字段**保留**(迁移源 + 向后兼容),不再作为主读写入口。可加注释:"// 已迁移至 ~/.desktop-pet/persona-memory.md,保留仅供旧数据迁移"。

### 2.5 panel.html — CONFIG 界面
- 删除三块 frame:MEMORY(快照 1731-1743 `#memory-frame`)、PERSONA(1746-1757 `#persona-frame`)、RULES(1760-1770 `#rules-frame` 一带,含 `#rules-input`、保存规则按钮)。
- 删除相关 JS:`renderMemoryPanel`(2170)、`toggleMemoryCollapse`、`togglePersonaCollapse`、`toggleRulesCollapse`、`loadPersona`/`savePersona`(2244/2256)、`loadSessionRules`/`saveSessionRules`(2275/2286)、`clearMemoryConfirm`(2359)、`_memProfile` 编辑相关(2337/2347/2354 等 `updateMemoryProfile` 调用)。
- 删除这三块的专用 CSS(`.memory-bond` `.persona-input` `.mem-collapse` `.mem-collapsed` `.mem-caret` 等,快照 602-624)。
- tab 切换(快照 2000):从 `if (tab.dataset.tab === 'settings') {...}` 里移除 `renderMemoryPanel(); loadPersona(); loadSessionRules();`,其余(loadBreakReminder 等)保留。
- **新增**"📂 打开设定文件"入口:在 CONFIG 里合适位置(建议原三块位置)放一个说明 + 按钮:
  ```html
  <div class="hud-frame">
    <div class="hud-pill">SETTINGS FILE · 设定文件</div>
    <div class="setting-note">性格、本场规则、长期记忆现在统一存于一个文本文件。点下方按钮直接打开编辑,改完保存即生效(记忆段骷髅一号也会自动更新)。</div>
    <button class="save-btn" onclick="openConfigFile()">📂 打开设定文件</button>
  </div>
  ```
  JS:`async function openConfigFile(){ await window.petAPI.openConfigFile(); }`
- **"从头开始"按钮保留**(它清对话+记忆+规则+羁绊归零,是"重置关系"而非文件编辑):从原 MEMORY frame 里抽出,单独放在 CONFIG 底部一个小块,仍调 `resetConversation()`。文案沿用原有。

### 2.6 preload.js
- 新增 `openConfigFile: () => ipcRenderer.invoke('open-config-file'),`。
- 删除 `updateMemoryProfile`(前端不再用);`getMemoryProfile`/`clearMemory` 若前端不再调用则删(reset 走 `resetConversation`)。`getPersona/setPersona/getSessionRules/setSessionRules` 若前端不再调用可删(内部 IPC 保留即可)。以最终前端实际调用为准,不留悬空导出。

### 2.7 验证
- `node --check main.js memory.js store.js preload.js`。
- 启动:首启触发迁移生成 md;CONFIG 无三块 UI、有"打开设定文件"按钮;点击能用默认编辑器打开 md。
- 聊天注入:persona/rules/memory 三段仍进 system prompt(可临时 console.log systemPrompt 验证)。
- 手改 md 记忆段 → 重启 → 聊天里骷髅一号"记得";再多聊几轮触发 runRefine → md 记忆段被增量更新且**未删除手写内容**。

---

## 需求3 — 删除 YES BOT tab(保留提示功能)

### 3.1 保留(严禁动)
- `main.js` 全部告警检测与 IPC(termAlert/taskDoneAvailable/ocAlert 的产生与广播)。
- `pet.html` 桌宠端所有告警反馈(眼睛变色、锁定动画、飞弹、气泡、说话、单击跳转)。
- 提示功能完全由上述两者承担,与本 tab 无关。

### 3.2 panel.html — 删除
- tab 标签:`<div class="tab" data-tab="terminal">YES BOT...</div>`(快照 1566)。
- 面板:`<div class="tab-pane" id="pane-terminal">` ... `</div>`(快照 1627-1646)。
- 仅服务该 pane 展示的 JS(确认无其他引用后删):`_renderCcCard`(3062)、`_renderCcDoneCard`(3114)、`_renderOcCard`(3142)、`termPoll`(3293)、`termPollNow`、`termToggleDiag`、`termToggleAlertSound`、`setInterval(termPoll,2500)`(3581)、TERM_PROMPT_PATTERNS/detectTermPrompt/stripAnsi 等扫屏死代码(3193-3290,`TERM_SCAN_DISABLED` 已 true,均未生效)。
  - **保留** `_updateTermBadge`?badge DOM 随 tab 删除而消失,`_updateTermBadge` 里 `if(!badge||!dot) return;` 已容错,可保留空转或删除;`_termIpcAlert`/`_ccDoneIpcAlert`/`_ocIpcAlert` 若仅更新 badge+卡片(都在已删 pane 内),现在无展示对象——可保留(容错返回)或删除。**关键:确保 `init()` 里 `onPetUpdate` 回调不因删除函数而报错**。若删除这些函数,需同时移除 `onPetUpdate` 里对它们的调用(1959-1963);但这些回调是"面板侧展示",删掉不影响桌宠提示。安全做法:保留 `_termIpcAlert` 等为**空函数或带 DOM 容错**,避免连锁报错。
- `term-*` 专用 CSS(`.term-header` `.term-status-dot` `.cc-status-card` `.oc-status-card` `.term-session-card` `.term-idle-msg` 等)可删。

### 3.3 applyLite 安全降级(快照 1924-1938)
- 现在 lite 隐藏 chat/files 后 `切到 terminal tab`。terminal tab 已删 → 改为切到 `settings`(CONFIG):`const def = document.querySelector('.tab[data-tab="settings"]');`
- 加注释说明 lite 版原主功能(YES BOT)已随 tab 移除,如不再分发 lite 版可后续整块清理 LITE/applyLite/get-lite。

### 3.4 验证
- 启动:无 YES BOT tab;CHAT/WORKFLOW/CONFIG 三 tab 正常切换。
- 触发一次 Claude Code 权限等待(或 OpenCode 完成):**桌宠身上**出现金色/气泡/说话提示、单击桌宠跳转到终端——功能正常。
- 控制台无 `_renderCcCard is not defined` 之类报错。

---

## 执行顺序与提交
1. 需求1(纯删除,低风险)→ 自测启动。
2. 需求3(纯删除,注意 onPetUpdate 回调不报错)→ 自测启动 + 告警。
3. 需求2(重构,高风险)→ 分步:memory.js → main.js → 迁移 → panel.html/preload → 自测往返。
- 每个需求完成 `node --check` + 启动冒烟,再进下一个。
- 三需求可分别 commit,信息中文。**不要**自行 push。
