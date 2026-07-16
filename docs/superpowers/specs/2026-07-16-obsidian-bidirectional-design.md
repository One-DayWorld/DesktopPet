# VF-1 与 Obsidian 双向关联设计

日期: 2026-07-16

## 目标

让 VF-1 桌宠与用户的 Obsidian 知识库形成本地双向关联:

- Obsidian -> VF-1: 桌宠读取指定知识库中的 Markdown 笔记, 用于更完整地理解用户的人物画像、长期项目、兴趣和沟通偏好。
- VF-1 -> Obsidian: 桌宠把聊天中沉淀出的可复用知识、想法、项目线索和画像摘要自动写回 Obsidian, 让知识库更完整。

第一版采用本地 Vault 文件夹直连, 但代码按 adapter 边界设计, 后续可以增加 Local REST API adapter, 不重写画像、写回和 UI 主流程。

## 范围

### 第一版读取范围

默认 Obsidian 可读根目录:

```text
/Users/ace/Documents/OneDayWorld
```

桌宠递归读取该目录及全部子目录下的 `.md` 文件。

第一版不读取:

- `.obsidian/`
- 非 Markdown 附件, 如图片、PDF、音频、视频、Office 文件
- 隐藏目录和隐藏文件
- 桌宠自己的写回目录, 避免把自己刚写出的摘要再次读入造成循环污染

### 第一版写回范围

桌宠只写入可读根目录下的固定输出目录:

```text
/Users/ace/Documents/OneDayWorld/Macross/
```

第一版不修改用户已有原笔记, 不删除 Obsidian 文件, 不重命名文件。

## 方案选择

采用方案 A: 本地 Vault 直连 + 可替换 adapter。

理由:

- 可以最快可用, 不要求 Obsidian 必须打开。
- 全部数据仍在本机文件系统内。
- 通过 `ObsidianAdapter` 接口隔离读写实现, 后续新增 Local REST API 只需要实现同一组方法。

暂不采用 Local REST API 作为第一版, 因为它需要额外插件、token 和运行中的 Obsidian 实例。暂不采用纯手动导入导出, 因为它不满足自动补画像和自动补知识库的目标。

## 用户配置

在 `store.js` 的 `DEFAULT_STATE` 增加 `obsidian` 配置:

```js
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
}
```

CONFIG 面板增加 `OBSIDIAN` 区:

- 启用 / 关闭 Obsidian 关联
- Vault 路径输入框, 默认 `/Users/ace/Documents/OneDayWorld`
- 输出目录输入框, 默认 `Macross`
- 自动同步开关
- 自动写回开关
- 立即同步按钮
- 最近同步状态: 成功、失败、扫描文件数、变更文件数、最后同步时间

## 架构

新增模块:

- `obsidian/index.js`: 对主进程暴露 Obsidian 服务。
- `obsidian/local-vault-adapter.js`: 第一版本地文件 adapter。
- `obsidian/markdown.js`: Markdown/frontmatter/tag 提取、正文清洗、链接基础处理。
- `obsidian/sync-state.js`: 维护每个文件的 `mtimeMs`、size、hash 和最后同步时间。
- `obsidian/prompts.js`: Obsidian 画像提炼和知识写回提示词。

核心接口:

```js
class ObsidianAdapter {
  async listNotes(options) {}
  async readNote(noteRef) {}
  async writeNote(noteRef, content) {}
  async appendToNote(noteRef, content) {}
  async getChangedNotes(previousState) {}
}
```

后续 Local REST API 版本新增 `obsidian/local-rest-api-adapter.js`, 实现同一接口。`main.js`、记忆提炼、写回调度和 UI 不直接依赖文件系统细节。

## Obsidian -> VF-1 画像流

同步触发:

- 启用后首次同步。
- CONFIG 中点击立即同步。
- 应用运行期间按 `syncIntervalMin` 周期同步。
- 后续可选: 使用文件监听触发, 但第一版以周期扫描为主, 稳定优先。

同步流程:

1. 扫描 `/Users/ace/Documents/OneDayWorld` 下全部 `.md`。
2. 排除 `.obsidian/`、隐藏路径和 `Macross/`。
3. 对比 `mtimeMs`、size 和 hash, 只读取新增或变更笔记。
4. 清洗 Markdown, 提取标题、frontmatter、tags、正文摘要。
5. 将变更笔记分批传给 LLM 提炼。
6. 将提炼结果合并进 `persona-memory.md` 的 `# 记忆 MEMORY` 段。

提炼约束:

- 笔记内容不等于用户观点。
- 可以记录用户长期关注、正在推进的项目、反复整理的主题、明确写下的个人偏好。
- 不把一次性材料、引用内容、外部文章观点当成用户事实。
- 保留 `persona-memory.md` 中已有记忆, 尤其是用户手写内容。
- 总量控制, 避免把知识库全文塞进聊天 system prompt。

## VF-1 -> Obsidian 写回流

自动写回启用后, 桌宠将聊天中值得沉淀的内容写回 `Macross/`。

文件结构:

```text
Macross/
  Profile.md
  Inbox.md
  Chat Highlights/
    2026-07.md
```

### `Profile.md`

用途: 保存桌宠当前理解到的人物画像摘要。

内容包括:

- 稳定事实
- 长期项目
- 兴趣领域
- 沟通偏好
- 需要避免的误解
- 最近更新时间

来源是 `persona-memory.md` 的记忆段, 由桌宠生成一个更适合 Obsidian 阅读的版本。

### `Inbox.md`

用途: 存放聊天中值得回收、但尚未归类的知识点和想法。

条目格式:

```md
- 2026-07-16 21:30 [[来源: VF-1 Chat]] 内容摘要
```

只写入稳定、可复用、有知识价值的内容, 不把普通寒暄、情绪陪伴、一次性工具调用结果写入。

### `Chat Highlights/YYYY-MM.md`

用途: 按月归档高价值对话摘要。

每次自动整理追加一小节:

```md
## 2026-07-16

- 主题: ...
- 可复用结论: ...
- 后续行动: ...
```

## 自动写回策略

触发条件:

- 每 `writeBackEveryTurns` 轮聊天后后台整理一次。
- panel 关闭或应用退出前, 如果有未整理缓冲, 尝试整理一次。
- Obsidian 立即同步完成后, 如果画像发生变化, 更新 `Profile.md`。

防噪音策略:

- 写回前用 LLM 判断是否有值得沉淀的内容。
- 对近期已写入内容做简单去重。
- 单次追加控制长度。
- 写入失败只记录错误并在 CONFIG 状态展示, 不影响聊天主流程。

## IPC 与 UI

新增 IPC:

- `get-obsidian-config`
- `set-obsidian-config`
- `obsidian-sync-now`
- `get-obsidian-status`
- `open-obsidian-output-dir`

`preload.js` 暴露对应安全方法。

CONFIG 面板展示:

- 当前 vault 路径
- 输出目录
- 开关与保存按钮
- 立即同步按钮
- 最近同步结果

## 错误处理

- Vault 路径不存在: CONFIG 显示错误, 不启动同步。
- 没有读权限: 显示错误, 不重试刷屏。
- API Key 缺失: 可扫描文件, 但不做 LLM 提炼; 提示用户配置模型 Key。
- LLM 提炼失败: 保留同步状态, 下次继续尝试。
- 写回失败: 不影响聊天, 状态面板提示错误。
- Markdown 文件过大: 截断到安全长度并记录截断状态。

## 隐私与安全

- 默认关闭 Obsidian 关联, 需要用户在 CONFIG 明确启用。
- 只读取配置目录下的 `.md`。
- 只写入 `Macross/` 输出目录。
- 不删除、不移动、不重命名用户笔记。
- 不把 Obsidian 内容上传到除用户已配置的聊天模型 API 以外的服务。
- 同步状态存在 `~/.desktop-pet/obsidian-sync.json`, 权限 `0600`。

## 测试计划

- 配置合并: 旧 `data.json` 自动补齐 `obsidian` 默认值。
- 扫描过滤: 能递归发现 OneDayWorld 下 `.md`, 排除 `.obsidian/`、隐藏文件和 `Macross/`。
- 增量同步: 未变更文件不重复读取, 修改后能重新读取。
- 画像提炼: Obsidian 笔记能增量补充 `persona-memory.md` 记忆段。
- 写回: 自动创建 `Macross/Profile.md`、`Macross/Inbox.md`、`Macross/Chat Highlights/YYYY-MM.md`。
- 关闭开关: `enabled=false` 时不扫描不写回。
- 无 API Key: 给出清晰状态, 不崩溃。
- 路径不存在: 给出清晰状态, 不崩溃。

## 非目标

- 第一版不实现 Obsidian Local REST API。
- 第一版不调用 Obsidian 插件能力。
- 第一版不解析附件内容。
- 第一版不自动改写用户已有笔记。
- 第一版不做复杂语义检索或向量数据库。
