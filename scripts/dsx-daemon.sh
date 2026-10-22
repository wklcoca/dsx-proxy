#!/bin/sh
# dsx-proxy 守护脚本：崩了自动拉起，日志超限自动截断。
# 不依赖 systemd，适合 Android PRoot / 容器 / 任何没法装服务管理器的地方。
#
# 用法:
#   sh dsx-daemon.sh --daemon          # 后台守护（默认）
#   sh dsx-daemon.sh --once            # 只检查并拉起一次
#   sh dsx-daemon.sh --status          # 看是否在跑 + 最近日志
#   sh dsx-daemon.sh --stop            # 停掉守护和 node
#
# 可用环境变量覆盖:
#   DSX_DIR       放置 server.js 的目录（默认：本脚本上一级）
#   DSX_NODE      node 可执行文件（默认自动找）
#   DSX_PORT      端口（默认 8787，用于探活）
#   DSX_LOG       守护日志（默认 $DSX_DIR/daemon.log）
#   DSX_INTERVAL  探活间隔秒数（默认 15）

set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DSX_DIR=${DSX_DIR:-$(dirname "$SCRIPT_DIR")}
DSX_PORT=${DSX_PORT:-8787}
DSX_LOG=${DSX_LOG:-$DSX_DIR/daemon.log}
DSX_INTERVAL=${DSX_INTERVAL:-15}
MAXLOG=5242880
SERVER="$DSX_DIR/server.js"

log() { echo "[$(date '+%m-%d %H:%M:%S')] $*" >>"$DSX_LOG" 2>/dev/null; }

find_node() {
  if [ -n "${DSX_NODE:-}" ] && [ -x "$DSX_NODE" ]; then echo "$DSX_NODE"; return 0; fi
  for c in node nodejs /usr/local/bin/node /usr/bin/node /opt/node/bin/node; do
    if command -v "$c" >/dev/null 2>&1; then command -v "$c"; return 0; fi
    [ -x "$c" ] && { echo "$c"; return 0; }
  done
  return 1
}

http_ok() {
  # 优先用 curl，其次 wget，最后退化成 TCP 探测
  if command -v curl >/dev/null 2>&1; then
    curl -sf -m 3 "http://127.0.0.1:$DSX_PORT/health" 2>/dev/null | grep -q '"ok":true' && return 0
    return 1
  fi
  if command -v wget >/dev/null 2>&1; then
    wget -q -O - -T 3 "http://127.0.0.1:$DSX_PORT/health" 2>/dev/null | grep -q '"ok":true' && return 0
    return 1
  fi
  if command -v nc >/dev/null 2>&1; then
    printf 'GET /health HTTP/1.0\r\n\r\n' | nc -w 2 127.0.0.1 "$DSX_PORT" 2>/dev/null | grep -q '"ok":true' && return 0
  fi
  return 1
}

start_proxy() {
  [ -f "$SERVER" ] || { log "找不到 $SERVER"; return 1; }
  NODE_BIN=$(find_node) || { log "找不到 node"; return 1; }
  ( cd "$DSX_DIR" && "$NODE_BIN" "$SERVER" ) >>"$DSX_LOG" 2>&1 &
  CHILD_PID=$!
  log "已启动 node pid=$CHILD_PID ($NODE_BIN $SERVER)"
  return 0
}

cleanup_stale() {
  for p in $(pgrep -f "node .*dsx.*server\.js" 2>/dev/null); do
    [ "$p" = "$$" ] && continue
    log "清理残留 node pid=$p"
    kill -9 "$p" 2>/dev/null
  done
}

CHILD_PID=""

case "${1:-}" in
  --once)
    if http_ok; then echo up; else start_proxy && { sleep 5; http_ok && echo started || echo failed; }; fi
    ;;
  --daemon)
    if http_ok; then echo "已经在跑：http://127.0.0.1:$DSX_PORT"; exit 0; fi
    log "=== daemon 启动 pid=$$ dir=$DSX_DIR port=$DSX_PORT ==="
    trap '' HUP
    fails=0
    while :; do
      [ -f "$DSX_LOG" ] && { sz=$(wc -c <"$DSX_LOG" 2>/dev/null || echo 0); [ "$sz" -gt "$MAXLOG" ] && : >"$DSX_LOG"; }
      if [ -n "$CHILD_PID" ] && ! kill -0 "$CHILD_PID" 2>/dev/null; then
        log "node $CHILD_PID 退出，清理重启"; cleanup_stale; CHILD_PID=""
      fi
      if http_ok; then fails=0; sleep "$DSX_INTERVAL"; continue; fi
      log "端口 $DSX_PORT 未响应，尝试拉起"
      [ -z "$CHILD_PID" ] && cleanup_stale
      if start_proxy; then
        sleep 8
        if http_ok; then log "拉起成功"; fails=0; else log "拉起后仍不通"; fails=$((fails+1)); fi
      else
        fails=$((fails+1))
      fi
      [ "$fails" -ge 5 ] && { log "连续失败，退避 60s"; sleep 60; fails=0; }
      sleep "$DSX_INTERVAL"
    done
    ;;
  --status)
    if http_ok; then echo "在跑：http://127.0.0.1:$DSX_PORT"; else echo "未运行"; fi
    tail -n 12 "$DSX_LOG" 2>/dev/null
    ;;
  --stop)
    for p in $(pgrep -f "dsx-daemon.sh" 2>/dev/null); do [ "$p" != "$$" ] && kill "$p" 2>/dev/null; done
    cleanup_stale
    echo stopped
    ;;
  *)
    echo "用法: $0 --daemon | --once | --status | --stop"
    exit 2
    ;;
esac
