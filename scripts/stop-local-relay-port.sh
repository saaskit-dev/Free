#!/usr/bin/env bash
set -euo pipefail

PORT="${1:-8791}"

if ! [[ "$PORT" =~ ^[0-9]+$ ]]; then
  printf 'Invalid port: %s\n' "$PORT" >&2
  exit 2
fi

if ! command -v lsof >/dev/null 2>&1; then
  printf 'lsof is required to clean local relay port %s.\n' "$PORT" >&2
  exit 2
fi

LISTENERS=()
while IFS= read -r pid; do
  [ -n "$pid" ] && LISTENERS+=("$pid")
done < <(lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)
if [ "${#LISTENERS[@]}" -eq 0 ]; then
  exit 0
fi

TARGETS=()

add_target() {
  local candidate="$1"
  local existing
  for existing in ${TARGETS[@]+"${TARGETS[@]}"}; do
    [ "$existing" = "$candidate" ] && return 0
  done
  TARGETS+=("$candidate")
}

is_local_relay_process() {
  local command="$1"
  [[ "$command" == *"wrangler dev --ip 127.0.0.1 --port $PORT"* ]] ||
    [[ "$command" == *"pnpm --dir relay exec wrangler dev --ip 127.0.0.1 --port $PORT"* ]] ||
    [[ "$command" == *"workerd serve"* && "$command" == *"127.0.0.1:$PORT"* ]]
}

for pid in ${LISTENERS[@]+"${LISTENERS[@]}"}; do
  current="$pid"
  while [ -n "$current" ] && [ "$current" -gt 1 ] 2>/dev/null; do
    command="$(ps -p "$current" -o command= 2>/dev/null || true)"
    if ! is_local_relay_process "$command"; then
      break
    fi
    add_target "$current"
    current="$(ps -p "$current" -o ppid= 2>/dev/null | tr -d ' ' || true)"
  done
done

if [ "${#TARGETS[@]}" -eq 0 ]; then
  printf 'Port %s is in use, but not by a local Free wrangler dev process.\n' "$PORT" >&2
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >&2 || true
  exit 1
fi

printf 'Stopping local Free relay processes on port %s: %s\n' "$PORT" "${TARGETS[*]}"
kill "${TARGETS[@]}" >/dev/null 2>&1 || true
sleep 1

REMAINING=()
while IFS= read -r pid; do
  [ -n "$pid" ] && REMAINING+=("$pid")
done < <(lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)
if [ "${#REMAINING[@]}" -gt 0 ]; then
  for pid in ${REMAINING[@]+"${REMAINING[@]}"}; do
    command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    if is_local_relay_process "$command"; then
      kill -9 "$pid" >/dev/null 2>&1 || true
    fi
  done
fi
