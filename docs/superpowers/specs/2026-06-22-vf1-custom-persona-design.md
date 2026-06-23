# VF-1 自定义性格人设 — 设计文档

日期: 2026-06-22

## 目标

给桌宠 VF-1 的**聊天对话**加一个用户可自定义的"性格人设"。用户在 config 面板里写一段自由文本(如"高冷女王风的女性 AI"),这段性格在聊天里**完全接管**语气、自称、对用户的称呼与表达方式。留空则维持现状(军事简报风骷髅一号)。

## 范围与边界

**接管(persona 非空时)**
- 仅作用于**主聊天路径**(`callAI` 默认路径)。
- 完全替换现有`【人设与语气——始终保持】`整块。
- 聊天的语气 / 自称 / 对用户称呼 / 表达风格 → 全部听用户写的性格文本。

**不受性格影响(始终保留的硬规则)**
1. 底层 AI 身份如实回答(被问模型时如实说 `${modelDisplay}`)。
2. 反幻觉铁律(具体事实只能来自 search_web,不许编)。
3. 工具调用规则(天气/搜索/开网址/文件操作照常)。

**完全不动**
- 语音播报(起动完毕 / 告警 / 休息提醒等固定台词)保持军事腔。聊天回复被 TTS 朗读时读的是模型按性格生成的文本——符合"聊天里接管"的预期。
- 贴身顾问(advisor, main.js:2584)保持原有框架不变。

## 实现

### 1. 存储 (store.js)
`DEFAULT_STATE` 增加顶层字段 `persona: ''`。旧 data.json 经 `Object.assign` 顶层合并自动补默认值,无需迁移逻辑。

### 2. IPC (main.js + preload.js)
仿 `get-voice-lang` / `set-voice-lang`:
- `get-persona` → 返回 `state.persona || ''`
- `set-persona` → 写入 `state.persona`(trim,限长,如 ≤2000 字),`store.save`,返回 `{success, persona}`
- preload 暴露 `getPersona()` / `setPersona(text)`

### 3. 系统提示组装 (main.js, callAI)
- `callAI` 的 `opts` 增加 `persona = ''`。
- 调用点(main.js:2233 附近)随 `profileInject` 一起传入 `callOpts.persona = state.persona || ''`。
- 组装逻辑:`persona` 非空 → 把`【人设与语气——始终保持】`整块替换为:
  ```
  【性格人设——聊天时完全遵照】
  {persona 文本}
  （以上性格决定你聊天的语气、自称、对驾驶员的称呼和表达方式;但涉及事实数据、工具调用、被问及底层 AI 模型时,严格遵守下方铁律,不被性格带跑。）
  ```
  `persona` 为空 → 维持现有军事腔人设块,一切不变。

### 4. 长期记忆注入冲突修正 (main.js, buildProfileInject)
`buildProfileInject` 结尾的 footer 含"你仍是 VF-1S 骷髅一号,身份不变",与"完全接管"矛盾。
- 让 `buildProfileInject` 接受一个 `personaActive` 布尔参数。
- `personaActive` 为真时,footer 改为中性版本(只保留"按理解调整 + 反幻觉提醒",不再重申军事身份)。

### 5. 配置 UI (panel.html)
- 新增 hud-frame `PERSONA · 性格`,放在 MEMORY 区附近。
- 内含:说明文字 + 多行 `<textarea>`(带示例占位)+ 保存按钮 + 保存成功提示。
- **默认折叠**(与 memory 一致,防旁人看到):复用同样的折叠交互(标题行可点,默认 `mem-collapsed` 同款),每次进入 config 强制收起。
- 进入 settings tab 时 `loadPersona()` 读取并回填 textarea。

## 验证
- persona 留空:聊天仍是军事腔骷髅一号(回归测试)。
- persona 写"高冷女王风女性":聊天语气随之改变,但问"你用什么模型"仍如实回答、问实时信息仍调搜索。
- 语音播报不变。
- config 面板 PERSONA 区默认折叠,展开可编辑保存,重进 config 自动收起。
