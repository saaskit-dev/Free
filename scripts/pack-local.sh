#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd -P)"
ACP_RUNTIME_DIR="$(cd "$ROOT_DIR/../acp-runtime" >/dev/null 2>&1 && pwd -P)"
STAGE_ROOT="$ROOT_DIR/.tmp/package-stage"
STAGE_DIR="$STAGE_ROOT/free"
PACK_DIR="$ROOT_DIR/.tmp/pack"

rm -rf "$STAGE_ROOT" "$PACK_DIR"
mkdir -p "$STAGE_DIR" "$PACK_DIR"

make -C "$ROOT_DIR" build
ACP_RUNTIME_TARBALL="$(npm pack "$ACP_RUNTIME_DIR" --pack-destination "$STAGE_ROOT" --silent)"

cp "$ROOT_DIR/package.json" "$STAGE_DIR/package.json"
cp "$ROOT_DIR/.acp-runtime-ref" "$STAGE_DIR/.acp-runtime-ref"
cp "$ROOT_DIR/README.md" "$STAGE_DIR/README.md"
cp "$ROOT_DIR/Makefile" "$STAGE_DIR/Makefile"
cp -R "$ROOT_DIR/dist" "$STAGE_DIR/dist"
cp -R "$ROOT_DIR/docs" "$STAGE_DIR/docs"
cp -R "$ROOT_DIR/scripts" "$STAGE_DIR/scripts"
cp -R "$ROOT_DIR/relay" "$STAGE_DIR/relay"
rm -rf \
  "$STAGE_DIR/relay/.wrangler" \
  "$STAGE_DIR/relay/node_modules" \
  "$STAGE_DIR/relay/.dev.vars"

node -e '
const fs = require("fs");
const packagePath = process.argv[1];
const runtimeTarball = process.argv[2];
const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
pkg.dependencies["@saaskit-dev/acp-runtime"] = `file:../${runtimeTarball}`;
fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + "\n");
' "$STAGE_DIR/package.json" "$ACP_RUNTIME_TARBALL"

npm install --prefix "$STAGE_DIR" --omit=dev --ignore-scripts
npm pack "$STAGE_DIR" --pack-destination "$PACK_DIR"
