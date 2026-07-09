# 施工蓝图 — 精简: 语音只中文 / 移除 anthropic·openai / config 调整(2026-07)

> sonnet 严格参照。行号为快照,用 grep 定位。改完 `node --check main.js store.js preload.js`、`node -e "JSON.parse(require('fs').readFileSync('voice-lines.json'))"`、pet 提取<script>段 node --check(此项目是 panel.html)。生效需重启 app。**不要 commit/push**(交 opus review + 用户验证后再定)。

## 需求1 — 语音台词只用中文, 移除英文
- **voice-lines.json**: 每个类目(alert/emo/greetings/break/taskDone 等)移除 `en` 键, 只保留 `zh`。保持 JSON 合法。`_note` 里"zh=中文 en=英文…语言开关"的说明相应改为"只用中文"。
- **main.js**:
  - `_voiceLang()`(约206): 固定返回 `'zh'`(或直接让 `_voiceArr`/`_voiceStr` 取 `VOICE[cat].zh`)。
  - 内置兜底 VOICE(约211-215): en 键可留可删(不读), 建议删保持一致。
  - 移除 `get-voice-lang` / `set-voice-lang` 两个 IPC handler(grep 'voice-lang')。`get-voice-lines`(2436)保留。
- **preload.js**: 移除 `getVoiceLang`/`setVoiceLang`(56-58)。`getVoiceLines` 保留。
- **panel.html**:
  - 移除"语音台词语言"整个 setting-section(约1214-1227: setting-section 标题 + label + `<select id="voice-lang">`)。
  - 移除 `loadVoiceLang`/`saveVoiceLang` 函数(约1858)。
  - tab 切换(约1435)移除 `loadVoiceLang()` 调用。
- **store.js**: `voiceLang` 字段(21)保留但注释改"已固定中文"(或移除;保留更稳, 老数据无碍)。

## 需求2 — 移除 anthropic 和 openai 后台(只留 qwen / deepseek)
- **main.js**:
  - 移除 `const Anthropic = require('@anthropic-ai/sdk')`(13)。
  - `PROVIDERS`(约1096-1097): 删 openai/anthropic 两项。
  - `MODEL_DISPLAY`(约1103-1104): 删 openai/anthropic 两项。
  - 删 `OPENAI_MODEL`/`ANTHROPIC_MODEL` 定义(1108-1109)。
  - 删 `callAnthropic` 整个函数(grep 'async function callAnthropic' 到其闭合)。
  - 删 `if (provider === 'anthropic') { return await callAnthropic(...) }` 分支(约1957-1958)。
  - `endpoints`(约1962-1965): 删 openai 项, 只留 qwen/deepseek。
  - **保留** `OPENAI_TOOLS`(qwen/deepseek 走 OpenAI 兼容通道仍用它)。
  - 全文 grep 确认无 anthropic/openai/OPENAI_MODEL/ANTHROPIC_MODEL/callAnthropic 残留引用(OPENAI_TOOLS 除外)。
- **store.js**:
  - `apiKeys`(15) → `{ qwen: '', deepseek: '', metaso: '' }`。
  - `VALID_PROVIDERS`(59) → `['qwen', 'deepseek']`。
  - 迁移清理(57)把 'openai','anthropic' 加进待删列表(顺手清老数据残留 key)。
- **panel.html**:
  - provider-card `data-provider="openai"`(约1253-1257) 和 `data-provider="anthropic"`(约1258-1262) 两张卡整块移除。
  - API Keys 里 openai 的 key-section(含 `id="key-openai"`/`status-openai`) 和 anthropic 的(含 `key-anthropic`/`status-anthropic`) 整块移除(约1271-1309 内)。
  - grep `selectProvider`/`renderProviderCards`/`saveKey`: 若硬编码 openai/anthropic 列表则清理; 若是遍历 DOM 卡片则自动适配(确认即可)。

## 需求3 — config tab 相应移除(即需求1、2 的 panel.html 部分)
已在上面覆盖: 语音语言选择、openai/anthropic 卡片 + key 填写。

## 需求4 — 设定文件 frame 从 config 中部移到最下部
- **panel.html**: 把 SETTINGS FILE 整个 `<div class="hud-frame">`(约1228-1237, 含"📂 打开设定文件" + "🗑 从头开始"按钮 + 说明 + `#memory-cleared-msg`)从当前位置(UNIT CONFIG frame 之后)整体剪切, 移到 **AI BACKEND frame(含 provider-grid/千问型号/API Keys/网页搜索 metaso)之后、`#pane-settings` 闭合 `</div>` 之前**——即 config tab 最下部。
  - 确认 AI BACKEND frame 的结尾(网页搜索 metaso section 1310-1316 之后 hud-frame 闭合)与 pane-settings 闭合边界, 插入位置正确。

## 验证
- `node --check main.js store.js preload.js`;`node -e "JSON.parse(require('fs').readFileSync('voice-lines.json','utf8')); console.log('json ok')"`;panel.html 提取 <script> 段(<script> 到 </script>)node --check;人工核对 <style>/<script> 与 pane-settings 的 div 配平。
- 冒烟(可选, GUI 起不了则静态自检)。
- **不 commit**。分需求汇报, 防断线丢进度。
