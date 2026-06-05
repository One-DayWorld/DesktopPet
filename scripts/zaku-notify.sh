#!/usr/bin/env bash
# zaku-notify.sh — DesktopPet 桌宠 Hook 通知脚本

set -euo pipefail

PENDING_FLAG="/tmp/zaku_claude_pending"
TASK_DONE_FLAG="/tmp/zaku_task_done"
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
import sys, json
try:
    data = json.load(sys.stdin)
    # 把完整 JSON 写到 debug log
    with open('/tmp/zaku_debug.log', 'a') as f:
        f.write(json.dumps(data, ensure_ascii=False) + '\n')
    tool = data.get('tool_name', '')
    pmode = data.get('permission_mode', '')
    print(tool + '|' + pmode)
except:
    print('|')
" 2>/dev/null || echo "|")
      tool_name="${eval_result%%|*}"
      permission_mode="${eval_result##*|}"
    else
      tool_name=""; permission_mode=""
    fi

    # 1) 内部工具白名单 → 不需要用户介入, 跳过
    if echo "$tool_name" | grep -qE "^($SKIP_TOOLS)$"; then
      exit 0
    fi

    # 2) bypassPermissions 模式 → 全部自动通过, 不弹任何框, 跳过
    if [ "$permission_mode" = "bypassPermissions" ]; then
      exit 0
    fi

    get_tty_line "$parent_pid" > "$PENDING_FLAG"
    ;;

  pending-clear)
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
