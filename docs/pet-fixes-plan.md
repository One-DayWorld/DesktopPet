# 施工蓝图 — 桌宠两处修复(2026-07)

> sonnet 严格施工参照。行号为快照,用 grep 定位。改完 `node --check main.js preload.js`;pet.html 提取 `<script>` 段 node --check。
> **生效条件**:两处都改项目源,需用户重启 app(重装 hook + 加载新 main.js)才生效——实现完在汇报里提醒用户重启。

---

## 需求1 — 修复"派后台子 agent 后误报任务完成"

### 实证结论(已确认)
- Claude Code 的 Stop hook 在主 agent 每次停止时触发。主 agent 派后台子 agent 后自己 Stop → 写 task_done flag → 机甲误报完成,但子 agent 仍在后台跑(实证:Stop 之后仍有大量带 agent_id 的子 agent hook 事件)。
- **区分信号**:子 agent 的所有 hook 事件 payload 带 `agent_id` 字段,主 agent 的不带。
- 方案:带 agent_id 的事件刷新"子 agent 活动"时间戳;主 agent Stop 后,若子 agent 近 12 秒内有活动则**推迟播报**,静默满 12 秒才报(宁晚勿误)。

### 改 scripts/vf1-notify.sh
(注意:hook 实际运行的是 app 从此源提取到 ~/.macross/ 的副本,改源即可,app 重启会重新提取)

1. 顶部 flag 定义处(`TASK_DONE_FLAG=...` 附近,约 11 行)新增:
   ```bash
   SUBAGENT_FLAG="$RUN_DIR/vf1_subagent_active"
   ```

2. `pending` 分支里那段读 stdin 的 python(约 46-58 行):在 dump JSON 之后、返回前,追加——若 payload 有非空 `agent_id`(说明是子 agent 的事件),touch SUBAGENT_FLAG 刷新其 mtime:
   ```python
   if data.get('agent_id'):
       import pathlib
       pathlib.Path(os.path.expanduser('~/.macross/run/vf1_subagent_active')).touch()
   ```
   (加在现有 `with open(...debug.log...)` 之后即可,同一个 python -c 块内)

3. `pending-clear` 分支(约 78-80,当前只有 `rm -f "$PENDING_FLAG"`):在 rm 前加读 stdin 提取 agent_id、非空则 touch SUBAGENT_FLAG:
   ```bash
   pending-clear)
     python3 -c "
   import sys, json, os, pathlib
   try:
       d = json.load(sys.stdin)
       if d.get('agent_id'):
           pathlib.Path(os.path.expanduser('~/.macross/run/vf1_subagent_active')).touch()
   except Exception:
       pass
   " 2>/dev/null || true
     rm -f "$PENDING_FLAG"
     ;;
   ```
   注意 `set -euo pipefail`,python 要容错(|| true)。

4. `task-done` 分支**不变**。

### 改 main.js
1. `VF1_DONE_FLAG` 定义处(约 201 行)后新增:
   ```javascript
   const VF1_SUBAGENT_FLAG = path.join(RUN_DIR, 'vf1_subagent_active');
   ```
   (确认 RUN_DIR 已定义;VF1_DONE_FLAG 用的就是它)

2. `checkTaskDoneFlag()` 开头(约 542-544):
   ```javascript
   async function checkTaskDoneFlag() {
     if (!fs.existsSync(VF1_DONE_FLAG)) return;
     // 需求1: 后台子 agent 近 12s 内仍在活动 → 推迟播报(保留 flag, 每秒轮询重判), 静默满 12s 才报
     try {
       const st = fs.statSync(VF1_SUBAGENT_FLAG);
       if (Date.now() - st.mtimeMs < 12000) return;
     } catch (_) { /* flag 不存在 = 无子 agent 活动, 正常播报 */ }
     let raw = '';
     ...(原逻辑不变: 读 flag → unlink → 播报)
   }
   ```
   `checkTaskDoneFlag` 已由 `setInterval(...,1000)`(约 855 行)每秒轮询,推迟=本次 return、下次再判。

3. hook 注入配置(约 62-80)**不变**(pending/pending-clear 的 stdin 自动带 agent_id)。

### 验证
- `node --check main.js`;`bash -n scripts/vf1-notify.sh`
- 逻辑自检:普通对话(无子 agent)→ SUBAGENT_FLAG 不刷新/很旧 → 立即播报(不受影响);派子 agent → 子 agent 活动刷新 flag → Stop 后推迟 → 静默 12s 播报。

---

## 需求2 — 机甲动态高度(无字幕收缩)

### 目标
两档:**无字幕**=窗口 230 / canvas 200(机甲紧凑);**有字幕**=窗口 290 / canvas 260(恢复上方空间容纳悬浮字幕)。字幕显示时增高、消失时缩回。

### 改 main.js
1. 窗口高度常量(约 111 行 `PET_H` / 130 行 `height:290`):默认改为矮档 230(启动即紧凑)。保留 PET_W=180。
2. 新增 IPC(放在 `set-ignore-mouse` handler 附近):
   ```javascript
   ipcMain.handle('set-pet-height', (_, h) => {
     if (!petWindow || petWindow.isDestroyed()) return;
     const b = petWindow.getBounds();
     petWindow.setBounds({ x: b.x, y: b.y, width: 180, height: h });   // 向下扩展, x/y 不变 → 机甲不跳
   });
   ```
   注意:`homePetPosition()`/巡航归位/breakAnimation 里写死 290 的地方,改为引用当前档位高度(或统一走一个 getter),避免归位时又变回 290。核对约 111/320 行。

### 改 preload.js
```javascript
setPetHeight: (h) => ipcRenderer.invoke('set-pet-height', h),
```

### 改 pet.html
1. 默认 CSS 高度改矮档:`html,body`/`#pet-container` height 290→230;`#canvas-area`/`#pet-canvas` 260→200(第 7/10-11/21-22/27-28 行)。renderer.setSize(180,200)、camera aspect 180/200(第 635/641)。thruster top 228→168(200-32)、tail-thruster top 174→round(200*0.669)=134(第 228-229/261-280)。
2. 新增 `resizeCanvas(canvasH)` 函数,**原子**执行(缺一会变形):
   ```javascript
   function resizeCanvas(ch) {
     renderer.setSize(180, ch);
     camera.aspect = 180 / ch;
     camera.updateProjectionMatrix();
     document.getElementById('canvas-area').style.height = ch + 'px';
     document.getElementById('pet-canvas').style.height = ch + 'px';
     document.getElementById('pet-container').style.height = (ch + 30) + 'px';
     const thL=document.getElementById('thruster-l'), thR=document.getElementById('thruster-r');
     if(thL) thL.style.top=(ch-32)+'px'; if(thR) thR.style.top=(ch-32)+'px';
     const ttL=document.getElementById('tail-thruster-l'), ttR=document.getElementById('tail-thruster-r');
     if(ttL) ttL.style.top=Math.round(ch*0.669)+'px'; if(ttR) ttR.style.top=Math.round(ch*0.669)+'px';
   }
   ```
   (核对 tail-thruster 的实际 id/定位,按第 261-280 行调整比例)
3. 字幕显示/隐藏挂钩(`showBubble` 约 1698-1706):
   - 显示(add 'visible'):`resizeCanvas(260); window.petAPI.setPetHeight(290);`(先 canvas 后窗口)
   - 隐藏(remove 'visible', bubbleTimer 回调):`resizeCanvas(200); window.petAPI.setPetHeight(230);`
   - **常驻气泡**(speakPersist,如任务完成/告警)清除处也要挂缩回:核对 taskDoneAvailable 清除(约 1940)、termAlert 结束(约 2060)、ocAlert 结束等所有 remove 'visible' 的地方,统一缩回。建议封装 `showBubbleResize()/hideBubbleResize()` 两个函数集中调用,避免遗漏。

### 风险(重点自检)
- camera.aspect 必须与 renderer.setSize 同步(resizeCanvas 内已保证)。
- 告警状态(termAlert)机甲眼睛变色/飞弹齐射时,窗口可能已被飞弹逻辑放大到全屏——确认 resizeCanvas/setPetHeight 不与飞弹的窗口缩放打架(搜飞弹窗口缩放逻辑,约 pet.html 201 注释)。若冲突,告警/飞弹期间不触发高度切换。
- Battloid(休息)形态机甲构图不同,矮档下确认不被裁剪。

### 验证
- 真机启动:默认矮档紧凑;触发一次说话(如点击机甲/告警)→ 窗口增高、字幕正常显示、机甲不跳;字幕消失→缩回。反复几次无残留/闪烁。

---

## 执行 & 提交
- 两需求可分别 commit(中文信息),**不要 push**。
- 需求1 生效需重启 app(重装 hook);需求2 生效需重启 app(加载新 pet.html/main.js)。实现完提醒用户重启验证。
