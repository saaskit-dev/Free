#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd -P)"
WORKBENCH_PORT="${WORKBENCH_PORT:-8790}"
RELAY_PORT="${RELAY_PORT:-8791}"

stop_workbench() {
  local port="$1"
  local listeners=()
  local pid

  while IFS= read -r pid; do
    [ -n "$pid" ] && listeners+=("$pid")
  done < <(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)

  if [ "${#listeners[@]}" -eq 0 ]; then
    return 0
  fi

  for pid in "${listeners[@]}"; do
    local command
    command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    if [[ "$command" == *"$ROOT_DIR/apps/workbench"* && "$command" == *"expo"* && "$command" == *"--port $port"* ]]; then
      printf 'Stopping local Free Workbench on port %s: %s\n' "$port" "$pid"
      kill "$pid" >/dev/null 2>&1 || true
      sleep 1
      kill -9 "$pid" >/dev/null 2>&1 || true
    elif [ -n "$command" ]; then
      printf 'Port %s is in use, but not by Free Workbench: %s\n' "$port" "$command" >&2
    fi
  done
}

stop_workbench "$WORKBENCH_PORT"
"$ROOT_DIR/scripts/stop-local-relay-port.sh" "$RELAY_PORT"
