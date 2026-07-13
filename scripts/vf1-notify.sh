#!/usr/bin/env bash
# vf1-notify.sh — VF-1 桌面机体 Hook 通知脚本

set -euo pipefail

# flag 文件放在仅本人可读写的私有目录 (700), 不再用全局可写的 /tmp ——
# 避免同机其它用户用可预测文件名做软链劫持. 路径从 $HOME 派生, 与 main.js 一致.
RUN_DIR="${HOME}/.macross/run"
mkdir -p "$RUN_DIR" 2>/dev/null && chmod 700 "$RUN_DIR" 2>/dev/null || true
PENDING_FLAG="$RUN_DIR/vf1_claude_pending"
TASK_DONE_FLAG="$RUN_DIR/vf1_task_done"
SUBAGENT_FLAG="$RUN_DIR/vf1_subagent_active"
TASK_DONE_MSG="目标已锁定，请指示"

SUBCMD="${1:-}"

get_tty_line() {
  # 沿着 ppid 链向上爬, 找到第一个有真实 tty 的祖先进程.
  # Claude Code 的中间进程 (worker / wrapper) 经常显示 tty=?? (无 tty),
  # 直接用 $PPID 经常拿不到. 真正绑了 tty 的是 shell / Terminal tab.
  local pid="${1:-}"
  local tty=""
  local hops=0
  while [ -n "$pid" ] && [ "$pid" != "0" ] && [ "$pid" != "1" ] && [ $hops -lt 12 ]; do
    tty=$(ps -o tty= -p "$pid" 2>/dev/null | tr -d ' ' || true)
    if [ -n "$tty" ] && [ "$tty" != "?" ] && [ "$tty" != "??" ]; then
      echo "/dev/$tty"
      return
    fi
    # 取上层 ppid 继续找
    pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ' || true)
    hops=$((hops + 1))
  done
  # 实在找不到, 写空 /dev/ — main.js 检测到非 /dev/tty 开头会跳过 session 设置
  echo "/dev/"
}

# ── 不触发 VF-1 告警的工具白名单 ─────────────────────────────────────────
SKIP_TOOLS="TaskCreate|TaskUpdate|TaskList|TaskGet|TaskStop|TaskOutput|ScheduleWakeup|CronCreate|CronDelete|CronList|ExitPlanMode|EnterPlanMode|LSP|NotebookEdit"

case "$SUBCMD" in
  pending)
    parent_pid="${2:-$$}"

    # 读 stdin JSON 并把完整内容写到 debug log 帮助排查
    if command -v python3 &>/dev/null; then
      eval_result=$(python3 -c "
import sys, json, os, pathlib
try:
    data = json.load(sys.stdin)
    # 把完整 JSON 写到 debug log (与 flag 同处私有目录), 包含事件名辅助排查
    with open(os.path.expanduser('~/.macross/run/vf1_debug.log'), 'a') as f:
        f.write(json.dumps(data, ensure_ascii=False) + '\n')
    if data.get('agent_id') or data.get('tool_name') in ('Agent','Task'):
        pathlib.Path(os.path.expanduser('~/.macross/run/vf1_subagent_active')).touch()
    tool = data.get('tool_name', '')
    pmode = data.get('permission_mode', '')
    # OpenCode (opencode-claude-hooks plugin) 的 PreToolUse 事件:
    # hook_event_name 可能是 'PreToolUse' 或 'PermissionRequest'.
    # PreToolUse 比 PermissionRequest 更可靠 (Full vs Partial 兼容),
    # 但会为更多工具触发. 这里不做区分, 统一走下面的白名单+bypass过滤.
    event = data.get('hook_event_name', '')
    print(tool + '|' + pmode + '|' + event)
except:
    print('||')
" 2>/dev/null || echo "||")
      tool_name="${eval_result%%|*}"
      rest="${eval_result#*|}"
      permission_mode="${rest%%|*}"
      hook_event="${rest#*|}"
    else
      tool_name=""; permission_mode=""; hook_event=""
    fi

    # 1) 内部工具白名单 → 不需要用户介入, 跳过
    if echo "$tool_name" | grep -qE "^($SKIP_TOOLS)$"; then
      exit 0
    fi

    # 2) bypassPermissions 模式 → 全部自动通过, 不弹任何框, 跳过
    if [ "$permission_mode" = "bypassPermissions" ]; then
      exit 0
    fi

    # 3) PreToolUse 事件 (OpenCode 主要路径): 额外检查 —
    #    只对"通常需要确认"的工具报警. Read/Glob/Grep 等只读工具几乎总是自动通过,
    #    在这里跳过可以避免噪音. 如果 permission_mode 已经是 ask 则无论如何都报.
    #    Claude Code 的 PermissionRequest 事件天然只在需要确认时触发, 不受此影响.
    if [ "$hook_event" = "PreToolUse" ]; then
      # 只读/浏览类工具 — 几乎不需要确认, 跳过 (除非显式 ask 模式)
      if [ "$permission_mode" != "ask" ]; then
        if echo "$tool_name" | grep -qE "^(Read|Glob|Grep|BashOutput|TaskOutput|TaskList|TaskGet|ListMcpResourcesTool|ReadMcpResourceTool|ReadMcpResourceDirTool|CronList|EnterPlanMode|ExitPlanMode)$"; then
          exit 0
        fi
      fi
    fi

    get_tty_line "$parent_pid" > "$PENDING_FLAG"
    ;;

  pending-clear)
    python3 -c "
import sys, json, os, pathlib
try:
    d = json.load(sys.stdin)
    if d.get('agent_id') or d.get('tool_name') in ('Agent','Task'):
        pathlib.Path(os.path.expanduser('~/.macross/run/vf1_subagent_active')).touch()
except Exception:
    pass
" 2>/dev/null || true
    rm -f "$PENDING_FLAG"
    ;;

  task-done)
    parent_pid="${2:-$$}"
    {
      get_tty_line "$parent_pid"
      echo "$TASK_DONE_MSG"
    } > "$TASK_DONE_FLAG"
    ;;

  *)
    echo "Usage: $0 {pending|pending-clear|task-done} [parent_pid]" >&2
    exit 1
    ;;
esac
