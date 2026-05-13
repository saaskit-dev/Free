#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd -P)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/free-source-install-smoke.XXXXXX")"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

FREE_REF="${FREE_REF:-$(git -C "$ROOT_DIR" rev-parse HEAD)}"
ACP_RUNTIME_REF="${ACP_RUNTIME_REF:-$(sed -e 's/[[:space:]]*$//' -e '/^$/d' "$ROOT_DIR/.acp-runtime-ref" | head -n 1)}"

export npm_config_prefix="$TMP_DIR/npm-prefix"
export FREE_INSTALL_ISOLATED=1
export PATH="$npm_config_prefix/bin:$PATH"

bash "$ROOT_DIR/scripts/install.sh" \
  --source-git \
  --repo-url "file://$ROOT_DIR" \
  --ref "$FREE_REF" \
  --acp-runtime-repo-url "file://$(cd "$ROOT_DIR/../acp-runtime" >/dev/null 2>&1 && pwd -P)" \
  --acp-runtime-ref "$ACP_RUNTIME_REF" \
  --no-login \
  --no-host

free --help >/dev/null
free host --help >/dev/null
free bridge config \
  --relay-url ws://127.0.0.1:8791 \
  --command free \
  --format generic >/dev/null
