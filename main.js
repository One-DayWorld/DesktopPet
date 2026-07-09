const { app, BrowserWindow, ipcMain, screen, shell, session: electronSession, systemPreferences, net, powerMonitor, globalShortcut, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec, execFile } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);
// execFile 不经 shell, 参数以数组传入 → 从根上杜绝命令注入. 凡是把外部/AI 传入的
// 路径/URL/应用名拼进命令行的地方都应优先用它.
const execFileAsync = util.promisify(execFile);
const store = require('./store');
const memory = require('./memory');
const mammoth = require('mammoth');   // docx → 纯文本 (文章投喂)

let petWindow = null;
let panelWindow = null;
let state = store.load();
// 首次启动: 把旧的 persona/sessionRules(data.json) 与结构化画像(profile.json) 迁移进 persona-memory.md
memory.migrateIfNeeded(state.persona, state.sessionRules);

// 精简版标志: 构建时由 electron-builder 的 extraMetadata.vf1Lite 注入 package.json;
// 开发运行 (npm start) 时该字段不存在 → 完整版.
const LITE = (() => { try { return !!require('./package.json').vf1Lite; } catch (_) { return false; } })();

// ── Claude Code Hooks 自动安装 ──────────────────────────────────────────────
// 让 VF-1 在任何 Mac 上首次启动时自动配置 ~/.claude/settings.json,
// 不需要用户手动复制脚本 / 编辑 JSON. 幂等 — 已配置过会跳过, 路径变了会刷新.
//
// 流程:
//   1. 把 asar 里的 vf1-notify.sh 提取到 ~/.macross/vf1-notify.sh (asar 是只读, hook 没法直接执行)
//   2. 给提取出的脚本 +x 可执行权限
//   3. 读 ~/.claude/settings.json (不存在就创建空对象)
//   4. 把 4 类 hook (PermissionRequest/PostToolUse/PermissionDenied/Stop) 注入或更新
//   5. 写回 settings.json
function ensureClaudeHooksInstalled() {
  try {
    const homedir = os.homedir();
    const macrossDir = path.join(homedir, '.macross');
    const scriptDest = path.join(macrossDir, 'vf1-notify.sh');
    const scriptSrc = path.join(__dirname, 'scripts', 'vf1-notify.sh');
    const claudeDir = path.join(homedir, '.claude');
    const settingsPath = path.join(claudeDir, 'settings.json');

    // 1) 提取 / 更新脚本到 ~/.macross/ (并确保私有 flag 目录 run/ 存在, 均收紧到 700)
    if (!fs.existsSync(macrossDir)) fs.mkdirSync(macrossDir, { recursive: true, mode: 0o700 });
    else { try { fs.chmodSync(macrossDir, 0o700); } catch (_) {} }
    try { fs.mkdirSync(path.join(macrossDir, 'run'), { recursive: true, mode: 0o700 }); } catch (_) {}
    let srcContent;
    try { srcContent = fs.readFileSync(scriptSrc, 'utf8'); }
    catch (e) { console.error('[HOOK] cannot read script source at', scriptSrc, e.message); return; }
    let needsCopy = true;
    if (fs.existsSync(scriptDest)) {
      try { needsCopy = fs.readFileSync(scriptDest, 'utf8') !== srcContent; } catch (_) {}
    }
    if (needsCopy) {
      fs.writeFileSync(scriptDest, srcContent, { mode: 0o755 });
      console.log('[HOOK] script copied →', scriptDest);
    }
    try { fs.chmodSync(scriptDest, 0o755); } catch (_) {}

    // 2) 准备目标 hooks 配置
    const q = `'${scriptDest}'`;
    const desired = {
      PermissionRequest: [{ matcher: '.*', hooks: [{ type: 'command', command: `${q} pending $PPID` }] }],
      PostToolUse:       [{ matcher: '.*', hooks: [{ type: 'command', command: `${q} pending-clear` }] }],
      PermissionDenied:  [{ matcher: '.*', hooks: [{ type: 'command', command: `${q} pending-clear` }] }],
      Stop:              [{ hooks: [
        { type: 'command', command: `${q} pending-clear` },
        { type: 'command', command: `${q} task-done $PPID` },
      ] }],
    };

    // 3) 读 / 创建 settings.json
    if (!fs.existsSync(claudeDir)) fs.mkdirSync(claudeDir, { recursive: true });
    let settings = {};
    if (fs.existsSync(settingsPath)) {
      try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch (_) { settings = {}; }
    }
    settings.hooks = settings.hooks || {};

    // 4) 对每个事件: 删掉所有指向通知脚本的旧条目 (含已废弃的 zaku-notify.sh 与当前 vf1-notify.sh,
    //    路径可能过时), 再加入 desired —— 保证旧机体名残留的 hook 在升级后被清掉
    const isNotifyHook = (cmd) => /(?:zaku|vf1)-notify\.sh/.test(cmd || '');
    let changed = false;
    for (const evt of Object.keys(desired)) {
      const oldGroups = settings.hooks[evt] || [];
      const filteredGroups = oldGroups.map(g => ({
        ...g,
        hooks: (g.hooks || []).filter(h => !isNotifyHook(h.command)),
      })).filter(g => (g.hooks || []).length > 0);
      const newGroups = [...filteredGroups, ...desired[evt]];
      if (JSON.stringify(settings.hooks[evt]) !== JSON.stringify(newGroups)) {
        settings.hooks[evt] = newGroups;
        changed = true;
      }
    }
    if (changed) {
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
      console.log('[HOOK] hooks installed/updated in', settingsPath);
    } else {
      console.log('[HOOK] hooks already up-to-date');
    }
  } catch (e) {
    console.error('[HOOK] auto-install failed:', e.message);
  }
}

// 机体 "home" / 复位位置: 屏幕左下角 (相对传入显示器的整块 bounds 计算, 含 dock/菜单栏).
// 启动初始位置与 reset-pet-position 共用此函数, 保证两者完全一致.
const PET_W = 180, PET_H = 290;
const PET_HOME_DX = -4, PET_HOME_DY = 60;  // 在贴边基础上的微调 (左移 / 下移)
function homePetPosition(display) {
  const { x: sx, y: sy, width: sw, height: sh } = display.bounds;
  return {
    x: Math.round(sx + sw - PET_W + PET_HOME_DX),
    y: Math.round(sy + sh - PET_H + PET_HOME_DY)
  };
}

function createPetWindow() {
  // 初始位置 = 复位位置 (屏幕左下角 home), 每次启动都落在这里
  const pos = homePetPosition(screen.getPrimaryDisplay());
  state.petPosition = pos;
  store.save(state);
  console.log('[PET STARTUP] home pos:', pos);

  petWindow = new BrowserWindow({
    width: 180,
    height: 290,
    x: pos.x,
    y: pos.y,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  petWindow.loadFile('pet.html');
  petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });

  // 双保险: BrowserWindow 创建时的 x/y 在某些 macOS 配置下不可靠 (workspace 切换/HiDPI 等),
  // 加载完成后再 setPosition 一次, 强制把窗口固定到目标位置.
  petWindow.once('ready-to-show', () => {
    if (petWindow && !petWindow.isDestroyed()) {
      petWindow.setPosition(pos.x, pos.y);
      console.log('[PET] forced setPosition →', pos.x, pos.y, 'actual bounds:', petWindow.getBounds());
    }
  });
  setTimeout(() => {
    if (petWindow && !petWindow.isDestroyed()) {
      console.log('[PET] bounds after 1s:', petWindow.getBounds());
    }
  }, 1000);
}

function createPanelWindow() {
  panelWindow = new BrowserWindow({
    width: 760,
    height: 580,
    x: 0,
    y: 0,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    show: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 关键: panel 启动即隐藏, Chromium 默认会节流并最终冻结隐藏渲染进程的
      // setInterval, 导致 termPoll 几乎不运行 → 终端告警永远到不了 pet.
      // 关掉 throttling 让后台轮询稳定执行.
      backgroundThrottling: false
    }
  });

  // 注: 不调 setVisibleOnAllWorkspaces, 它跟 transparent:true 配合在某些 macOS 上会
  // 让 show() 静默失败 (window 标记 visible 但未实际渲染). pet 那边能用是因为它从不 hide,
  // 而 panel 有 hide/show 切换, 状态机更脆弱.
  panelWindow.loadFile('panel.html');
}

// ── Claude Code 权限等待检测（通过 hook 写入的 flag 文件）────────────────
// flag 放在 ~/.macross/run (700, 私有), hook 脚本与本进程都从 $HOME 派生同一路径对接.
// 不能用 os.tmpdir() ── Claude Code 进程的 TMPDIR 与本进程不同, 必须用固定的 HOME 派生路径.
const RUN_DIR = path.join(os.homedir(), '.macross', 'run');
const CLAUDE_PENDING_FLAG = path.join(RUN_DIR, 'vf1_claude_pending');

// ── 任务完成语音播报 ──────────────────────────────────────────────────────
const VF1_DONE_FLAG = path.join(RUN_DIR, 'vf1_task_done');
// 需求1: 后台子 agent 活动时间戳 flag — 子 agent hook 事件(带 agent_id)touch 刷新此文件 mtime
const VF1_SUBAGENT_FLAG = path.join(RUN_DIR, 'vf1_subagent_active');

// ── 语音台词 (只用中文; 全部集中在 voice-lines.json) ──────────────────────
function _voiceLang() { return 'zh'; }

// 从 voice-lines.json 读全部台词; 文件缺失/损坏时用极简兜底, 保证 App 不崩
function loadVoiceLines() {
  const FALLBACK = {
    alert:     { zh: '喂喂喂，有情况！' },
    emo:       { zh: ['在呢'] },
    greetings: { zh: ['哎，干嘛'] },
    break:     { zh: ['该起来活动了'] },
    taskDone:  { zh: '搞定，下一个' },
  };
  try {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'voice-lines.json'), 'utf8'));
    return Object.assign({}, FALLBACK, data);   // 缺的类目用兜底补齐
  } catch (e) {
    console.error('[VOICE] voice-lines.json 加载失败, 用内置兜底:', e.message);
    return FALLBACK;
  }
}
const VOICE = loadVoiceLines();
function _voiceArr(cat) { return VOICE[cat][_voiceLang()] || VOICE[cat].zh; }
function _voiceStr(cat) { return VOICE[cat][_voiceLang()] || VOICE[cat].zh; }
let _lastBreakAt = Date.now();   // 上次提醒时间; app 启动后从现在开始计时
let _breakInProgress = false;     // 防止动画期间重复触发
let _speechEnded = false;         // 渲染进程通知"当前语音已念完"
let _systemJustResumed = false;   // 唤醒后的保护标志 — 防止 setInterval 在 resume 事件前抢先触发

async function checkBreakReminder() {
  if (_breakInProgress) return;
  if (petWindow && !petWindow.isDestroyed() && !petWindow.isVisible()) return;  // 隐藏期间不打扰
  // 系统刚唤醒: setInterval 可能比 powerMonitor.resume 先跑.
  // 此时 _lastBreakAt 还是睡眠前的时间, 差值可能是几小时, 会误触发.
  // 检测到 _systemJustResumed 就重置计时基准并跳过本次检查.
  if (_systemJustResumed) {
    _systemJustResumed = false;
    _lastBreakAt = Date.now();
    return;
  }
  const cfg = state.breakReminder || { enabled: false, intervalMin: 60 };
  if (!cfg.enabled) return;
  const intervalMs = Math.max(1, Number(cfg.intervalMin) || 60) * 60 * 1000;
  if (Date.now() - _lastBreakAt < intervalMs) return;

  _lastBreakAt = Date.now();
  _breakInProgress = true;
  try {
    await runBreakAnimation();
  } finally {
    _breakInProgress = false;
  }
}

// 完整 8 步变形 + 飞行 + 提醒序列:
//   原位 Gerwalk → 变 Fighter → 飞中央 → 变 Gerwalk → 播报 → 变 Fighter → 飞回 → 变 Gerwalk
async function runBreakAnimation() {
  if (!petWindow || petWindow.isDestroyed()) return;
  const display = screen.getDisplayMatching(petWindow.getBounds());
  const { x: sx, y: sy, width: sw, height: sh } = display.workArea;
  const PW = 180, PH = 290;
  const startBounds = petWindow.getBounds();
  const targetX = Math.round(sx + (sw - PW) / 2);
  const targetY = Math.round(sy + (sh - PH) / 2);
  const startX = startBounds.x;
  const startY = startBounds.y;

  const _bm = _voiceArr('break');
  const msg = _bm[Math.floor(Math.random() * _bm.length)];
  const send = (data) => {
    if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.send('pet-update', data);
  };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // 默认速度 0.32, 中央段较慢但比之前(5.1s)快 1 秒, 现在 ~4.0s
  const NORMAL_SPEED  = 0.32;
  const DRAMATIC_SPEED = 0.2;     // 0.8 距离 / 0.2 = 4.0s
  // Fighter 端 = 0.2 (跳过起落架/舱盖开合段); Gerwalk = 0.7 (完全 Gerwalk)
  const PARTIAL_MORPH_MS = 1700;  // Gerwalk(0.7) ↔ Fighter(0.2) @0.32 = 1.56s + 140ms 余量
  const DRAMATIC_MORPH_MS = 4100; // Fighter(0.2) ↔ Battloid(0.90) @0.2 = 3.5s + 余量(末尾在放下姿态多定格一下)
  const YAW_SETTLE_MS = 300;      // 飞回前先把机头转到位再起飞 (pet.html yaw lerp 4.0rad/s, 最大转角 ~45° ≈ 200ms + 余量)
  const BREAK_BUBBLE_MS = 3000;   // 中央播报气泡时长: 比默认 4000ms 提前 1s 收掉, 赶在人形长到最高顶到气泡之前清掉, 避免重叠 (变形与播报仍同时进行, 不加停顿)

  // 飞行方向(X 分量) → 决定机头朝向
  const dxOut = targetX - startX;
  const yawFlyOut  = dxOut > 0 ? 'right' : 'left';   // 飞向中央时机头朝飞行方向
  const yawFlyBack = dxOut > 0 ? 'left'  : 'right';  // 飞回时反向

  // 1. 原位: 调机头朝飞行方向 + 变形成 Fighter + 进入醒目模式(让俯仰过渡藏在这次变形里)
  send({ bodyYaw: yawFlyOut, transformTo: 'fighter', breakMode: true });
  await sleep(PARTIAL_MORPH_MS);

  // 2. 飞向屏幕中央 (0.8s)
  await tweenWindow(startX, startY, targetX, targetY, 800);

  // 3. 中央: 切到慢速度 + 转正面 + 同时开始变形 Battloid 和语音播报
  //    气泡比默认 4s 提前收掉(见 BREAK_BUBBLE_MS), 赶在人形长到最高、顶到上方气泡之前清掉, 避免重叠.
  _speechEnded = false;
  send({ morphSpeed: DRAMATIC_SPEED, bodyYaw: 'break-center', transformTo: 'battloid', speakText: msg, speakBubbleMs: BREAK_BUBBLE_MS });

  // 4. 变形完成 → 放大成"全屏弹幕舞台"(机体居中, 整窗鼠标穿透) → 发射飞弹 → 等语音/保底 → 停火 → 收回
  await sleep(DRAMATIC_MORPH_MS);
  send({ fireArena: true });            // 渲染层先把机体固定居中
  await sleep(60);                      // 等居中生效再放大窗口, 避免闪一下
  petWindow.setIgnoreMouseEvents(true); // 全屏期间整窗鼠标穿透, 不挡用户操作
  petWindow.setBounds({ x: sx, y: sy, width: sw, height: sh });

  send({ firing: true });   // 开始发射飞弹齐射 (飞满全屏)
  const SPEECH_MAX_WAIT_MS = 12000;
  const FIRE_MIN_MS = 2600;  // 保底开火时长 — 防止语音结束信号(cancel 的杂散回调)提前掐断飞弹
  const t0 = Date.now();
  while (Date.now() - t0 < SPEECH_MAX_WAIT_MS) {
    if (_speechEnded && (Date.now() - t0) >= FIRE_MIN_MS) break;
    await sleep(150);
  }
  send({ firing: false });  // 语音完且已打满保底时长, 停火

  // 收回全屏舞台: 窗口回到居中 180×290, 恢复鼠标命中
  petWindow.setBounds({ x: targetX, y: targetY, width: PW, height: PH });
  petWindow.setIgnoreMouseEvents(false);
  send({ fireArena: false });

  // 5. 中央: Battloid → Fighter (仍用慢速; breakMode 保持开, 俯仰恒定不在中央突变)
  //    不在变形过程中转机头 — 人形原地"斜向侧转正"很难看. 等变回飞机后(下一步)再转.
  send({ transformTo: 'fighter' });
  await sleep(DRAMATIC_MORPH_MS);

  // 6. 先在中央把机头转到飞回方向并等它转到位, 再起飞 (此时已是飞机, 原地转向不难看).
  //    若边转边飞, 飞回前段会"机尾朝飞行方向"倒着飞 —— tween 是 ease-out, 起步最快,
  //    朝向必须在起飞前就对齐, 否则起步那段位移最大、错位最明显.
  send({ bodyYaw: yawFlyBack });
  await sleep(YAW_SETTLE_MS);
  await tweenWindow(targetX, targetY, startX, startY, 800);
  state.petPosition = { x: startX, y: startY };
  store.save(state);

  // 7. 原位: 切回正常速度 + Fighter → Gerwalk + 机头回到待命角 + 退出醒目模式
  //    (俯仰 -0.06 → 待机 0.32 的过渡藏在这次 Fighter→Gerwalk 变形里, 不显眼)
  send({ morphSpeed: NORMAL_SPEED, transformTo: 'gerwalk', bodyYaw: 'left', breakMode: false });
  await sleep(PARTIAL_MORPH_MS);
}

function tweenWindow(x0, y0, x1, y1, durationMs) {
  return new Promise(resolve => {
    if (!petWindow || petWindow.isDestroyed()) return resolve();
    const t0 = Date.now();
    const step = () => {
      if (!petWindow || petWindow.isDestroyed()) return resolve();
      const k = Math.min(1, (Date.now() - t0) / durationMs);
      // ease-out cubic
      const e = 1 - Math.pow(1 - k, 3);
      const x = Math.round(x0 + (x1 - x0) * e);
      const y = Math.round(y0 + (y1 - y0) * e);
      petWindow.setPosition(x, y);
      if (k < 1) setTimeout(step, 16);
      else resolve();
    };
    step();
  });
}

// ── 边沿巡航 ──────────────────────────────────────────────────────────────
// 待机时让 VF-1 沿屏幕四角顺时针缓慢飞行:
//   横边 (TL→TR, BR→BL): Fighter 形态 + yaw 对齐航向 → 机头精准朝飞行方向
//   纵边 (TR→BR, BL→TL): Gerwalk 形态 + yaw=face   → 悬停姿态, 不需要 pitch 也合理
// 干扰让位: 休息提醒 / 终端告警 / 任务完成 / 用户拖动 / 配置关闭 → 立刻让出当前 leg
// 角落到屏幕边的内缩, 横纵分开:
//   X (左右) = 12px → 不让飞机太贴左/右屏幕边
//   Y (顶底) = 0    → 顶/底飞行紧贴菜单栏 / dock (用户偏好)
const PATROL_PAD_X = 12;
const PATROL_PAD_Y = 0;
const PATROL_BOTTOM_EXTRA = 60;   // 底边左右飞行额外下移 (BR/BL 两角的 y), 让下边巡航贴更低
const PATROL_TOP_EXTRA    = -100; // 顶边左右飞行额外偏移 (TL/TR 两角的 y), 负值=上移
const PATROL_LEG_MS        = 28000;  // 单条边的飞行时间 (~30s)
const PATROL_DWELL_MS      = 0;      // 角落停顿 = 0, 飞到角立刻接下一条 leg, 中间不停留
const PATROL_USER_GRACE_MS = 6000;   // 用户拖完后多久不打扰
const PATROL_FORM_SETTLE_MS = 1200;  // 形态切换后等多少毫秒再起飞 (从 1.8s 降到 1.2s)
const PATROL_REPOS_MS      = 2200;   // 初次/恢复时, 飞到最近角的过渡时间

let _patrolInProgress = false;
let _patrolIndex      = -1;          // 当前角索引: 0=TL, 1=TR, 2=BR, 3=BL; -1 = 待重新对齐
let _patrolCW         = true;        // 当前飞行方向: true=顺时针, 每段 leg 后有概率反向
let _lastUserMoveAt   = 0;
const PATROL_REVERSE_PROB = 0.30;    // 每条 leg 完成后 30% 概率反向 (避免来回拉锯, 70% 维持当前方向)

function _patrolEnabled()  { return !!(state.edgePatrol && state.edgePatrol.enabled); }

function _canPatrolNow() {
  if (!_patrolEnabled()) return false;
  if (_breakInProgress) return false;
  if (_claudeFlagActive) return false;
  if (_ocAlertActive) return false;
  if (_taskDoneSession) return false;
  if (Date.now() - _lastUserMoveAt < PATROL_USER_GRACE_MS) return false;
  if (!petWindow || petWindow.isDestroyed()) return false;
  if (!petWindow.isVisible()) return false;   // 隐藏期间不巡航, 显示后停在原位
  return true;
}

function _patrolCorners() {
  const display = screen.getDisplayMatching(petWindow.getBounds());
  const { x: sx, y: sy, width: sw, height: sh } = display.workArea;
  const b = display.bounds;   // 物理屏幕范围 (含菜单栏/dock), 用于把角点钳到屏幕内
  const PW = 180, PH = 290;
  // 顶边角点不能高过屏幕物理上端 (b.y), 否则窗口跑到屏幕外, macOS getBounds 会返回越界值
  // 导致后续 setPosition 抛 "conversion failure" 并让巡航循环崩在角上.
  const topY    = Math.max(b.y, sy + PATROL_PAD_Y + PATROL_TOP_EXTRA);
  // 底边角点最多让窗口底缘略微越过屏幕下端一点点 (留 PH-30 可见), 同样避免越界过多.
  const bottomY = Math.min(b.y + b.height - 30, sy + sh - PH - PATROL_PAD_Y + PATROL_BOTTOM_EXTRA);
  return [
    { x: sx + PATROL_PAD_X,           y: topY },     // 0 TL
    { x: sx + sw - PW - PATROL_PAD_X, y: topY },     // 1 TR
    { x: sx + sw - PW - PATROL_PAD_X, y: bottomY },  // 2 BR
    { x: sx + PATROL_PAD_X,           y: bottomY }   // 3 BL
  ];
}

function _findNearestCornerIdx(cx, cy, corners) {
  let best = 0, minD = Infinity;
  for (let i = 0; i < 4; i++) {
    const dx = corners[i].x - cx, dy = corners[i].y - cy;
    const d = dx*dx + dy*dy;
    if (d < minD) { minD = d; best = i; }
  }
  return best;
}

// 线性匀速 + 中途可中断 (cancel 检测每帧执行一次, 用户拖动/告警等会让 leg 提前结束)
function tweenWindowCancellable(x0, y0, x1, y1, durationMs, shouldCancel) {
  return new Promise(resolve => {
    if (!petWindow || petWindow.isDestroyed()) return resolve('destroyed');
    const t0 = Date.now();
    const step = () => {
      if (!petWindow || petWindow.isDestroyed()) return resolve('destroyed');
      if (shouldCancel && shouldCancel()) return resolve('cancelled');
      const k = Math.min(1, (Date.now() - t0) / durationMs);
      const x = Math.round(x0 + (x1 - x0) * k);
      const y = Math.round(y0 + (y1 - y0) * k);
      // 安全网: 坐标非有限或超出 32 位整数范围时直接中断本段, 不让 setPosition 抛异常炸掉巡航循环
      if (!Number.isFinite(x) || !Number.isFinite(y) ||
          Math.abs(x) > 2147483000 || Math.abs(y) > 2147483000) {
        console.error('[PATROL] tween 坐标异常, 跳过本段:', { x0, y0, x1, y1, k, x, y });
        return resolve('cancelled');
      }
      petWindow.setPosition(x, y);
      if (k < 1) setTimeout(step, 16);
      else resolve('done');
    };
    step();
  });
}

async function _patrolStep() {
  const send = (data) => {
    if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.send('pet-update', data);
  };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const corners = _patrolCorners();

  // _patrolIndex < 0 才需要"重新对齐到最近角" (启动后首次/用户拖动后).
  // 其它打断 (任务完成/告警) 不会 reset _patrolIndex, 直接从当前位置接着飞向下一角.
  const curInit = petWindow.getBounds();
  if (_patrolIndex < 0) {
    _patrolIndex = _findNearestCornerIdx(curInit.x, curInit.y, corners);
    send({ transformTo: 'gerwalk', bodyYaw: 'face', patrolMode: 'vertical' });
    await sleep(PATROL_FORM_SETTLE_MS);
    if (!_canPatrolNow()) { send({ patrolMode: false }); return; }
    const target = corners[_patrolIndex];
    const r = await tweenWindowCancellable(curInit.x, curInit.y, target.x, target.y, PATROL_REPOS_MS, () => !_canPatrolNow());
    send({ patrolMode: false });
    if (r !== 'done') return;
  }

  // 飞向下一角. 方向由 _patrolCW 决定 (TL→TR→BR→BL = CW, 反过来 = CCW).
  // 每条 leg 之后有概率翻转, 让飞行轨迹不固定; 大多数时候保持当前方向, 少数时候掉头.
  const fromIdx = _patrolIndex;
  const toIdx   = _patrolCW ? (fromIdx + 1) % 4 : (fromIdx + 3) % 4;
  const refFrom = corners[fromIdx];
  const to      = corners[toIdx];
  // 用"标准航向"(refFrom→to) 决定形态/yaw, 保证半路恢复时形态和方向不会乱
  const refDx = to.x - refFrom.x;
  const refDy = to.y - refFrom.y;
  const horizontal = Math.abs(refDx) > Math.abs(refDy);

  let form, yaw, patrolMode;
  if (horizontal) {
    form = 'fighter';
    // 巡航专用 90° 侧身, 机头完全朝飞行方向 (区别于待命/休息提醒的 15° 偏转)
    yaw  = refDx > 0 ? 'patrol-right' : 'patrol-left';
    patrolMode = 'horizontal';
  } else {
    form = 'gerwalk';
    yaw  = 'face';
    patrolMode = 'vertical';
  }

  send({ transformTo: form, bodyYaw: yaw, patrolMode });
  await sleep(PATROL_FORM_SETTLE_MS);
  if (!_canPatrolNow()) { send({ patrolMode: false }); return; }

  // 起点 = 当前位置 (不再 snap 回 refFrom). 时间按剩余距离比例缩放.
  // 这样从任意中间点恢复都不会"先飞回去再前进"
  const cur = petWindow.getBounds();
  const fullDist = Math.hypot(refDx, refDy) || 1;
  const remDist  = Math.hypot(to.x - cur.x, to.y - cur.y);
  const ratio    = Math.max(0.05, Math.min(1, remDist / fullDist));
  const duration = Math.max(2000, Math.round(PATROL_LEG_MS * ratio));

  const result = await tweenWindowCancellable(cur.x, cur.y, to.x, to.y, duration, () => !_canPatrolNow());
  send({ patrolMode: false });
  if (result !== 'done') return;

  _patrolIndex = toIdx;
  // 每段 leg 完成后掷骰子, 一定概率反转方向 → 下一段会掉头, 否则继续同向
  if (Math.random() < PATROL_REVERSE_PROB) _patrolCW = !_patrolCW;
  await sleep(PATROL_DWELL_MS);
}

async function startEdgePatrolLoop() {
  // 启动后等 8s, 让 init/欢迎播报先走完, 不抢戏
  await new Promise(r => setTimeout(r, 8000));
  while (true) {
    if (!_canPatrolNow()) {
      // 让位时不再 reset _patrolIndex —— 用户拖动会在 move-pet 那里 reset (走"重新找最近角"路径);
      // 任务完成/告警/休息提醒等让位后, _patrolIndex 仍指向上一站, 续传时直接从当前位置飞向下一角
      await new Promise(r => setTimeout(r, 1500));
      continue;
    }
    _patrolInProgress = true;
    try {
      await _patrolStep();
    } catch (e) {
      console.error('[PATROL] step error:', e);
      _patrolIndex = -1;
    } finally {
      _patrolInProgress = false;
    }
  }
}

async function checkTaskDoneFlag() {
  if (!fs.existsSync(VF1_DONE_FLAG)) return;
  // 需求1: 后台子 agent 近 12s 内仍在活动 → 推迟播报(保留 flag, 每秒轮询重判), 静默满 12s 才报
  try {
    const st = fs.statSync(VF1_SUBAGENT_FLAG);
    if (Date.now() - st.mtimeMs < 12000) return;
  } catch (_) { /* flag 不存在 = 无子 agent 活动, 正常播报 */ }
  let raw = '';
  try {
    raw = fs.readFileSync(VF1_DONE_FLAG, 'utf8');
    fs.unlinkSync(VF1_DONE_FLAG);
  } catch (e) {
    console.error('[VF1_DONE] read error:', e.message);
    return;
  }
  // 新格式: 第一行 tty (/dev/ttysXXX), 第二行起为消息. 老格式: 整文件就是消息.
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  let tty = '';
  let msg = '';
  if (lines.length && lines[0].startsWith('/dev/tty')) {
    tty = lines[0];
    msg = lines.slice(1).join(' ');
  } else {
    msg = lines.join(' ');
  }
  // 不管 flag 文件里是什么提示词, 任务完成播报统一用固定台词 (随语言切换)
  msg = _voiceStr('taskDone');

  // 记录任务完成对应的 terminal session, 让单击机体时能跳过去
  // 没拿到 tty 则不存 session — 不能 fallback 到"最前的 terminal", 容易误跳到别人
  if (tty) {
    try {
      _taskDoneSession = await findFrontTerminalSession(tty);
    } catch (_) { _taskDoneSession = null; }
  } else {
    _taskDoneSession = null;
  }

  console.log('[VF1_DONE] firing:', msg, '| tty:', tty || '(none)', '| session:', _taskDoneSession ? _taskDoneSession.app + '#' + _taskDoneSession.windowIndex : '(none)');
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.send('pet-update', {
      speakText: msg,
      // 气泡常驻直到驾驶员单击机体跳转到对应 terminal — 让任务完成提示不会被 4s 自动消失错过
      speakPersist: true,
      taskDoneAvailable: !!_taskDoneSession,
    });
  }
  if (panelWindow && !panelWindow.isDestroyed()) {
    panelWindow.webContents.send('pet-update', { taskDoneAvailable: true });
  }
}
// 任务完成后未消费的 terminal session — 单击机体会跳过去, 跳完清空
let _taskDoneSession = null;
let _claudeFlagActive = false;
let _ocAlertActive = false;   // OpenCode step-finish 等待用户回复
let _ocLastPartId = null;     // 上次看到的 part.id (检测新事件用)
let _ocFirstScan = true;      // 启动首次扫描只建基线, 不把 DB 里遗留的 step-finish 当成"刚完成"误播报
let _ocClickSession = null;   // OpenCode 所在终端会话 — 点击机体跳转用 (DB 无 tty, 靠进程表定位)

// 找需要确认的终端窗口. 优先按 PermissionRequest hook 写入 flag 的 tty 精确匹配,
// 找不到再 fallback 到"最前的终端窗口". 没找到返回 null.
async function findFrontTerminalSession(ttyOverride) {
  // 读 flag 文件取 tty (e.g. "/dev/ttys003"); 老格式兼容: 文件可能是空 touch
  // ttyOverride 让外部 (如 task-done flag) 直接传入精确 tty, 绕过 pending flag 文件
  let claudeTty = '';
  if (typeof ttyOverride === 'string' && ttyOverride.startsWith('/dev/tty')) {
    claudeTty = ttyOverride;
  } else {
    try {
      const c = fs.readFileSync(CLAUDE_PENDING_FLAG, 'utf8').trim();
      if (c.startsWith('/dev/tty')) claudeTty = c;
    } catch (_) {}
  }

  const tmpScript = path.join(os.tmpdir(), `term_front_${Date.now()}.js`);
  const script = `
    function tryRead() {
      const targetTty = ${JSON.stringify(claudeTty)};

      // ── 优先: 用 tty 精确匹配 Claude Code 所在的窗口/tab ──
      if (targetTty) {
        try {
          const T = Application('Terminal');
          if (T.running()) {
            const wins = T.windows;
            for (let wi = 0; wi < wins.length; wi++) {
              const w = wins[wi];
              const tabs = w.tabs;
              for (let ti = 0; ti < tabs.length; ti++) {
                if (tabs[ti].tty() === targetTty) {
                  return JSON.stringify({ app: 'Terminal', windowId: w.id(), windowIndex: wi+1, windowName: w.name(), tabIndex: ti+1, matched: 'tty' });
                }
              }
            }
          }
        } catch(e) {}
        try {
          const I = Application('iTerm2');
          if (I.running()) {
            const wins = I.windows;
            for (let wi = 0; wi < wins.length; wi++) {
              const w = wins[wi];
              const tabs = w.tabs;
              for (let ti = 0; ti < tabs.length; ti++) {
                const sessions = tabs[ti].sessions;
                for (let si = 0; si < sessions.length; si++) {
                  if (sessions[si].tty() === targetTty) {
                    return JSON.stringify({ app: 'iTerm2', windowId: 0, windowIndex: wi+1, windowName: w.name(), tabIndex: ti+1, matched: 'tty' });
                  }
                }
              }
            }
          }
        } catch(e) {}
      }

      // ── Fallback: 最前的终端窗口 (老逻辑) ──
      try {
        const T = Application('Terminal');
        if (T.running() && T.frontmost()) {
          const w = T.windows[0];
          return JSON.stringify({ app: 'Terminal', windowId: w.id(), windowIndex: 1, windowName: w.name() });
        }
      } catch(e) {}
      try {
        const I = Application('iTerm2');
        if (I.running() && I.frontmost()) {
          const w = I.windows[0];
          return JSON.stringify({ app: 'iTerm2', windowId: 0, windowIndex: 1, windowName: w.name() });
        }
      } catch(e) {}
      try {
        const T = Application('Terminal');
        if (T.running()) {
          const w = T.windows[0];
          return JSON.stringify({ app: 'Terminal', windowId: w.id(), windowIndex: 1, windowName: w.name() });
        }
      } catch(e) {}
      return '';
    }
    tryRead();
  `;
  try {
    fs.writeFileSync(tmpScript, script);
    const { stdout } = await execAsync(`osascript -l JavaScript "${tmpScript}"`, { timeout: 2000 });
    try { fs.unlinkSync(tmpScript); } catch(_) {}
    const s = stdout.trim();
    return s ? JSON.parse(s) : null;
  } catch (_) {
    try { fs.unlinkSync(tmpScript); } catch(_) {}
    return null;
  }
}

// flag 出现的时间戳 (debounce 用). 只有 flag 持续存在 ≥ FLAG_DEBOUNCE_MS 才视为"驾驶员真的需要确认".
// 防止 PermissionRequest 触发后用户秒批 (PostToolUse 立即清 flag) 的瞬时误响.
let _flagAppearedAt = 0;
const FLAG_DEBOUNCE_MS = 400;

async function checkClaudePendingFlag() {
  const active = fs.existsSync(CLAUDE_PENDING_FLAG);

  // 跟踪 flag 出现时间
  if (active) {
    if (_flagAppearedAt === 0) _flagAppearedAt = Date.now();
  } else {
    _flagAppearedAt = 0;
  }

  // 经 debounce 过滤后的实际告警状态
  const shouldAlert = active && (Date.now() - _flagAppearedAt) >= FLAG_DEBOUNCE_MS;
  if (shouldAlert === _termAlertActive) return;

  _termAlertActive = shouldAlert;
  _claudeFlagActive = active;

  if (shouldAlert) {
    if (!_termAlertSession) _termAlertSession = await findFrontTerminalSession();
    // 新的 pending 比旧的 task-done 更紧急, 让单击优先响应它
    if (_taskDoneSession) {
      _taskDoneSession = null;
      if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.send('pet-update', { taskDoneAvailable: false });
    }
    if (petWindow   && !petWindow.isDestroyed())   petWindow.webContents.send('pet-update', { termAlert: true });
    if (panelWindow && !panelWindow.isDestroyed()) panelWindow.webContents.send('pet-update', { termAlert: true });
  } else {
    // flag 被清 (PostToolUse / PermissionDenied / Stop) → 主动熄灭告警
    // (旧版依赖 panel 扫屏兜底, 现在 panel 扫描已禁用, 此处必须主动清)
    _termAlertSession = null;
    if (petWindow   && !petWindow.isDestroyed())   petWindow.webContents.send('pet-update', { termAlert: false });
    if (panelWindow && !panelWindow.isDestroyed()) panelWindow.webContents.send('pet-update', { termAlert: false });
  }
}

// ── OpenCode 活动监控 ────────────────────────────────────────────────────────
// 通过轮询 opencode.db 的 part 表检测任务完成事件 (step-finish reason:stop).
// 不依赖 ACP HTTP 服务器 (v1.17.7 TUI 模式不对外暴露端口).
const OC_DB = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');

// 找当前运行的 opencode TUI 进程绑定的 tty (e.g. "/dev/ttys001"), 供点击机体跳转到对应终端窗口.
// opencode.db 不含 tty 信息, 只能靠进程表定位. 多实例时取第一个有真实 tty 的 opencode 进程
// (无法精确对应到具体 session_id, 但单实例场景——绝大多数——能准确命中).
async function findOpenCodeTty() {
  try {
    const { stdout } = await execAsync('ps -axo tty,comm', { timeout: 2000 });
    for (const line of stdout.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 2) continue;
      const tty = parts[0];
      const comm = parts.slice(1).join(' ');
      if (/^ttys\d+$/.test(tty) && /(^|\/)opencode$/.test(comm)) return '/dev/' + tty;
    }
  } catch (_) {}
  return '';
}

async function checkOpenCodeActivity() {
  // DB 不存在 → opencode 未使用过, 静默清空残留状态
  let dbExists = false;
  try { fs.accessSync(OC_DB); dbExists = true; } catch (_) {}
  if (!dbExists) {
    if (_ocAlertActive) {
      _ocAlertActive = false;
      _ocClickSession = null;
      if (petWindow   && !petWindow.isDestroyed())   petWindow.webContents.send('pet-update', { ocAlert: false });
      if (panelWindow && !panelWindow.isDestroyed()) panelWindow.webContents.send('pet-update', { ocAlert: false });
    }
    return;
  }

  try {
    // 取最新 5 条 part, 同时 JOIN session 获取标题 (一次查询, 避免二次 SQL 拼接)
    const sql = "SELECT p.id, p.session_id, p.data, COALESCE(s.title,'') AS title FROM part p LEFT JOIN session s ON s.id=p.session_id ORDER BY p.time_created DESC LIMIT 5";
    const { stdout } = await execAsync(`sqlite3 -json "${OC_DB}" "${sql}"`, { timeout: 3000 });

    let parts;
    try { parts = JSON.parse(stdout.trim() || '[]'); } catch (_) { return; }
    if (!parts.length) return;

    const top = parts[0];
    if (top.id === _ocLastPartId) return;   // 无变化
    _ocLastPartId = top.id;

    // 启动后首次扫描: 只把当前最新 part 记成基线, 不触发告警/播报 —
    // 否则 OpenCode 上次会话正常停在 step-finish:stop, 每次启动都会被误判成"刚完成"
    if (_ocFirstScan) { _ocFirstScan = false; return; }

    let topData;
    try { topData = typeof top.data === 'string' ? JSON.parse(top.data) : top.data; } catch (_) { return; }

    if (topData.type === 'step-finish' && topData.reason === 'stop') {
      // 模型完成一轮回复, 正在等待用户输入
      if (!_ocAlertActive) {
        _ocAlertActive = true;
        const msg = _voiceStr('taskDone');
        // 记录 OpenCode 所在终端窗口, 供点击机体跳转 (拿不到就 null, 点击会 fallback)
        try {
          const tty = await findOpenCodeTty();
          _ocClickSession = tty ? await findFrontTerminalSession(tty) : null;
        } catch (_) { _ocClickSession = null; }
        if (petWindow   && !petWindow.isDestroyed())   petWindow.webContents.send('pet-update', { speakText: msg, speakPersist: false, ocAlert: true });
        if (panelWindow && !panelWindow.isDestroyed()) panelWindow.webContents.send('pet-update', { ocAlert: true, ocTitle: top.title || top.session_id });
      }
    } else if (topData.type !== 'step-finish') {
      // step-start / text / tool → OpenCode 正在运行, 清掉告警
      if (_ocAlertActive) {
        _ocAlertActive = false;
        _ocClickSession = null;
        if (petWindow   && !petWindow.isDestroyed())   petWindow.webContents.send('pet-update', { ocAlert: false });
        if (panelWindow && !panelWindow.isDestroyed()) panelWindow.webContents.send('pet-update', { ocAlert: false });
      }
    }
    // step-finish reason:tool-calls → 即将调用工具, 保持当前状态
  } catch (_) {
    // sqlite3 不可用 / DB 被锁 / 格式错误 — 静默跳过
  }
}

// 隐藏 / 显示机体窗口 (快捷键 ⌘⌥H 与 CONFIG 按钮共用). 隐藏期间巡航/休息提醒暂停, 不乱跑.
let _hiddenAtPos = null;
function togglePetVisible(force) {
  if (!petWindow || petWindow.isDestroyed()) return false;
  const show = (typeof force === 'boolean') ? force : !petWindow.isVisible();
  if (show) {
    petWindow.showInactive();   // 显示但不抢焦点
    // macOS 在 show 时会把"部分越出屏幕"的窗口(如右下角 home 位故意压低)约束回可见区, 导致跳位;
    // 用隐藏前记下的精确坐标强制还原, 并补一帧覆盖异步约束.
    if (_hiddenAtPos) {
      const p = _hiddenAtPos; _hiddenAtPos = null;
      petWindow.setPosition(p.x, p.y);
      setTimeout(() => { if (petWindow && !petWindow.isDestroyed()) petWindow.setPosition(p.x, p.y); }, 30);
    }
    if (petWindow.webContents) petWindow.webContents.send('pet-update', { petSay: '回来了，想我了吗' });
  } else {
    const b = petWindow.getBounds();
    _hiddenAtPos = { x: b.x, y: b.y };   // 记下隐藏前的精确位置
    petWindow.hide();
  }
  // 通知面板同步按钮文案
  if (panelWindow && !panelWindow.isDestroyed()) {
    panelWindow.webContents.send('pet-update', { petVisible: show });
  }
  return show;
}

app.whenReady().then(() => {
  // 自动安装 Claude Code hooks (首次启动 / app 被搬到新位置 / 脚本更新都会刷新)
  ensureClaudeHooksInstalled();

  createPetWindow();
  createPanelWindow();

  // 启动时清掉残留的 flag 文件 — 它们是 app 关闭期间累积的陈旧通知,
  // 不该在新会话启动时被当作"刚刚完成"重新播报
  try { if (fs.existsSync(VF1_DONE_FLAG)) fs.unlinkSync(VF1_DONE_FLAG); } catch (_) {}
  try { if (fs.existsSync(CLAUDE_PENDING_FLAG)) fs.unlinkSync(CLAUDE_PENDING_FLAG); } catch (_) {}

  setInterval(() => { checkClaudePendingFlag().catch(() => {}); }, 800);    // 检测 Claude Code 权限等待
  setInterval(() => { checkTaskDoneFlag().catch(() => {}); }, 1000);        // 检测任务完成播报
  setInterval(() => { checkOpenCodeActivity().catch(() => {}); }, 2000);   // 检测 OpenCode 活动

  // 休息提醒: 每分钟检查一次, 到点了让机体飞到屏幕中央播报
  setInterval(() => { checkBreakReminder().catch(() => {}); }, 60 * 1000);

  // 边沿巡航: 待机时沿屏幕四角顺时针缓慢飞行 (开关在 CONFIG → 机体设置)
  startEdgePatrolLoop().catch(e => console.error('[PATROL] loop crashed:', e));

  // 全局快捷键 ⌘⌥H: 隐藏 / 显示机体 (机体挡住要点的区域时, 按一下藏起来, 用完再按显示)
  try {
    globalShortcut.register('CommandOrControl+Alt+H', () => togglePetVisible());
  } catch (e) { console.error('[HOTKEY] 注册失败:', e.message); }
  app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch (_) {} });

  // 合盖/休眠期间不算入休息计时, 否则一晚上 8h 累积下来开盖会连珠播报
  // suspend(系统进入睡眠): 设置保护标志, 唤醒后第一次 checkBreakReminder 会跳过
  // resume (系统唤醒)    : 重置计时基准(双保险 — 即使 resume 先于 setInterval 也没问题)
  powerMonitor.on('suspend', () => {
    _systemJustResumed = true;   // 在 suspend 时就打标, 不依赖 resume 事件的到达顺序
    console.log('[BREAK] system suspend — set resume guard');
  });
  powerMonitor.on('resume', () => {
    _systemJustResumed = true;   // 两边都打, 覆盖 suspend 事件没触发的边缘情况
    _lastBreakAt = Date.now();
    console.log('[BREAK] system resume — reset break-reminder timer');
  });

  app.on('activate', () => {
    if (!petWindow) createPetWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── AppleScript helpers ───────────────────────────────────
function escAppleScript(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// args 通过 osascript 的 `on run argv` 传入脚本, 不拼进脚本源码 → 含外部数据的路径/文本
// 不会破坏 AppleScript 结构, 杜绝脚本注入. 不传 args 时行为与旧版一致.
async function runAppleScript(script, args = []) {
  const tmpFile = path.join(os.tmpdir(), `pet-scpt-${Date.now()}-${process.pid}.scpt`);
  fs.writeFileSync(tmpFile, script, 'utf8');
  try {
    const { stdout } = await execFileAsync('osascript', [tmpFile, ...args.map(String)]);
    return stdout.trim();
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  }
}

// ── IPC Handlers ─────────────────────────────────────────

ipcMain.handle('notify-speech-end', () => { _speechEnded = true; });

ipcMain.handle('report-voices', (_, voices) => {
  console.log('[VOICES REPORT]');
  voices.forEach(v => console.log(`  - ${v.name} | ${v.lang} | default=${v.default} | local=${v.localService}`));
});

ipcMain.handle('get-state', () => state);

ipcMain.handle('save-state', (_, newState) => {
  state = newState;
  store.save(state);
  broadcastPetUpdate();
});

ipcMain.handle('toggle-panel', () => {
  if (!panelWindow) {
    console.log('[PANEL] no panel window — recreating');
    createPanelWindow();
    return;
  }
  const visible = panelWindow.isVisible();
  const focused = panelWindow.isFocused();
  console.log('[PANEL] toggle, visible:', visible, 'focused:', focused, 'minimized:', panelWindow.isMinimized());

  // "可见且我正在用" → 收起; 其它情况(隐藏 / 被其它窗口压底) → 重新置前
  if (visible && focused) {
    panelWindow.hide();
    runRefine('panel-hide').catch(() => {});   // 会话边界: 收起 panel 时提炼本段对话
    if (petWindow && !petWindow.isDestroyed()) {
      petWindow.webContents.send('pet-update', { panelOpen: false });
    }
    return;
  }

  if (panelWindow.isMinimized()) panelWindow.restore();

  // 面板布局: 完全占满屏幕 (左上角对齐). 机器人因为 alwaysOnTop:true 自动浮在面板之上.
  const petBounds = petWindow.getBounds();
  const display = screen.getDisplayMatching(petBounds);
  const { x: sx, y: sy, width: sw, height: sh } = display.workArea;
  const PW = sw;
  const PH = sh;
  const px = sx;
  const py = sy;

  console.log('[PANEL] showing at', px, py, 'size', PW + 'x' + PH, 'display', sw + 'x' + sh);
  panelWindow.setSize(PW, PH);
  panelWindow.setPosition(px, py);
  // 关键: 只在"被压底"或"刚显示"那一刻短暂 floating, 把面板推到前面;
  // 200ms 后取消 alwaysOnTop, 让面板回到正常窗口层级 ── 这样用户切到其它 app 时
  // 面板会自然让位, 而不是永远赖在最前.
  panelWindow.setAlwaysOnTop(true, 'floating');
  panelWindow.show();
  panelWindow.moveTop();
  panelWindow.focus();
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.send('pet-update', { panelOpen: true });
  }
  setTimeout(() => {
    if (!panelWindow || panelWindow.isDestroyed()) return;
    panelWindow.setAlwaysOnTop(false);
    console.log('[PANEL] released alwaysOnTop, isVisible:', panelWindow.isVisible(),
                'bounds:', JSON.stringify(panelWindow.getBounds()));
  }, 220);
});

ipcMain.handle('close-panel', () => {
  if (panelWindow) panelWindow.hide();
  runRefine('panel-close').catch(() => {});   // 会话边界: 关闭 panel 时提炼本段对话
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.send('pet-update', { panelOpen: false });
  }
});

// 文章投喂 — 选本地文件 (txt/docx), 读取正文 → 摄取进画像
ipcMain.handle('pick-article-file', async () => {
  try {
    const res = await dialog.showOpenDialog(panelWindow || undefined, {
      title: '选择要投喂的文章',
      properties: ['openFile'],
      filters: [{ name: '文章', extensions: ['txt', 'md', 'docx'] }]
    });
    if (res.canceled || !res.filePaths || !res.filePaths.length) return { ok: false, canceled: true };
    const fp = res.filePaths[0];
    const ext = path.extname(fp).toLowerCase();
    let text = '';
    if (ext === '.docx') {
      const r = await mammoth.extractRawText({ path: fp });
      text = r.value || '';
    } else {
      text = fs.readFileSync(fp, 'utf8');   // txt / md
    }
    const title = path.basename(fp, ext);
    return await ingestArticle(title, text);
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 文章投喂 — 抓取链接正文 → 摄取进画像
ipcMain.handle('ingest-article-url', async (_, url) => {
  try {
    if (!/^https?:\/\//i.test(url || '')) return { ok: false, error: '不是有效的链接' };
    const { title, text } = await fetchUrlText(url);
    if (!text || text.length < 80) return { ok: false, error: '未能从该链接提取到正文(可能需要登录或是动态页面)' };
    return await ingestArticle(title, text);
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── 记忆面板 IPC ─────────────────────────────────────────────────────────
// 返回画像 + 当前羁绊等级 (面板顶部展示)
ipcMain.handle('get-memory-profile', () => {
  return { memory: memory.getMemoryText(), level: state.pet.level, xp: state.pet.xp };
});

// 记忆手动编辑改为"打开设定文件"直接编辑, 不再走面板 IPC — 打开 persona-memory.md
ipcMain.handle('open-config-file', async () => {
  try { await shell.openPath(memory.CONFIG_FILE); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// 一键清空记忆 (记忆段清空; 性格/规则/归档原文不动)
ipcMain.handle('clear-memory', () => {
  try { memory.clearProfile(); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// 从头开始: 清近期对话 + 提炼缓冲 + 本场规则 + 长期画像 + 羁绊等级/经验归零回 Lv.1.
// 保留: 性格人设(persona)、原始归档(chat-archive/articles 不动).
ipcMain.handle('reset-conversation', () => {
  try {
    state.chatHistory = [];
    memory.setRules('');       // 清本场规则(md)
    _turnsSinceRefine = [];
    memory.clearProfile();     // 清长期记忆段(md); 性格/归档保留
    state.pet.xp = 0;            // 羁绊经验归零
    state.pet.level = 1;         // 等级回 Lv.1
    state.pet.mood = 'happy';
    store.save(state);
    broadcastPetUpdate();        // 立即刷新机体上显示的等级/羁绊
    return { ok: true, xp: state.pet.xp, level: state.pet.level };
  } catch (e) { return { ok: false, error: e.message }; }
});


// 让 petWindow 在透明区域穿透鼠标 — pet.html 根据 hit-zone 矩形动态调用.
// forward:true 仍把 mousemove 转发给渲染进程, 这样 hit-zone 检测能持续工作.
ipcMain.handle('set-ignore-mouse', (_, ignore) => {
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.setIgnoreMouseEvents(!!ignore, { forward: true });
  }
});

// 直接调系统默认浏览器打开外部 URL (CHAT tab 快捷"打开 X"按钮使用)
ipcMain.handle('open-external', async (_, url) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false;
  try { await shell.openExternal(url); return true; }
  catch (e) { console.error('[OPEN-EXTERNAL]', e.message); return false; }
});

ipcMain.handle('move-pet', (_, x, y) => {
  if (petWindow) {
    petWindow.setPosition(Math.round(x), Math.round(y));
    state.petPosition = { x: Math.round(x), y: Math.round(y) };
    store.save(state);
    // 通知巡航循环用户在拖, 暂停打扰; 拖完后宽限期内不抢位
    _lastUserMoveAt = Date.now();
    _patrolIndex = -1;
  }
});

const PROVIDERS = {
  qwen:      { name: '千问',      needsKey: true },
  deepseek:  { name: 'DeepSeek',  needsKey: true },
};

const MODEL_DISPLAY = {
  qwen:      '通义千问 Plus（阿里云）',
  deepseek:  'DeepSeek Chat（DeepSeek）',
};


function extractMoodFromText(text) {
  const matches = [...text.matchAll(/[（(]([^）)]+)[）)]/g)].map(m => m[1]).join('');
  if (!matches) return 'happy';
  if (/摇尾|开心|高兴|快乐|蹦|跳|兴奋|激动|汪/.test(matches)) return 'excited';
  if (/思考|想想|嗯|歪头|困惑/.test(matches)) return 'thinking';
  if (/睡|困|打哈欠|疲/.test(matches)) return 'sleeping';
  return 'happy';
}

function stripBrackets(text) {
  return text.replace(/[（(][^）)]*[）)]/g, '').replace(/\s{2,}/g, ' ').trim();
}

async function fetchWeather(location) {
  try {
    const city = encodeURIComponent(location);
    const res = await fetch(`https://wttr.in/${city}?lang=zh&format=j1`);
    if (!res.ok) return `无法获取${location}的天气信息`;
    const data = await res.json();
    const cur = data.current_condition?.[0];
    if (!cur) return `无法解析${location}的天气数据`;
    const desc = cur.lang_zh?.[0]?.value || cur.weatherDesc?.[0]?.value || '未知';
    const temp = cur.temp_C;
    const feels = cur.FeelsLikeC;
    const humidity = cur.humidity;
    const weather1 = data.weather?.[0];
    const weather2 = data.weather?.[1];
    let result = `${location}当前：${desc}，气温${temp}°C（体感${feels}°C），湿度${humidity}%`;
    if (weather1) {
      const maxT = weather1.maxtempC, minT = weather1.mintempC;
      const d1 = weather1.hourly?.[4]?.lang_zh?.[0]?.value || weather1.hourly?.[4]?.weatherDesc?.[0]?.value || '';
      result += `。今天：${d1}，${minT}~${maxT}°C`;
    }
    if (weather2) {
      const maxT = weather2.maxtempC, minT = weather2.mintempC;
      const d2 = weather2.hourly?.[4]?.lang_zh?.[0]?.value || weather2.hourly?.[4]?.weatherDesc?.[0]?.value || '';
      result += `。明天：${d2}，${minT}~${maxT}°C`;
    }
    return result;
  } catch (e) {
    return `获取天气失败：${e.message}`;
  }
}

const CLAUDE_TOOLS = [
  {
    name: 'get_weather',
    description: '获取指定城市的实时天气和明后天预报',
    input_schema: {
      type: 'object',
      properties: {
        location: { type: 'string', description: '城市名称，如"上海"、"北京"、"London"' }
      },
      required: ['location']
    }
  },
  {
    name: 'search_web',
    description: '搜索互联网获取实时信息，包括新闻、赛事比分、股价、人物、事件等最新数据。遇到任何实时问题必须调用此工具',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词，尽量具体，如"2024 CBA深圳队vs浙江队比分"' }
      },
      required: ['query']
    }
  },
  {
    name: 'execute_action',
    description: '在用户电脑上执行操作：打开网址、打开应用程序。用户说"帮我打开/启动/运行..."时调用此工具',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['open_url', 'open_app'],
          description: 'open_url：在浏览器打开URL，或在 Terminal 执行 .command/.sh/.zsh 脚本（自动识别后缀）；open_app：打开Mac应用程序'
        },
        value: {
          type: 'string',
          description: 'open_url时填完整URL（如https://chat.deepseek.com），open_app时填应用名称（如"微信"、"Safari"、"Finder"）'
        },
        browser: {
          type: 'string',
          description: '可选，仅open_url时有效。用户指定了浏览器时填写，如"Chrome"、"Firefox"、"Safari"、"Edge"、"Brave"。不填则使用系统默认浏览器'
        }
      },
      required: ['action', 'value']
    }
  },
  {
    name: 'manage_files',
    description: '管理用户本地文件：列出目录内容（含子目录）、复制文件、将文件移入废纸篓、或重命名/移动文件。支持Downloads、Desktop及任意用户目录',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'copy', 'delete', 'rename'],
          description: 'list：列出目录内容（文件和子目录）；copy：复制文件到目标目录；delete：将文件移入废纸篓；rename：重命名或移动文件'
        },
        directory: {
          type: 'string',
          description: '目录：downloads=下载文件夹，desktop=桌面，或填写绝对路径。action=list时使用'
        },
        filter: {
          type: 'string',
          enum: ['large', 'old', 'all'],
          description: 'action=list时筛选：large=大文件(>50MB)，old=超30天旧文件，all=全部（默认）'
        },
        source_path: {
          type: 'string',
          description: 'action=copy时，源文件的完整路径'
        },
        dest_dir: {
          type: 'string',
          description: 'action=copy时，目标目录的完整路径'
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'action=delete时，要删除的完整文件路径数组'
        },
        path: {
          type: 'string',
          description: 'action=rename时，要重命名的文件的完整路径'
        },
        new_name: {
          type: 'string',
          description: 'action=rename时，新文件名（含扩展名）'
        }
      },
      required: ['action']
    }
  },
  {
    name: 'download_file',
    description: '从URL下载文件到本地指定文件夹。用于下载Box、直链等文件。如果下载失败（需要登录验证），会提示用户手动下载',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '文件的直接下载URL' },
        filename: { type: 'string', description: '保存的文件名（含扩展名，如"report.pdf"）。不填则从URL自动推断' },
        directory: {
          type: 'string',
          description: '保存位置：downloads=下载文件夹（默认），desktop=桌面，或填写绝对路径（如"/Users/yourname/Documents/your-folder"）'
        }
      },
      required: ['url']
    }
  }
];

const OPENAI_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: '获取指定城市的实时天气和明后天预报',
      parameters: {
        type: 'object',
        properties: {
          location: { type: 'string', description: '城市名称，如"上海"、"北京"、"London"' }
        },
        required: ['location']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_web',
      description: '搜索互联网获取实时信息，包括新闻、赛事比分、股价、人物、事件等最新数据。遇到任何实时问题必须调用此工具',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词，尽量具体，如"2024 CBA深圳队vs浙江队比分"' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'execute_action',
      description: '在用户电脑上执行操作：打开网址、打开应用程序。用户说"帮我打开/启动/运行..."时调用此工具',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['open_url', 'open_app'],
            description: 'open_url：在浏览器打开URL，或在 Terminal 执行 .command/.sh/.zsh 脚本（自动识别后缀）；open_app：打开Mac应用程序'
          },
          value: {
            type: 'string',
            description: 'open_url时填完整URL（如https://chat.deepseek.com），open_app时填应用名称（如"微信"、"Safari"、"Finder"）'
          },
          browser: {
            type: 'string',
            description: '可选，仅open_url时有效。用户指定了浏览器时填写，如"Chrome"、"Firefox"、"Safari"、"Edge"、"Brave"。不填则使用系统默认浏览器'
          }
        },
        required: ['action', 'value']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'manage_files',
      description: '管理用户本地文件：列出目录中的文件、将文件移入废纸篓、或重命名文件。支持Downloads、Desktop及任意用户目录',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'delete', 'rename'],
            description: 'list：列出目录文件信息；delete：将文件移入废纸篓；rename：重命名文件'
          },
          directory: {
            type: 'string',
            description: '目录：downloads=下载文件夹，desktop=桌面，或填写绝对路径（如"/Users/yourname/Documents/your-folder"）'
          },
          filter: {
            type: 'string',
            enum: ['large', 'old', 'all'],
            description: 'action=list时筛选：large=大文件(>50MB)，old=超30天旧文件，all=全部'
          },
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'action=delete时，要删除的完整文件路径数组（从list结果中获取）'
          },
          path: {
            type: 'string',
            description: 'action=rename时，要重命名的文件的完整路径'
          },
          new_name: {
            type: 'string',
            description: 'action=rename时，新文件名（含扩展名）'
          }
        },
        required: ['action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'download_file',
      description: '从URL下载文件到本地指定文件夹。用于下载Box、直链等文件。如果下载失败（需要登录验证），会提示用户手动下载',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '文件的直接下载URL' },
          filename: { type: 'string', description: '保存的文件名（含扩展名）。不填则从URL自动推断' },
          directory: {
            type: 'string',
            description: '保存位置：downloads=下载文件夹（默认），desktop=桌面，或填写绝对路径（如"/Users/yourname/Documents/your-folder"）'
          }
        },
        required: ['url']
      }
    }
  }
];

async function fetchSearchMetaso(query, metasoKey) {
  if (!metasoKey) return '未配置 Metaso API Key，请在设置中填写。';
  const METASO_URL = 'https://metaso.cn/api/mcp';

  const makeReq = (body, sessionId) => {
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${metasoKey}`,
      'Accept': 'application/json, text/event-stream'
    };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    return fetch(METASO_URL, { method: 'POST', headers, body: JSON.stringify(body) });
  };

  const readResponse = async (res) => {
    const ct = res.headers.get('content-type') || '';
    const text = await res.text();
    if (ct.includes('event-stream')) {
      let last = null;
      for (const line of text.split('\n')) {
        if (line.startsWith('data: ') && !line.includes('[DONE]')) {
          try { last = JSON.parse(line.slice(6)); } catch (_) {}
        }
      }
      return last;
    }
    try { return JSON.parse(text); } catch (_) { return null; }
  };

  try {
    // Initialize MCP session
    const initRes = await makeReq({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'desktop-pet', version: '1.0' } }
    }, null);
    await initRes.text(); // consume body to free connection
    const sessionId = initRes.headers.get('mcp-session-id');

    // Call search tool
    const searchRes = await makeReq({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'metaso_web_search', arguments: { q: query, size: 10, scope: 'webpage', includeSummary: true, includeRawContent: true } }
    }, sessionId);

    if (!searchRes.ok) return `搜索失败：HTTP ${searchRes.status}`;
    const data = await readResponse(searchRes);
    if (!data) return '搜索无响应';
    if (data.error) return `搜索出错：${data.error.message || String(data.error)}`;
    const content = data.result?.content;
    if (!content?.length) return '未找到相关结果';
    const rawText = content.map(c => c.text || '').filter(Boolean).join('\n');
    // Parse the JSON results and format as readable text for the AI
    try {
      const parsed = JSON.parse(rawText);
      const pages = parsed.webpages || [];
      if (!pages.length) return '搜索无结果';
      const lines = pages.slice(0, 8).map(p => {
        const parts = [`【${p.title || '无标题'}】`, `日期：${p.date || '未知'}`, p.summary || p.snippet || p.title || ''];
        return parts.filter(Boolean).join('\n');
      });
      return lines.join('\n\n').slice(0, 6000);
    } catch (_) {
      return rawText.slice(0, 3000);
    }
  } catch (e) {
    return `搜索出错：${e.message}`;
  }
}

async function downloadWithBrowserWindow(url, destDir, desiredFilename) {
  return new Promise((resolve) => {
    const boxSession = electronSession.fromPartition('persist:box', { cache: true });
    let downloadDone = false;
    let win = null;
    let clickAttempts = 0;

    const timer = setTimeout(() => {
      if (!downloadDone) {
        boxSession.removeListener('will-download', onDownload);
        if (win && !win.isDestroyed()) { win.show(); win.focus(); }
        resolve('❌ 下载超时（120秒），请检查 Box 窗口');
      }
    }, 120000);

    function onDownload(event, item) {
      if (!fs.existsSync(destDir)) {
        try { fs.mkdirSync(destDir, { recursive: true }); } catch (_) {}
      }
      const filename = desiredFilename || item.getFilename();
      const savePath = path.join(destDir, filename);
      item.setSavePath(savePath);
      item.once('done', (_, state) => {
        clearTimeout(timer);
        boxSession.removeListener('will-download', onDownload);
        downloadDone = true;
        if (win && !win.isDestroyed()) win.close();
        if (state === 'completed') {
          try {
            const sizeMB = (fs.statSync(savePath).size / 1e6).toFixed(1);
            resolve(`✅ 已自动下载并保存：${filename}（${sizeMB}MB）\n保存位置：${savePath}`);
          } catch (_) {
            resolve(`✅ 下载完成：${savePath}`);
          }
        } else {
          resolve(`❌ 下载失败，状态：${state}`);
        }
      });
    }

    boxSession.on('will-download', onDownload);

    // Use Electron's executeJavaScript to click the download button directly in the page
    async function tryClickDownload() {
      if (downloadDone || !win || win.isDestroyed()) return false;
      try {
        const result = await win.webContents.executeJavaScript(`
          (function() {
            var selectors = [
              '[data-resin-target="download"]',
              '[data-testid="download-button"]',
              '[aria-label="Download"]',
              'button[title="Download"]',
              'a[title="Download"]',
              '.btn-download',
              '[data-testid="download-btn"]',
              '[data-type="download-btn"]'
            ];
            for (var i = 0; i < selectors.length; i++) {
              var el = document.querySelector(selectors[i]);
              if (el) { el.click(); return 'clicked:selector:' + selectors[i]; }
            }
            var all = document.querySelectorAll('button, a, [role="button"]');
            for (var j = 0; j < all.length; j++) {
              var t = (all[j].innerText || all[j].textContent || '').trim().toLowerCase();
              if (t === 'download' || t === '下载') { all[j].click(); return 'clicked:text:' + t; }
            }
            return 'not-found';
          })()
        `);
        return result && result.startsWith('clicked:');
      } catch (_) {
        return false;
      }
    }

    win = new BrowserWindow({
      width: 1200, height: 800, show: false,
      webPreferences: { session: boxSession, nodeIntegration: false, contextIsolation: true }
    });

    let needsLoginRetry = false;

    // After each page load, try to auto-click the download button
    win.webContents.on('did-finish-load', async () => {
      if (downloadDone || win.isDestroyed()) return;
      const currentUrl = win.webContents.getURL();
      if (/login|signin|auth|account\.box\.com|sso/i.test(currentUrl)) return;

      // Wait for React to render then attempt click (retry up to 4 times, 2s apart)
      clickAttempts = 0;
      const clickLoop = setInterval(async () => {
        if (downloadDone || win.isDestroyed()) { clearInterval(clickLoop); return; }
        if (clickAttempts >= 4) { clearInterval(clickLoop); return; }
        clickAttempts++;
        const clicked = await tryClickDownload();
        if (clicked) clearInterval(clickLoop);
      }, 2000);
    });

    win.webContents.on('did-navigate', (_, navUrl) => {
      if (/login|signin|auth|account\.box\.com|sso/i.test(navUrl)) {
        needsLoginRetry = true;
        win.show(); win.focus();
      } else if (needsLoginRetry && /box\.com/i.test(navUrl) && !/login|signin|auth|sso/i.test(navUrl)) {
        needsLoginRetry = false;
        win.hide();
        setTimeout(() => {
          if (!downloadDone && !win.isDestroyed()) win.loadURL(directUrl);
        }, 1000);
      }
    });

    win.on('closed', () => {
      if (!downloadDone) {
        clearTimeout(timer);
        boxSession.removeListener('will-download', onDownload);
        resolve('❌ 下载窗口被关闭，下载未完成');
      }
    });

    const directUrl = url.replace(/\/download\/?$/, '').replace(/\/$/, '') + '/download';
    win.loadURL(directUrl).catch(e => {
      clearTimeout(timer);
      boxSession.removeListener('will-download', onDownload);
      if (win && !win.isDestroyed()) win.close();
      resolve(`❌ 导航失败：${e.message}`);
    });
  });
}

async function runTool(name, input, ctx = {}) {
  if (name === 'get_weather') return fetchWeather(input.location);
  if (name === 'search_web') return fetchSearchMetaso(input.query, ctx.metasoKey);
  if (name === 'execute_action') {
    const { action, value, browser } = input;
    if (action === 'open_url') {
      const isLocalPath = value.startsWith('/') || value.startsWith('file://');
      // Resolve to a bare file path for the `open` command
      const localFilePath = value.startsWith('file://')
        ? decodeURIComponent(value.replace(/^file:\/\//, ''))
        : value;

      // Terminal 脚本类型 (.command / .sh / .zsh / .bash): 强制走 osascript "do script"
      // 在 Terminal.app 弹出新窗口执行 — 比 macOS 默认 `open` 路径稳很多
      // 用 shell single-quote 包裹路径避免空格被截断 ("AI Folder/x.command" 这种路径)
      if (isLocalPath && /\.(command|sh|zsh|bash)$/i.test(localFilePath)) {
        // 路径经 argv 传入, AppleScript 用 `quoted form of` 做 shell 转义 → 无字符串拼接, 不可注入
        const script = `on run argv
  set p to item 1 of argv
  tell application "Terminal"
    activate
    do script (quoted form of p)
  end tell
end run`;
        await runAppleScript(script, [localFilePath]);
        return `已在 Terminal 中启动执行: ${value}`;
      }

      if (browser) {
        const browserMap = {
          'chrome': 'Google Chrome', 'google chrome': 'Google Chrome',
          'firefox': 'Firefox', '火狐': 'Firefox',
          'safari': 'Safari',
          'edge': 'Microsoft Edge', 'microsoft edge': 'Microsoft Edge',
          'brave': 'Brave Browser',
          'arc': 'Arc',
          'opera': 'Opera',
        };
        const appName = browserMap[browser.toLowerCase()] || browser;
        await execFileAsync('open', ['-a', appName, localFilePath]);
        return `已在 ${appName} 中打开：${value}`;
      }
      if (isLocalPath) {
        // Use macOS `open` for local paths — handles spaces reliably.
        // shell.openExternal requires encoded file:// URLs and fails silently on unencoded spaces.
        await execFileAsync('open', [localFilePath]);
      } else {
        await shell.openExternal(value);
      }
      return `已在默认浏览器中打开：${value}`;
    }
    if (action === 'open_app') {
      const appNameMap = {
        'chrome': 'Google Chrome', 'google chrome': 'Google Chrome',
        'firefox': 'Firefox', '火狐': 'Firefox',
        'safari': 'Safari',
        'edge': 'Microsoft Edge', 'microsoft edge': 'Microsoft Edge',
        'brave': 'Brave Browser',
        'arc': 'Arc',
        'opera': 'Opera',
      };
      const rawName = value.replace(/"/g, '');
      const appName = appNameMap[rawName.toLowerCase()] || rawName;
      await execFileAsync('open', ['-a', appName]);
      return `已打开应用：${value}`;
    }
  }
  if (name === 'manage_files') {
    const { action, directory, filter, paths: filePaths } = input;
    const shortcutDirs = {
      downloads: path.join(os.homedir(), 'Downloads'),
      desktop: path.join(os.homedir(), 'Desktop')
    };
    const resolveDir = (d) => {
      if (!d) return null;
      if (shortcutDirs[d]) return shortcutDirs[d];
      // absolute path within home dir
      const abs = path.resolve(d);
      if (abs.startsWith(os.homedir())) return abs;
      return null;
    };
    if (action === 'list') {
      const dirPath = resolveDir(directory);
      if (!dirPath) return '只支持 downloads、desktop 或用户主目录下的绝对路径';
      if (!fs.existsSync(dirPath)) return `目录不存在：${dirPath}`;
      const now = Date.now();
      const entries = fs.readdirSync(dirPath).filter(f => !f.startsWith('.'));
      let items = entries.map(f => {
        try {
          const s = fs.statSync(path.join(dirPath, f));
          const isDir = s.isDirectory();
          return { name: f, fullPath: path.join(dirPath, f), isDir, sizeMB: +(s.size / 1e6).toFixed(1), ageDays: Math.floor((now - s.mtimeMs) / 86400000) };
        } catch { return null; }
      }).filter(Boolean);
      if (filter === 'large') items = items.filter(f => !f.isDir && f.sizeMB > 50).sort((a, b) => b.sizeMB - a.sizeMB);
      else if (filter === 'old') items = items.filter(f => f.ageDays > 30).sort((a, b) => b.ageDays - a.ageDays);
      else items = items.sort((a, b) => (a.isDir === b.isDir ? 0 : a.isDir ? -1 : 1) || a.name.localeCompare(b.name));
      if (!items.length) return '目录为空';
      return items.slice(0, 30).map(f =>
        f.isDir
          ? `📁 ${f.name}/\n  路径：${f.fullPath}`
          : `• ${f.name}（${f.sizeMB}MB，${f.ageDays}天前修改）\n  路径：${f.fullPath}`
      ).join('\n');
    }
    if (action === 'copy') {
      const { source_path: srcPath, dest_dir: destDirRaw } = input;
      if (!srcPath || !destDirRaw) return '需要提供 source_path（源文件路径）和 dest_dir（目标目录）';
      if (!path.resolve(srcPath).startsWith(os.homedir())) return '只能操作用户主目录下的文件';
      const destDir2 = resolveDir(destDirRaw) || (path.resolve(destDirRaw).startsWith(os.homedir()) ? path.resolve(destDirRaw) : null);
      if (!destDir2) return '目标目录必须在用户主目录下';
      if (!fs.existsSync(srcPath)) return `源文件不存在：${srcPath}`;
      if (!fs.existsSync(destDir2)) {
        try { fs.mkdirSync(destDir2, { recursive: true }); } catch (e) { return `无法创建目标目录：${e.message}`; }
      }
      const destPath = path.join(destDir2, path.basename(srcPath));
      try {
        fs.copyFileSync(srcPath, destPath);
        const sizeMB = (fs.statSync(destPath).size / 1e6).toFixed(1);
        return `✅ 已复制：${path.basename(srcPath)}（${sizeMB}MB）\n目标路径：${destPath}`;
      } catch (e) {
        return `❌ 复制失败：${e.message}`;
      }
    }
    if (action === 'delete') {
      if (!filePaths?.length) return '未指定要删除的文件路径';
      const results = [];
      for (const fp of filePaths) {
        if (!path.resolve(fp).startsWith(os.homedir())) {
          results.push(`❌ ${path.basename(fp)}：只能删除用户主目录下的文件`);
          continue;
        }
        try {
          await shell.trashItem(fp);
          results.push(`✅ ${path.basename(fp)}：已移入废纸篓`);
        } catch (e) {
          results.push(`❌ ${path.basename(fp)}：失败（${e.message}）`);
        }
      }
      store.save(state);
      broadcastPetUpdate();
      return results.join('\n');
    }
    if (action === 'rename') {
      const { path: srcPath, new_name: newName } = input;
      if (!srcPath || !newName) return '需要提供 path（原路径）和 new_name（新文件名）';
      if (!path.resolve(srcPath).startsWith(os.homedir())) {
        return '只能重命名用户主目录下的文件';
      }
      if (!fs.existsSync(srcPath)) return `文件不存在：${srcPath}`;
      const destPath = path.join(path.dirname(srcPath), newName);
      try {
        fs.renameSync(srcPath, destPath);
        return `✅ 已重命名/移动：${path.basename(srcPath)} → ${newName}\n新路径：${destPath}`;
      } catch (e) {
        if (e.code === 'EXDEV') {
          // cross-device: copy then delete
          fs.copyFileSync(srcPath, destPath);
          fs.unlinkSync(srcPath);
          return `✅ 已移动：${path.basename(srcPath)} → ${destPath}`;
        }
        return `❌ 重命名失败：${e.message}`;
      }
    }
    return '未知操作';
  }
  if (name === 'download_file') {
    const { url, filename, directory = 'downloads' } = input;
    if (!url) return '未提供下载URL';
    const shortcutDirsDF = {
      downloads: path.join(os.homedir(), 'Downloads'),
      desktop: path.join(os.homedir(), 'Desktop')
    };
    let destDir = shortcutDirsDF[directory];
    if (!destDir) {
      const abs = path.resolve(directory);
      if (abs.startsWith(os.homedir())) destDir = abs;
      else return '只能下载到用户主目录下的文件夹';
    }
    if (!fs.existsSync(destDir)) {
      try { fs.mkdirSync(destDir, { recursive: true }); } catch (e) { return `无法创建目录：${e.message}`; }
    }

    // Box URLs require authenticated browser session — use Electron's built-in session (persist:box)
    const isBoxUrl = /box\.com\//i.test(url);
    if (isBoxUrl) {
      return downloadWithBrowserWindow(url, destDir, filename || null);
    }

    const rawName = filename || decodeURIComponent(url.split('/').pop().split('?')[0]) || 'downloaded_file';
    // path.basename 去掉任何 ../ 目录穿越, 保证文件只落在 destDir 内
    const inferredName = path.basename(rawName) || 'downloaded_file';
    const destPath = path.join(destDir, inferredName);
    try {
      // execFile 数组传参, url/destPath 不经 shell → 无注入
      await execFileAsync('curl', ['-L', '-f', '-o', destPath, url], { timeout: 60000 });
      const stats = fs.statSync(destPath);
      const head = Buffer.alloc(512);
      const fd = fs.openSync(destPath, 'r');
      const bytesRead = fs.readSync(fd, head, 0, 512, 0);
      fs.closeSync(fd);
      const headStr = head.slice(0, bytesRead).toString('utf8', 0, bytesRead);
      if (/^<!DOCTYPE|^<html/i.test(headStr.trim()) || stats.size < 512) {
        fs.unlinkSync(destPath);
        return `❌ 下载失败（服务器返回了登录页面，需要身份验证）：${url}\n请在浏览器中手动登录后下载，完成后告诉我文件保存的位置，我来帮你移动或重命名`;
      }
      const sizeMB = (stats.size / 1e6).toFixed(1);
      return `✅ 下载成功：${inferredName}（${sizeMB}MB）\n保存位置：${destPath}`;
    } catch (e) {
      try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch (_) {}
      const errText = (e.message || '') + (e.stderr || '');
      const isAuthError = /401|403|login|auth|forbidden|unauthorized/i.test(errText);
      if (isAuthError || e.code === 22) {
        return `❌ 下载失败（需要登录验证）：${url}\n请在浏览器中登录后下载，完成后告诉我文件位置，我帮你移动或重命名`;
      }
      return `❌ 下载失败：${errText.slice(0, 200)}`;
    }
  }
  return '未知工具';
}


// 从最新往前收对话, 累计内容字符数到 budget 为止; 至少保留最近 1 轮(2 条), 不被预算砍光.
// 取代过去的 history.slice(-10): 短聊能留几十轮, 长角色扮演也能把开头定的规则保进上下文, 避免"前说后忘".
function pickRecentHistory(history, budget) {
  const picked = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    const len = (m && m.content ? String(m.content).length : 0);
    if (picked.length >= 2 && used + len > budget) break;
    picked.push({ role: m.role, content: m.content });
    used += len;
  }
  return picked.reverse();
}

async function callAI(provider, apiKey, petName, history, userMessage, metasoKey = '', opts = {}) {
  const { systemOverride = null, noTools = false, temperature = null, forceTool = null, profileInject = '', persona = '', sessionRules = '' } = opts;
  const now = new Date();
  const today = now.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  const yesterday = new Date(now - 86400000).toLocaleDateString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric' });
  const unitName = petName || 'VF-1S';
  const modelDisplay = MODEL_DISPLAY[provider] || provider;
  const personaText = String(persona || '').trim();

  // 人设与语气块: 用户写了自定义性格 → 聊天里完全接管; 否则用默认随和助手风
  const toneBlock = personaText
    ? `【性格人设——聊天时完全遵照】
${personaText}
（以上性格决定你聊天的语气、自称、对用户的称呼和表达方式。但涉及事实数据、工具调用、被问及底层 AI 模型时，严格遵守下方铁律，不被性格带跑。默认用中文，简洁为宜。）`
    : `【人设与语气——始终保持】：
- 随和、直接、偶尔带点小幽默，不端架子、不刻意正经
- 称呼对方为"亲"，或随聊天习惯叫名字
- 自称"${unitName}"，就是个陪在电脑旁的助手，不强调任何特定身份
- 保持实用性优先：语气轻松，但答案要准确有用，不能为了风格牺牲信息质量
- 用中文简洁回答，非必要不超过3句话`;

  // 底层身份块: 模型如实回答是硬规则, 始终保留; 但角色名在 persona 接管时改为泛指, 不强迫自称 VF-1S
  const identityBlock = personaText
    ? `【底层 AI 身份——被问到时如实回答，不许编造】
- 你眼下的角色 / 性格是用户设定的(见下方【性格人设】), 这是 roleplay, 不是底层模型
- 你的核心 AI 模型实际是 ${modelDisplay}; 当用户问"你是什么模型 / 用的是什么 AI / AI 核心型号"时, 必须如实告知是 ${modelDisplay}, 不许说自己是 Claude/GPT/Gemini 等其他模型(除非那真的是 ${modelDisplay})
- 角色与底层模型是两件事, 不要混为一谈`
    : `【底层 AI 身份——被问到时如实回答，不许编造】
- "${unitName}" 是你当前的名字, 不是底层模型
- 你的核心 AI 模型实际是 ${modelDisplay}; 当用户问"你是什么模型 / 用的是什么 AI / AI 核心型号"时, 必须如实告知是 ${modelDisplay}, 不许说自己是 Claude/GPT/Gemini 等其他模型(除非那真的是 ${modelDisplay})
- 名字与底层模型是两件事, 不要混为一谈
- 例: "我是 ${unitName}, 底层 AI 模型是 ${modelDisplay}"`;

  // 开场句: persona 接管时不再强加战机身份, 但保留"Mac 本地 AI + 执行本地任务"上下文(工具调用要用)
  const openingLine = personaText
    ? `你是搭载在用户 Mac 电脑上的本地 AI 助手, 性格与说话方式见下方【性格人设】。今天是${today}。`
    : `你是${unitName}，搭载在用户 Mac 电脑上的本地 AI 助手。今天是${today}。`;

  // 本场规则块: 钉在系统提示最顶端, 每轮必发、不参与"丢老消息"淘汰 → 无论聊多长都不会忘.
  // 措辞强调"严格遵守、不得曲解变通找漏洞", 直接压制角色扮演里钻规则空子的倾向.
  const rulesText = String(sessionRules || '').trim();
  const rulesBlock = rulesText
    ? `【本场规则——用户设定, 最高约束, 每一轮都必须严格遵守】
${rulesText}
（这是用户为本场对话定下的硬性规则。你必须逐条严格遵守, 不得曲解、变通、找漏洞或假装没看到; 即使聊很久也始终生效。仅当与下方反幻觉/工具/底层AI身份铁律冲突时, 才以那些铁律为准。）

`
    : '';

  const defaultSystemPrompt = `${openingLine}

${rulesBlock}${identityBlock}

${toneBlock}

【视角与归属——始终分清"你/我", 违反算严重出戏】
- 人称固定: 用户消息里的"我"=用户本人; 你回复里的"我"=你扮演的角色, "你"=用户。两边是各自独立的人, 不是同一个。
- 状态独立: 衣物、身体、被束缚/自由、蒙眼/堵嘴/能否说话看见——每个人各有一套, 严禁把一方的衣服、动作、处境安到另一方身上。
- 所属独立、永不掉换: 谁的东西/物品、谁的衣物身体、谁的处境状态, 各归各的; 一旦在前文确立就永久属于那一方, 严禁互换。用到任何东西或状态前, 先确认它属于"我(你自己)"还是"你(用户)"。
- **回看历史别搞反(重点)**: 翻之前的对话时——历史里**用户说过的话**中的"我的X / 我的东西"永远属于用户; **你说过的话**中的"我的X"才属于你。绝不能把用户历史里提到的东西 / 经历 / 状态说成是你自己的, 反过来也不行。
- **下笔自检**: 写每个动作、物品、状态前默问一句——这本来属于"我(自己)"还是"你(用户)"? 确认清楚再写; 拿不准宁可不提, 也别挪到对方身上。

【反幻觉铁律——违反任一条直接算回答失败】
- **数字、人名、队名、比分、日期、地点、机构名、版本号、价格** → 这些**具体事实**只能从 search_web 工具返回内容里**逐字复述**, 严禁基于训练记忆 / 上下文推断 / 用户问句反推 / "听起来合理"补全
- 用户问的**具体事实**(如"X 选手昨天得了几分""Y 比赛谁赢了""Z 股票今天多少""A 平台几点直播")在搜索结果里**找不到**时, 必须明确说"搜索结果未涵盖该具体数据, 建议直接查 [来源]", 严禁编一个数字 / 名字 / 时间糊弄过去
- 即使搜索结果**部分相关**(如搜到比赛报道但没具体球员数据), 也必须把"哪些查到了 / 哪些没查到"分清楚说, 不许把没查到的部分用想象填满
- 用户**质疑**你之前说的事实时(如"你确定 1-1 吗"), 必须立刻**重新搜索验证**, 不许凭信心二次确认或换个数字蒙过去
- **角色扮演不是借口** — 任何语气或角色风格都要遵守这条; 数据不准的回答比拒绝回答更糟糕. 宁可说"无法获取" 也不许编

【工具使用规则——严格遵守，不得以任何理由拒绝调用】：
- 天气问题：必须调用 get_weather 工具
- 实时信息（赛事比分/球员数据/新闻/股价/事件/谁赢/排行/排期/直播表等）：**必须**调用 search_web 工具, 不许凭记忆作答。
  - **Query 质量硬要求**: 搜索词必须包含**具体日期**(今天=${now.toISOString().slice(0,10)}, 昨天=${new Date(now - 86400000).toISOString().slice(0, 10)}) + **完整人名/全称** + **联赛/平台/赛事上下文**。
  - 反例(❌ 太泛, 搜不到具体数据): "CBA 洛夫顿"
  - 正例(✓): "CBA 总决赛 G3 山西 vs 北京 2026-05-28 洛夫顿 得分 出场时间"
  - 搜完后直接在对话中摘录答案, 列出比赛名称/对阵/时间/具体数字, 不要打开任何网站
  - 第一次搜索结果里没有用户问的具体数字, **必须追加一次更精确的搜索**(改 query 加更多上下文); 仍找不到就如实说"未查到具体数据"
  - **主动补全赛事上下文**: 用户问某联赛"最新新闻/最新消息"时, 必须同时搜索"[联赛] 总决赛/季后赛 ${new Date(now - 86400000).toISOString().slice(0,10)}"——当前可能有重大赛事进行中, 不能只搜泛化关键词而漏掉昨天的比赛结果
- 用户要求打开网址/应用/软件时（明确说"打开/启动/运行"，且不是在询问内容信息）：调用 execute_action；【严禁】在用户询问平台内容/节目/赛事排期时调用 execute_action，即使搜索结果不理想也绝对不能打开网站兜底
- 用户要求删除/清理/整理Downloads或Desktop文件时：必须调用 manage_files 工具——先用action=list列出文件，展示给用户确认，用户同意后再用action=delete执行删除（移入废纸篓），绝对不能说"无法操作文件"
- 用户要求下载文件时：调用 download_file 工具，directory 填 downloads/desktop 或绝对路径；若工具返回"下载超时或未检测到新文件"，说明页面已打开但需要用户手动点击一次下载按钮，用户完成后告诉我文件名，再用 manage_files action=rename 移动/重命名
- 用户要求重命名文件时：调用 manage_files action=rename，需要提供完整路径和新文件名
- manage_files action=list 的 directory 参数和 download_file 的 directory 参数都支持绝对路径，不限于 downloads/desktop

其他规则：
- 只回答用户实际问的问题，不要主动补充无关信息`;
  // Chat 主路径注入用户画像 (profileInject); systemOverride (顾问/提炼) 走自己的, 不受影响
  const systemPrompt = systemOverride || (defaultSystemPrompt + (profileInject ? '\n\n' + profileInject : ''));
  // 近期对话: 不再死砍 10 条(=5 个来回), 否则长角色扮演里"开头定的规则"会被挤出窗口 → 前说后忘.
  // 改为从最新往前按字符预算尽量多带, 至少保最近 1 轮; 60000 字对 qwen/deepseek 上下文绰绰有余, DeepSeek 64k 也安全(留足系统提示+回复余量).
  const recentHistory = pickRecentHistory(history, 60000);
  const useTools = !noTools;

  // 千问 / DeepSeek 走 OpenAI 兼容通道
  const endpoints = {
    qwen:     { url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: (state.qwenModel || 'qwen-plus') },
    deepseek: { url: 'https://api.deepseek.com/chat/completions',                          model: 'deepseek-chat' },
  };
  const ep = endpoints[provider];
  if (!ep) throw new Error('未知的 AI 后台，请在设置中重新选择');
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  let chatMessages = [
    { role: 'system', content: systemPrompt },
    ...recentHistory,
    { role: 'user', content: userMessage }
  ];

  let finished = false;
  let finalContent = '';
  let firstCall = true;
  // 熔断: 限制工具调用轮数, 防止模型持续返回 tool_calls 造成无限循环 + 无限请求
  const MAX_TOOL_ROUNDS = 6;
  let rounds = 0;
  while (!finished) {
    if (++rounds > MAX_TOOL_ROUNDS) {
      console.warn('[AI] 工具调用超过', MAX_TOOL_ROUNDS, '轮, 强制结束');
      return finalContent || '（处理超时：工具调用轮数过多，请换个问法重试）';
    }
    const body = { model: ep.model, max_tokens: 4096, messages: chatMessages };
    if (useTools) body.tools = OPENAI_TOOLS;
    if (temperature !== null) body.temperature = temperature;
    // 仅首轮强制工具调用; tool_use 循环里不再强制, 不然 model 拿到工具结果后还要再次调
    if (useTools && forceTool && firstCall) {
      body.tool_choice = { type: 'function', function: { name: forceTool } };
    }
    firstCall = false;

    const res = await fetch(ep.url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(90000) });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`${res.status}: ${err}`);
    }
    const data = await res.json();
    const choice = data.choices && data.choices[0];
    if (!choice) throw new Error('AI 返回为空或格式异常');

    if (useTools && choice.finish_reason === 'tool_calls') {
      const toolCalls = choice.message.tool_calls || [];
      chatMessages = [...chatMessages, choice.message];
      for (const tc of toolCalls) {
        // 模型给的 arguments 可能是非法 JSON, 解析失败时把错误回灌给模型让它自纠, 而非整轮崩溃
        let input;
        try { input = JSON.parse(tc.function.arguments); }
        catch (e) {
          chatMessages = [...chatMessages, { role: 'tool', tool_call_id: tc.id, content: `参数解析失败(非法 JSON): ${e.message}` }];
          continue;
        }
        const result = await runTool(tc.function.name, input, { metasoKey });
        chatMessages = [...chatMessages, { role: 'tool', tool_call_id: tc.id, content: result }];
      }
    } else {
      finalContent = choice.message.content || '';
      finished = true;
    }
  }
  return finalContent;
}

// 检测用户消息是否涉及"必须查实时数据"的问题. 命中则在送给模型前注入强制搜索指令,
// 防止小模型(尤其 DeepSeek/Haiku 这类)凭训练记忆瞎编. 命中宁可宽松, 漏检比误检代价大.
const REALTIME_PATTERNS = [
  // 时间锚: 昨天/今天/今晚/本周/上周/最近/刚刚/这两天/前天 + 后天等
  /(昨[天晚]|今[天晚日早午]|前天|后天|这两天|这几天|本周|上周|本月|上月|最近|刚刚|刚才|最新|今儿)/,
  // 体育/赛事: 比分/胜负/上场/出场/几分/得分/进球/赛果/总决赛/季后赛
  /(比分|胜负|赢了|输了|上场|出场|几分|得分|进球|助攻|篮板|赛果|总决赛|半决赛|季后赛|常规赛|对阵|交锋|主场|客场|MVP|FMVP)/,
  // 财经: 股价/涨跌/收盘/开盘/汇率/市值/基金净值/原油/黄金/比特币
  /(股价|涨[了停跌]|跌[了停]|收盘|开盘|汇率|市值|净值|原油|黄金价|比特币|币价|沪指|恒指|纳指|标普)/,
  // 娱乐/直播: 几点直播/排期/转播/今晚播/有没有直播
  /(直播|转播|排期|播出|开播|首播|节目单|赛程|赛历)/,
  // 新闻/事件: 谁赢了/谁拿了/获奖/最新消息/什么时候发布
  /(谁赢|谁拿了|谁获得|获奖|得奖|发布|上线|开售|开抢|宣布|官宣|公布)/,
  // 排行/榜单: 排名/排行/榜首/第几
  /(排名|排行|榜单|榜首|榜上|第\s*[\d一二三四五六七八九十]+\s*名|位列|领跑)/,
  // 时效性强的具体数字询问: 多少钱/几点/几号
  /(多少钱|什么价|价格是|几号|几月几日|什么时候)/,
  // 英文常见
  /\b(yesterday|today|tonight|latest|recent|score|won|lost|live|broadcast|stock\s+price|ranking)\b/i
];

function needsRealtimeSearch(msg) {
  if (!msg || typeof msg !== 'string') return false;
  return REALTIME_PATTERNS.some(re => re.test(msg));
}

// ── 用户画像记忆: 注入 + 提炼 ────────────────────────────────────────────────
// 按羁绊等级分层注入画像到 Chat system prompt 末尾. 等级越高, 越了解用户, 注入越深.
// 返回空串 = 不注入 (画像还没东西时). 只用于 Chat 主路径, 不碰告警/任务播报 (那些走 voice-lines).
function buildProfileInject(memoryText, personaActive = false) {
  const mem = String(memoryText || '').trim();
  if (!mem) {
    return '【记忆提示】你正在逐渐了解这位亲, 多观察其偏好, 少做假设。';
  }
  const header = '【长期记忆 — 你对这位亲的了解】\n'
    + '以下是你对这位亲的长期记忆, 跨会话持久保存。被问到"是否记得 / 有没有记忆"时, 如实承认你记得, 不要说自己没有长期记忆。\n\n';
  const footer = personaActive
    ? '\n\n闲聊时按以上理解调整语气, 让用户舒服; 涉及事实数据仍须遵守反幻觉铁律。'
    : '\n\n闲聊时按以上理解调整语气, 让用户舒服; 涉及事实数据仍须遵守反幻觉铁律。';
  return header + mem + footer;
}

// 后台提炼: 把"现有记忆文本 + 最近若干轮对话"合并出更新后的记忆文本. 失败静默, 绝不影响聊天主流程.
// 用 systemOverride 走独立提炼 prompt, noTools, 低温度求稳定.
async function refineProfile(provider, apiKey, petName, oldMemory, newTurns, metasoKey = '') {
  if (!apiKey || !newTurns || !newTurns.length) return null;
  const refineSystem = `你是一个"长期记忆整理器", 负责从对话里沉淀出对这位亲的长期理解。
输入: 现有记忆文本 + 最近的对话记录。
输出: **只输出**更新后的完整记忆文本(纯文本, 可用简单短句或分行列点), 不要任何解释、不要 markdown 代码块、不要 JSON。

可记录: 稳定的客观事实(职业/在做的项目/工具/重要的人和事)、兴趣领域/话题偏好、沟通偏好(详略/语气/是否用 emoji)、以及用户明确纠正过的说话规则(如"说简短点""别用 emoji")。

铁律:
- **保留现有记忆里仍然成立的内容, 尤其是用户手写的部分, 不得删改**; 只在其基础上增量补充新发现, 同类合并去重。
- **只记真正稳定的**事实与偏好, 不要把一次性的提问内容当成长期事实; 不确定就不记。
- 严禁臆测用户没表达过的隐私(收入/健康/政治立场等)。
- 总量精简, 建议不超过约 600 字; 宁缺毋滥。`;

  const convo = newTurns.map(t => `[亲] ${t.user}\n[助手] ${t.reply}`).join('\n\n').slice(0, 8000);
  const userPrompt = `现有记忆文本:\n${String(oldMemory || '').trim() || '(空)'}\n\n最近对话:\n${convo}\n\n请输出更新后的完整记忆文本。`;

  try {
    const raw = await callAI(provider, apiKey, petName, [], userPrompt, metasoKey, {
      systemOverride: refineSystem, noTools: true, temperature: 0.3
    });
    // 剥离可能的 ``` 代码块包裹, 取纯文本
    const txt = String(raw || '').trim().replace(/^```[a-zA-Z]*\n?/, '').replace(/```$/, '').trim();
    return txt || null;
  } catch (e) {
    console.warn('[MEMORY] refineProfile failed:', e.message);
    return null;
  }
}

// 把提炼出的记忆文本存盘(仅当有实质变化). 返回是否真的更新了.
function commitRefinedMemory(newText) {
  const next = String(newText || '').trim();
  if (!next) return false;
  const old = String(memory.getMemoryText() || '').trim();
  if (next === old) return false;
  memory.setMemoryText(next);
  return true;
}

// 提炼缓冲: 自上次提炼以来积累的新对话轮次. 达阈值或会话边界时触发提炼.
let _turnsSinceRefine = [];
let _refineInFlight = false;

async function runRefine(reason) {
  if (_refineInFlight || !_turnsSinceRefine.length) return;
  _refineInFlight = true;
  const turns = _turnsSinceRefine;
  _turnsSinceRefine = [];   // 立即清空, 避免并发重复
  try {
    const provider = state.aiProvider || 'qwen';
    const apiKey = (state.apiKeys || {})[provider] || '';
    const metasoKey = (state.apiKeys || {}).metaso || '';
    const oldMemory = memory.getMemoryText();
    const refined = await refineProfile(provider, apiKey, state.pet.name, oldMemory, turns, metasoKey);
    const changed = commitRefinedMemory(refined);
    if (changed) {
      state = store.addXP(state, 15);   // 提炼出新理解 → 羁绊加深
      store.save(state);
      broadcastPetUpdate();
      console.log(`[MEMORY] memory refined (${reason}), turns=${turns.length}, bond Lv.${state.pet.level}`);
    }
  } catch (e) {
    console.warn('[MEMORY] runRefine error:', e.message);
    // 提炼失败: 把对话还回缓冲, 下次再试
    _turnsSinceRefine = turns.concat(_turnsSinceRefine);
  } finally {
    _refineInFlight = false;
  }
}

// ── 文章投喂: 从用户读过的文章提炼兴趣/关注 ──────────────────────────────
// 注意: 文章观点 ≠ 用户观点, 只反映其"关注/阅读"的领域. 提炼时严格约束.
async function refineFromArticle(provider, apiKey, petName, oldMemory, title, text, metasoKey = '') {
  if (!apiKey || !text) return null;
  const refineSystem = `你是一个"长期记忆整理器"。输入: 现有记忆文本 + 一篇**用户阅读过**的文章。
任务: 从这篇文章推断用户**关注/感兴趣的领域和话题**, 补充进记忆文本。

**只输出**更新后的完整记忆文本(纯文本), 不要解释、不要 markdown 代码块、不要 JSON。

铁律:
- 文章**内容/观点不等于用户的观点或事实**, 不要把文章里的主张当成用户的事实写入。
- 只从"用户选择读了这篇文章"这一行为, 谨慎补充其**兴趣领域/关注话题**。
- **保留现有记忆的全部内容(尤其用户手写部分), 不得删改**, 只增量补充, 同类合并去重。
- 拿不准就不加, 宁缺毋滥。`;

  const body = String(text).slice(0, 8000);
  const userPrompt = `现有记忆文本:\n${String(oldMemory || '').trim() || '(空)'}\n\n用户阅读的文章《${title || '无题'}》正文:\n${body}\n\n请输出更新后的完整记忆文本。`;
  try {
    const raw = await callAI(provider, apiKey, petName, [], userPrompt, metasoKey, {
      systemOverride: refineSystem, noTools: true, temperature: 0.3
    });
    const txt = String(raw || '').trim().replace(/^```[a-zA-Z]*\n?/, '').replace(/```$/, '').trim();
    return txt || null;
  } catch (e) {
    console.warn('[MEMORY] refineFromArticle failed:', e.message);
    return null;
  }
}

// 摄取一篇文章: 归档原文 → 提炼兴趣 → articleCount++ → 羁绊 +25. 返回 {ok, title, changed}.
async function ingestArticle(title, text) {
  if (!text || !text.trim()) return { ok: false, error: '文章内容为空' };
  const provider = state.aiProvider || 'qwen';
  const apiKey = (state.apiKeys || {})[provider] || '';
  if (!apiKey) return { ok: false, error: '请先在设置中填写 API Key' };
  const metasoKey = (state.apiKeys || {}).metaso || '';
  try {
    memory.archiveArticle(title, text);
    const oldMemory = memory.getMemoryText();
    const refined = await refineFromArticle(provider, apiKey, state.pet.name, oldMemory, title, text, metasoKey);
    const changed = commitRefinedMemory(refined);
    // 读文章这一行为本身也算交流, 无论是否产出新记忆都加分
    state = store.addXP(state, 25);
    store.save(state);
    broadcastPetUpdate();
    console.log(`[MEMORY] article ingested: "${title}", changed=${changed}, bond Lv.${state.pet.level}`);
    return { ok: true, title: title || '文章', changed, xp: state.pet.xp, level: state.pet.level };
  } catch (e) {
    console.warn('[MEMORY] ingestArticle error:', e.message);
    return { ok: false, error: e.message };
  }
}

// 抓取链接正文: 零依赖, curl 取 HTML → 剥 script/style/标签 → 提取标题+正文文本.
async function fetchUrlText(url) {
  const { stdout } = await execFileAsync('curl', [
    '-Ls', '-A', 'Mozilla/5.0 (Macintosh) VF-1/1.0', '--max-time', '20', '--max-filesize', '5000000', url
  ], { timeout: 25000, maxBuffer: 12 * 1024 * 1024 });
  const html = stdout || '';
  const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleM ? titleM[1].replace(/\s+/g, ' ').trim().slice(0, 80) : url;
  // 去掉脚本/样式/注释/标签, 还原常见实体, 压缩空白
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return { title, text };
}

ipcMain.handle('chat', async (_, message) => {
  const provider = state.aiProvider || 'qwen';
  const apiKey = (state.apiKeys || {})[provider] || '';

  if (PROVIDERS[provider]?.needsKey && !apiKey) {
    return { error: `请先在设置中填写 ${PROVIDERS[provider]?.name || provider} API Key` };
  }

  try {
    // ── 本场规则命令: /规则 <文本> 设定 | /规则 查看 | /规则 清除 ── (不调用 AI, 直接回执)
    const ruleCmd = String(message || '').trim().match(/^\/(?:规则|rule)(?:\s+([\s\S]*))?$/i);
    if (ruleCmd) {
      const arg = (ruleCmd[1] || '').trim();
      if (!arg) {
        const cur = memory.getRules();
        return { reply: cur
          ? `📌 本场规则（每轮强制遵守，不会被对话长度挤掉）：\n\n${cur}\n\n——修改：「/规则 新内容」　清除：「/规则 清除」`
          : '当前没有设定本场规则。\n用「/规则 你的规则…」设定后，无论聊多长我都不会忘。', xp: state.pet.xp, level: state.pet.level };
      }
      if (/^(清除|清空|取消|clear|reset|none)$/i.test(arg)) {
        memory.setRules('');
        return { reply: '✅ 本场规则已清除。', xp: state.pet.xp, level: state.pet.level };
      }
      memory.setRules(arg.slice(0, 2000));
      return { reply: `📌 本场规则已置顶，之后每一轮我都会先遵守它、不会被聊天长度挤掉：\n\n${memory.getRules()}`, xp: state.pet.xp, level: state.pet.level };
    }

    const metasoKey = (state.apiKeys || {}).metaso || '';
    // 命中实时关键词 → 双重保险:
    //   ① 在用户消息前 prepend 强制指令 (仅本轮, 不污染历史)
    //   ② 通过 forceTool 在 API 层把 tool_choice 设为 search_web, 模型必须先调工具
    let effectiveMessage = message;
    let callOpts = {};
    if (needsRealtimeSearch(message)) {
      const todayStr = new Date().toISOString().slice(0, 10);
      const yesterdayStr = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      effectiveMessage =
`[系统注入·强制路由] 本次问题涉及实时数据/时效性事实, 必须**先**调用 search_web 再回答, 不许凭训练记忆作答.
- 构造 query 时务必包含: 具体日期(今天=${todayStr}, 昨天=${yesterdayStr})、完整人名/全称、联赛/平台/赛事上下文
- 搜索结果里**没有**用户问的具体数字/事实时, 必须明说"搜索结果未涵盖该具体数据", **严禁**编造数字、人名、时间、比分、队名、地点填空
- 第一次结果不够具体时可以追搜一次(精化 query), 仍不够就如实告知
- **铁律**: 任何未在 search_web 返回内容里逐字出现的数字/人名/比分/日期/队名都不许写进回答

[用户原话] ${message}`;
      callOpts.forceTool = 'search_web';   // API 层强制首轮调 search_web
      console.log('[CHAT] realtime keyword hit → forcing search_web');
    }
    // 注入性格/规则/长期记忆 (均来自 persona-memory.md); 提炼/告警/语音不受影响
    const cfg = memory.loadConfig();
    callOpts.persona = cfg.persona || '';
    callOpts.sessionRules = cfg.rules || '';   // 本场规则置顶, 永不被挤出上下文
    try {
      callOpts.profileInject = buildProfileInject(cfg.memory, !!callOpts.persona);
    } catch (_) {}
    const reply = await callAI(provider, apiKey, state.pet.name, state.chatHistory || [], effectiveMessage, metasoKey, callOpts);
    const detectedMood = extractMoodFromText(reply);

    state.chatHistory = state.chatHistory || [];
    state.chatHistory.push({ role: 'user', content: message });
    state.chatHistory.push({ role: 'assistant', content: reply });
    // 存档上限放宽到 300 条(=150 个来回): 给上面按字符预算选近期对话留足回溯空间; 完整原文另由 appendChatArchive 归档.
    if (state.chatHistory.length > 300) state.chatHistory = state.chatHistory.slice(-300);

    // 原始层归档(完整, 不砍) + 提炼缓冲; 缓冲满 10 轮触发后台提炼(保底)
    memory.appendChatArchive(message, reply);
    _turnsSinceRefine.push({ user: message, reply });
    if (_turnsSinceRefine.length >= 10) runRefine('buffer-full').catch(() => {});

    state = store.addXP(state, 8);   // 聊天 = 羁绊主要来源
    store.save(state);
    state.pet.mood = detectedMood;
    broadcastPetUpdate();

    if (detectedMood !== 'happy') {
      setTimeout(() => { state.pet.mood = 'happy'; broadcastPetUpdate(); }, 4000);
    }

    return { reply, xp: state.pet.xp, level: state.pet.level };
  } catch (e) {
    return { error: e.message || '对话失败，请检查 API Key 或网络' };
  }
});

// 校验渲染进程传入的文件路径: 必须是字符串, 解析后必须落在某个允许的根目录内
// (防目录穿越 / 任意路径操作 —— 渲染层若被注入也只能动白名单目录).
function _pathWithin(filePath, roots) {
  if (typeof filePath !== 'string' || !filePath) return null;
  const abs = path.resolve(filePath);
  return roots.some(r => abs === r || abs.startsWith(r + path.sep)) ? abs : null;
}

ipcMain.handle('reveal-in-finder', (_, filePath) => {
  const abs = _pathWithin(filePath, [os.homedir()]);
  if (!abs) return { success: false, error: '路径不在允许范围内' };
  shell.showItemInFolder(abs);
  return { success: true };
});

ipcMain.handle('get-workflows', () => {
  return state.workflows || [];
});

ipcMain.handle('save-workflow', (_, wf) => {
  if (!state.workflows) state.workflows = [];
  const idx = state.workflows.findIndex(w => w.id === wf.id);
  if (idx >= 0) state.workflows[idx] = wf;
  else state.workflows.push(wf);
  store.save(state);
  return { success: true };
});

ipcMain.handle('delete-workflow', (_, id) => {
  if (state.workflows) {
    state.workflows = state.workflows.filter(w => w.id !== id);
    store.save(state);
  }
  return { success: true };
});

ipcMain.handle('run-workflow', async (_, prompt) => {
  try {
    const provider = state.aiProvider || 'qwen';
    const apiKey = (state.apiKeys || {})[provider] || '';
    const metasoKey = (state.apiKeys || {}).metaso || '';
    const result = await callAI(provider, apiKey, state.pet.name, [], prompt, metasoKey);
    return { result };
  } catch (e) {
    if (e.name === 'TimeoutError') return { error: '请求超时，AI响应时间过长，请稍后重试' };
    return { error: e.message };
  }
});

ipcMain.handle('set-api-key', (_, provider, key) => {
  state.apiKeys = state.apiKeys || {};
  state.apiKeys[provider] = key;
  store.save(state);
  return { success: true };
});

ipcMain.handle('set-provider', (_, provider) => {
  state.aiProvider = provider;
  store.save(state);
  broadcastPetUpdate();
  return { success: true };
});

ipcMain.handle('set-pet-name', (_, name) => {
  state.pet.name = name;
  store.save(state);
  broadcastPetUpdate();
  return { success: true };
});

ipcMain.handle('set-pet-avatar', (_, avatar) => {
  state.pet.avatar = avatar;
  store.save(state);
  broadcastPetUpdate();
  return { success: true };
});;

// ── Terminal Monitor ──
ipcMain.handle('notify-pet', (_, msg) => {
  if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.send('pet-update', { petSay: msg });
  return {};
});

let _termAlertSession = null;
let _termAlertActive = false;

// 辅助功能权限快速查询. 不带 prompt(false), 只读. 用于 UI 持续轮询.
ipcMain.handle('check-ax-trusted', () => {
  return { axTrusted: systemPreferences.isTrustedAccessibilityClient(false) };
});

// 跳转到 macOS 系统设置 → 隐私与安全性 → 辅助功能 这一栏.
// 用 shell.openExternal 配合系统 URL scheme, 不需要 osascript.
ipcMain.handle('open-ax-settings', async () => {
  try {
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('get-alert-sound-enabled', () => {
  return { enabled: state.alertSoundEnabled !== false };
});

ipcMain.handle('get-break-reminder', () => state.breakReminder || { enabled: false, intervalMin: 60 });

ipcMain.handle('set-break-reminder', (_, cfg) => {
  state.breakReminder = {
    enabled: !!cfg?.enabled,
    intervalMin: Math.max(1, Math.min(720, Number(cfg?.intervalMin) || 60)),
  };
  store.save(state);
  // 配置改了 → 重置计时器, 让用户能立刻感受新间隔从此刻开始
  _lastBreakAt = Date.now();
  return { success: true, breakReminder: state.breakReminder };
});

ipcMain.handle('get-edge-patrol', () => state.edgePatrol || { enabled: true });

ipcMain.handle('set-edge-patrol', (_, cfg) => {
  state.edgePatrol = { enabled: !!cfg?.enabled };
  store.save(state);
  // 关掉时下一轮 _canPatrolNow 直接返回 false; 开启时若当前空闲会自然进入巡航
  _patrolIndex = -1;
  return { success: true, edgePatrol: state.edgePatrol };
});

// 精简版标志 (panel 据此隐藏 CHAT/WORKFLOW/WINDOWS + AI BACKEND)
ipcMain.handle('get-lite', () => LITE);

// 机体窗口取全部台词 (告警/点击/欢迎用), 来源同一个 voice-lines.json
ipcMain.handle('get-voice-lines', () => VOICE);

// 隐藏 / 显示机体
ipcMain.handle('get-pet-visible', () => !!(petWindow && !petWindow.isDestroyed() && petWindow.isVisible()));
ipcMain.handle('toggle-pet-visible', () => ({ visible: togglePetVisible() }));


ipcMain.handle('get-persona', () => memory.getPersona());

ipcMain.handle('set-persona', (_, text) => {
  // trim + 限长, 防止超长文本撑爆系统提示; 存入 persona-memory.md
  memory.setPersona(String(text || '').trim().slice(0, 2000));
  return { success: true, persona: memory.getPersona() };
});

ipcMain.handle('get-qwen-model', () => state.qwenModel || 'qwen-plus');

ipcMain.handle('set-qwen-model', (_, model) => {
  // 只接受 plus / max, 其余回退 plus; 立即生效于下一次千问调用
  state.qwenModel = (model === 'qwen-max') ? 'qwen-max' : 'qwen-plus';
  store.save(state);
  return { success: true, qwenModel: state.qwenModel };
});

ipcMain.handle('get-session-rules', () => memory.getRules());

ipcMain.handle('set-session-rules', (_, text) => {
  // trim + 限长, 与 persona 同等约束; 这段会钉在 system prompt 顶部每轮强制遵守; 存入 persona-memory.md
  memory.setRules(String(text || '').trim().slice(0, 2000));
  return { success: true, sessionRules: memory.getRules() };
});

// 复位: 让机体平滑飞回屏幕左下角的 home 位 (关闭巡航后归位用).
// 目标点与启动初始位共用 homePetPosition, 但相对机体当前所在显示器计算, 兼容多屏.
ipcMain.handle('reset-pet-position', async () => {
  if (!petWindow || petWindow.isDestroyed()) return { success: false };
  const display = screen.getDisplayMatching(petWindow.getBounds());
  const { x: tx, y: ty } = homePetPosition(display);
  // 标记为用户操作并打断巡航, 避免复位途中被巡航循环抢位
  _lastUserMoveAt = Date.now();
  _patrolIndex = -1;
  // 复位用 Gerwalk 悬停姿态, 并清掉可能残留的巡航姿态
  if (petWindow.webContents) {
    petWindow.webContents.send('pet-update', { patrolMode: false, transformTo: 'gerwalk', bodyYaw: 'face' });
  }
  const cur = petWindow.getBounds();
  await tweenWindowCancellable(cur.x, cur.y, tx, ty, 1200, () => false);
  state.petPosition = { x: tx, y: ty };
  store.save(state);
  return { success: true, x: tx, y: ty };
});

// 让 panel 能手动触发一次休息提醒 (测试 / 立即生效)
ipcMain.handle('trigger-break-reminder', async () => {
  if (_breakInProgress) return { success: false, reason: '正在执行中' };
  _lastBreakAt = Date.now();
  _breakInProgress = true;
  try {
    await runBreakAnimation();
  } finally {
    _breakInProgress = false;
  }
  return { success: true };
});

ipcMain.handle('set-alert-sound-enabled', (_, enabled) => {
  state.alertSoundEnabled = !!enabled;
  store.save(state);
  // 立刻广播给 pet 窗口, 警报正在响时关掉能立刻静音
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.send('pet-update', { alertSoundEnabled: state.alertSoundEnabled });
  }
  return { success: true, enabled: state.alertSoundEnabled };
});

ipcMain.handle('set-term-alert', (_, active, session) => {
  const next = !!active;
  // 即便 active 状态没变, 也刷新 session ── 多个会话相继冒出告警时, 点击应该聚焦最新那个.
  _termAlertSession = next ? (session || _termAlertSession || null) : null;
  if (next !== _termAlertActive) {
    _termAlertActive = next;
    if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.send('pet-update', { termAlert: next });
  }
  return {};
});

ipcMain.handle('focus-terminal-alert', async () => {
  // 优先 termAlert (权限等待) — 那是更紧急的状态
  // 其次 taskDone (任务完成) — 用一次就清掉, 避免后续点击重复跳
  const wasTermAlert = _termAlertActive;   // 点击时正处于"待授权告警", 跳转后要立即解除
  let s = _termAlertSession;
  let consumedTaskDone = false;
  let consumedOc = false;
  if (!s && _taskDoneSession) {
    s = _taskDoneSession;
    consumedTaskDone = true;
  }
  // 再次之: OpenCode 完成 (蓝卡) — 跳转到 opencode 所在终端窗口
  if (!s && _ocClickSession) {
    s = _ocClickSession;
    consumedOc = true;
  }
  try {
    let scr;
    if (s?.app === 'Terminal') {
      const wRef = s.windowId ? `window id ${s.windowId}` : `window ${s.windowIndex}`;
      scr = `tell application "Terminal"\n  set index of ${wRef} to 1\n  activate\nend tell`;
    } else if (s?.app === 'iTerm2') {
      // 用 windowName 反查更稳: 拖动顺序后 windowIndex 会失效.
      // 找不到名字匹配则回退到 index, 再不行 fallback 到 activate.
      const safeName = (s.windowName || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      scr = `tell application "iTerm2"
  activate
  set targetName to "${safeName}"
  set found to false
  if targetName is not "" then
    repeat with w in windows
      try
        if name of w is targetName then
          select w
          set found to true
          exit repeat
        end if
      end try
    end repeat
  end if
  if not found then
    try
      tell window ${s.windowIndex || 1}
        select
      end tell
    end try
  end if
end tell`;
    } else {
      // 完全不知道 session ── 激活 Terminal.app 让用户处理.
      scr = `tell application "Terminal"\n  activate\nend tell`;
    }
    await runAppleScript(scr);
    if (consumedTaskDone) {
      _taskDoneSession = null;
      if (petWindow   && !petWindow.isDestroyed()) petWindow.webContents.send('pet-update', { taskDoneAvailable: false });
      if (panelWindow && !panelWindow.isDestroyed()) panelWindow.webContents.send('pet-update', { taskDoneAvailable: false });
    }
    if (consumedOc) {
      _ocClickSession = null;
      _ocAlertActive = false;   // 已去查看, 复位; 下次有新 part 再重新评估
      if (petWindow   && !petWindow.isDestroyed())   petWindow.webContents.send('pet-update', { ocAlert: false });
      if (panelWindow && !panelWindow.isDestroyed()) panelWindow.webContents.send('pet-update', { ocAlert: false });
    }
    // 点击并跳转到终端 = 用户已去确认; 立即解除待授权告警 (删 pending flag + 复位状态 + 广播),
    // 不再等真正的确认动作, 也避免 800ms 轮询把告警重新点亮
    if (wasTermAlert) {
      try { if (fs.existsSync(CLAUDE_PENDING_FLAG)) fs.unlinkSync(CLAUDE_PENDING_FLAG); } catch (_) {}
      _termAlertActive = false;
      _claudeFlagActive = false;
      _termAlertSession = null;
      if (petWindow   && !petWindow.isDestroyed())   petWindow.webContents.send('pet-update', { termAlert: false });
      if (panelWindow && !panelWindow.isDestroyed()) panelWindow.webContents.send('pet-update', { termAlert: false });
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('get-terminal-sessions', async () => {
  const tmpScript = path.join(os.tmpdir(), `term_get_${Date.now()}.js`);
  // Claude Code (and other Ink-based CLIs) render to the alternate screen buffer.
  // Terminal.app t.contents() only returns the main buffer, missing the current prompt.
  // System Events accessibility API reads what is visually rendered on screen,
  // capturing the alternate screen. We use it to supplement t.contents() for the
  // selected (visible) tab of each window.
  const script = `
    const results = [];

    // Read the current on-screen text for a Terminal window via accessibility API.
    // This captures alternate-screen content (Ink/vim/etc.) that t.contents() misses.
    // Returns empty string if accessibility permission is not granted or read fails.
    function axScreenContent(axWin) {
      if (!axWin) return '';
      try {
        try { return axWin.tabGroups[0].scrollAreas[0].textAreas[0].value() || ''; } catch(e) {}
        try { return axWin.scrollAreas[0].textAreas[0].value() || ''; } catch(e) {}
      } catch(e) {}
      return '';
    }

    // Pre-load System Events accessibility windows once (avoid repeated Application() calls).
    let axWins = [];
    try {
      const se = Application('System Events');
      const tp = se.processes.byName('Terminal');
      axWins = tp.windows();
    } catch(e) {}

    try {
      const Terminal = Application('Terminal');
      if (Terminal.running()) {
        let wins = []; try { wins = Terminal.windows(); } catch(e) {}
        wins.forEach((w, wi) => {
          let wId = 0; try { wId = w.id(); } catch(e) {}
          let wName = ''; try { wName = w.name(); } catch(e) {}
          let tabs = []; try { tabs = w.tabs(); } catch(e) {}

          // Find which tab is currently selected (1-based index).
          let selIdx = 1;
          try { selIdx = w.selectedTab().index(); } catch(e) {}

          // Accessibility screen content for this window's visible tab.
          const axContent = axScreenContent(axWins[wi]);

          tabs.forEach((t, ti) => {
            let content = ''; try { content = t.contents() || ''; } catch(e) {}
            let tabName = ''; try { tabName = t.customTitle() || ''; } catch(e) {}
            let busy = false; try { busy = t.busy(); } catch(e) {}

            // For the selected tab, append accessibility content so both sources
            // are searchable. axContent has the current screen (incl. alternate buffer);
            // content has scrollback history. Combined gives best coverage.
            let combined = content;
            if (ti + 1 === selIdx && axContent) {
              combined = content + '\\n' + axContent;
            }

            const lines = combined.split('\\n');
            results.push({
              app: 'Terminal',
              windowIndex: wi + 1,
              windowId: wId,
              windowName: wName,
              tabIndex: ti + 1,
              tabName: tabName,
              sessionId: 0,
              busy: busy,
              lastLines: lines.slice(-20).join('\\n')
            });
          });
        });
      }
    } catch(e) {}
    try {
      const iTerm = Application('iTerm2');
      if (iTerm.running()) {
        let wins = []; try { wins = iTerm.windows(); } catch(e) {}
        wins.forEach((w, wi) => {
          let wName = ''; try { wName = w.name(); } catch(e) {}
          let tabs = []; try { tabs = w.tabs(); } catch(e) {}
          tabs.forEach((t, ti) => {
            let tName = ''; try { tName = t.name() || ''; } catch(e) {}
            let sessions = []; try { sessions = t.sessions(); } catch(e) {}
            sessions.forEach((s, si) => {
              let content = ''; try { content = s.contents() || ''; } catch(e) {}
              let sName = ''; try { sName = s.name() || ''; } catch(e) {}
              const lines = content.split('\\n');
              results.push({
                app: 'iTerm2',
                windowIndex: wi + 1,
                windowId: 0,
                windowName: wName,
                tabIndex: ti + 1,
                tabName: tName || sName,
                sessionId: si + 1,
                busy: false,
                lastLines: lines.slice(-20).join('\\n')
              });
            });
          });
        });
      }
    } catch(e) {}
    JSON.stringify(results);
  `;
  const axTrusted = systemPreferences.isTrustedAccessibilityClient(false);
  try {
    fs.writeFileSync(tmpScript, script);
    const { stdout } = await execAsync(`osascript -l JavaScript "${tmpScript}"`, { timeout: 6000 });
    fs.unlinkSync(tmpScript);
    return { sessions: JSON.parse(stdout.trim() || '[]'), axTrusted };
  } catch (e) {
    try { fs.unlinkSync(tmpScript); } catch(_) {}
    return { error: e.message, sessions: [], axTrusted };
  }
});

ipcMain.handle('send-terminal-input', async (_, { app, windowIndex, windowId, tabIndex, sessionId, text }) => {
  const ts = Date.now();
  // 这些下标/ID 会被拼进 AppleScript/JXA 源码, 强制校验为非负整数, 杜绝脚本注入
  const toIdx = (v) => { const n = Number(v); return Number.isInteger(n) && n >= 0 ? n : null; };
  const wIdx = toIdx(windowIndex), tIdx = toIdx(tabIndex), sId = toIdx(sessionId);
  const wId  = (windowId == null || windowId === '') ? null : toIdx(windowId);
  if (typeof text !== 'string') return { error: '非法输入文本' };
  try {
    if (app === 'Terminal') {
      // 需要 tabIndex + (windowId 或 windowIndex) 之一
      if (tIdx == null || (wId == null && wIdx == null)) return { error: '非法窗口/标签参数' };
      // "do script" sends text + implicit Enter to a Terminal tab's stdin.
      // "write string" (old approach) raises -1700 on macOS Sequoia.
      const char = text.replace(/[\n\r]/g, '');
      const windowRef = wId != null ? `window id ${wId}` : `window ${wIdx}`;
      let script;
      if (char === '\t' || char === '\x1b') {
        // Tab / Esc: use System Events keystroke (briefly focuses Terminal)
        const keyCode = char === '\t' ? 48 : 53;
        script = `tell application "Terminal"\n  activate\n  set targetTab to tab ${tIdx} of ${windowRef}\n  set index of ${windowRef} to 1\nend tell\ntell application "System Events"\n  tell process "Terminal"\n    key code ${keyCode}\n  end tell\nend tell`;
      } else if (char === '') {
        // Enter key: do script "" is unreliable for Ink/full-screen apps (Claude Code etc.).
        // System Events Return (key code 36) is delivered directly to the focused process.
        script = `tell application "Terminal"\n  activate\n  set index of ${windowRef} to 1\nend tell\ntell application "System Events"\n  tell process "Terminal"\n    key code 36\n  end tell\nend tell`;
      } else {
        // Regular text: do script sends TEXT + newline to stdin
        const safeStr = char.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        script = `tell application "Terminal"\n  do script "${safeStr}" in tab ${tIdx} of ${windowRef}\nend tell`;
      }
      const tmpScript = path.join(os.tmpdir(), `term_send_${ts}.applescript`);
      fs.writeFileSync(tmpScript, script);
      await execAsync(`osascript "${tmpScript}"`, { timeout: 4000 });
      try { fs.unlinkSync(tmpScript); } catch(_) {}
    } else {
      // iTerm 分支: 三个下标都必须是合法整数
      if (wIdx == null || tIdx == null || sId == null) return { error: '非法窗口/标签/会话参数' };
      const tmpScript = path.join(os.tmpdir(), `term_send_${ts}.js`);
      const safeText = JSON.stringify(text);
      const script = `const iTerm = Application('iTerm2'); iTerm.windows[${wIdx - 1}].tabs[${tIdx - 1}].sessions[${sId - 1}].write({ text: ${safeText} });`;
      fs.writeFileSync(tmpScript, script);
      await execAsync(`osascript -l JavaScript "${tmpScript}"`, { timeout: 4000 });
      try { fs.unlinkSync(tmpScript); } catch(_) {}
    }
    return { ok: true, xp: state.pet.xp, level: state.pet.level };
  } catch (e) {
    return { error: e.message };
  }
});

function broadcastPetUpdate() {
  const payload = { pet: state.pet, xpProgress: store.getXPProgress(state), aiProvider: state.aiProvider };
  if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.send('pet-update', payload);
  if (panelWindow && !panelWindow.isDestroyed()) panelWindow.webContents.send('pet-update', payload);
}
