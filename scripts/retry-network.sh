#!/usr/bin/env bash
set -euo pipefail

attempts="${FREE_CI_NETWORK_RETRY_ATTEMPTS:-3}"
delay_seconds="${FREE_CI_NETWORK_RETRY_DELAY_SECONDS:-12}"
max_delay_seconds="${FREE_CI_NETWORK_RETRY_MAX_DELAY_SECONDS:-60}"

if [ "$#" -eq 0 ]; then
  echo "Usage: scripts/retry-network.sh <command> [args...]" >&2
  exit 2
fi

is_transient_network_error() {
  case "$1" in
    *"fetch failed"* | \
    *"A fetch request failed"* | \
    *"connectivity issue"* | \
    *"network connectivity"* | \
    *"ECONNRESET"* | \
    *"ECONNREFUSED"* | \
    *"ETIMEDOUT"* | \
    *"EAI_AGAIN"* | \
    *"ENOTFOUND"* | \
    *"TLS handshake"* | \
    *"Cloudflare API request failed"* | \
    *"Received a 5"* )
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

attempt=1
while [ "$attempt" -le "$attempts" ]; do
  output_file="$(mktemp "${TMPDIR:-/tmp}/free-ci-network-retry.XXXXXX")"
  exit_code=0
  "$@" >"$output_file" 2>&1 || exit_code="$?"
  output="$(cat "$output_file")"
  rm -f "$output_file"

  printf "%s" "$output"
  if [ -n "$output" ] && [ "${output%"${output##*[!$'\n']}"}" = "$output" ]; then
    printf "\n"
  fi

  if [ "$exit_code" -eq 0 ]; then
    exit 0
  fi

  if [ "$attempt" -ge "$attempts" ] || ! is_transient_network_error "$output"; then
    exit "$exit_code"
  fi

  echo "Transient network error detected. Retrying attempt $((attempt + 1))/$attempts in ${delay_seconds}s..." >&2
  sleep "$delay_seconds"
  attempt=$((attempt + 1))
  delay_seconds=$((delay_seconds * 2))
  if [ "$delay_seconds" -gt "$max_delay_seconds" ]; then
    delay_seconds="$max_delay_seconds"
  fi
done
