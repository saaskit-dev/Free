#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${FREE_REPO_URL:-https://github.com/saaskit-dev/Free.git}"
REPO_REF="${FREE_REF:-}"
ACP_RUNTIME_REPO_URL="${ACP_RUNTIME_REPO_URL:-https://github.com/saaskit-dev/acp-runtime.git}"
ACP_RUNTIME_REF="${ACP_RUNTIME_REF:-}"
RELAY_URL="${FREE_RELAY_URL:-}"
RUN_LOGIN=1
FORCE_LOGIN=0
NO_HOST=0
SYSTEM_HOST=0
CLEANUP_DIRS=()
INSTALLED_FREE_BIN=""

cleanup() {
  for dir in "${CLEANUP_DIRS[@]+"${CLEANUP_DIRS[@]}"}"; do
    rm -rf "$dir"
  done
}
trap cleanup EXIT

usage() {
  cat <<'EOF'
Usage:
  curl -fsSL https://raw.githubusercontent.com/saaskit-dev/Free/HEAD/scripts/install.sh | bash
  ./scripts/install.sh [--system] [--force-login] [--no-login] [--no-host] [--relay-url <ws-url>]

Options:
  --system       After login, install the boot-time macOS host service.
  --force-login  Force browser login refresh and reinstall the active host mode.
  --no-login     Only install the Free CLI.
  --no-host      Login only; do not install the default user host.
  --relay-url    Relay WebSocket URL passed to auth/host commands.
  --repo-url     Git repository URL, default: https://github.com/saaskit-dev/Free.git.
  --ref          Git ref to checkout, default: repository default branch.
  --help         Show this help.

Environment:
  FREE_REPO_URL   Git repository URL.
  FREE_REF        Git ref to checkout, default: repository default branch.
  ACP_RUNTIME_REPO_URL  acp-runtime Git repository URL.
  ACP_RUNTIME_REF       acp-runtime Git ref to checkout, default: repository default branch.
  FREE_RELAY_URL  Relay WebSocket URL.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --system)
      SYSTEM_HOST=1
      shift
      ;;
    --force-login)
      FORCE_LOGIN=1
      shift
      ;;
    --no-login)
      RUN_LOGIN=0
      shift
      ;;
    --no-host)
      NO_HOST=1
      shift
      ;;
    --relay-url|--repo-url|--ref|--acp-runtime-repo-url|--acp-runtime-ref)
      if [ "$#" -lt 2 ]; then
        echo "Missing value for $1." >&2
        exit 2
      fi
      case "$1" in
        --relay-url) RELAY_URL="$2" ;;
        --repo-url) REPO_URL="$2" ;;
        --ref) REPO_REF="$2" ;;
        --acp-runtime-repo-url) ACP_RUNTIME_REPO_URL="$2" ;;
        --acp-runtime-ref) ACP_RUNTIME_REF="$2" ;;
      esac
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_command npm
require_command node
require_command git

resolve_free_bin() {
  if [ -n "$INSTALLED_FREE_BIN" ] && [ -x "$INSTALLED_FREE_BIN" ]; then
    if command -v free >/dev/null 2>&1; then
      command -v free
    else
      printf '%s\n' "$INSTALLED_FREE_BIN"
    fi
    return 0
  fi

  if command -v free >/dev/null 2>&1; then
    command -v free
    return 0
  fi

  candidate="$(npm_global_bin_dir)/free"
  if [ -x "$candidate" ]; then
    printf '%s\n' "$candidate"
    return 0
  fi

  return 1
}

print_path_hint() {
  free_bin="$1"
  free_bin_dir="$(dirname "$free_bin")"
  cat >&2 <<EOF
Free was installed at:
  $free_bin

That directory is not on PATH for this shell:
  $free_bin_dir

Add it to your shell startup file, for example:
  export PATH="$free_bin_dir:\$PATH"
EOF
}

npm_global_bin_dir() {
  printf '%s/bin\n' "$(npm prefix -g)"
}

canonical_path() {
  node -e '
const fs = require("fs");
const path = require("path");
try {
  process.stdout.write(fs.realpathSync(process.argv[1]));
} catch {
  process.stdout.write(path.resolve(process.argv[1]));
}
' "$1"
}

ensure_active_free_launcher() {
  installed_bin="$1"
  if [ ! -x "$installed_bin" ]; then
    echo "Installed Free binary is missing or not executable: $installed_bin" >&2
    exit 1
  fi

  active_bin="$(command -v free 2>/dev/null || true)"
  if [ -z "$active_bin" ]; then
    return 0
  fi

  active_real="$(canonical_path "$active_bin")"
  installed_real="$(canonical_path "$installed_bin")"
  if [ "$active_real" = "$installed_real" ]; then
    return 0
  fi

  case "$active_bin" in
    "$HOME/.local/bin/free"|"$HOME/.n/bin/free")
      echo "Updating shadowing Free launcher: $active_bin -> $installed_bin"
      rm -f "$active_bin"
      ln -s "$installed_bin" "$active_bin"
      ;;
    *)
      echo "Free was installed at $installed_bin, but PATH resolves free to $active_bin." >&2
      print_path_hint "$installed_bin"
      ;;
  esac
}

script_path="${BASH_SOURCE[0]:-$0}"
script_dir="$(cd "$(dirname "$script_path")" >/dev/null 2>&1 && pwd -P || pwd)"
repo_root="$(cd "$script_dir/.." >/dev/null 2>&1 && pwd -P || pwd)"

install_packed_source() {
  source_dir="$1"
  (cd "$source_dir" && make pack-local)
  tarball="$(find "$source_dir/.tmp/pack" -maxdepth 1 -type f -name "*.tgz" | sort | tail -n 1)"
  if [ -z "$tarball" ]; then
    echo "Free package tarball was not created under $source_dir/.tmp/pack." >&2
    exit 1
  fi
  npm install -g "$tarball" --ignore-scripts --force
  INSTALLED_FREE_BIN="$(npm_global_bin_dir)/free"
  ensure_active_free_launcher "$INSTALLED_FREE_BIN"
}

is_local_checkout() {
  [ -f "$repo_root/package.json" ] &&
    grep -q '"name"[[:space:]]*:[[:space:]]*"free"' "$repo_root/package.json"
}

install_from_local_checkout() {
  echo "Installing Free from local checkout: $repo_root"
  if command -v pnpm >/dev/null 2>&1; then
    (cd "$repo_root" && pnpm install --frozen-lockfile)
  else
    (cd "$repo_root" && npm install)
  fi
  install_packed_source "$repo_root"
}

install_from_git_source() {
  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/free-install.XXXXXX")"
  CLEANUP_DIRS+=("$tmp_dir")
  if [ -n "$ACP_RUNTIME_REF" ]; then
    echo "Cloning acp-runtime source: $ACP_RUNTIME_REPO_URL ($ACP_RUNTIME_REF)"
    git clone --depth 1 --branch "$ACP_RUNTIME_REF" "$ACP_RUNTIME_REPO_URL" "$tmp_dir/acp-runtime"
  else
    echo "Cloning acp-runtime source: $ACP_RUNTIME_REPO_URL (default branch)"
    git clone --depth 1 "$ACP_RUNTIME_REPO_URL" "$tmp_dir/acp-runtime"
  fi
  if [ -n "$REPO_REF" ]; then
    echo "Cloning Free source: $REPO_URL ($REPO_REF)"
    git clone --depth 1 --branch "$REPO_REF" "$REPO_URL" "$tmp_dir/free"
  else
    echo "Cloning Free source: $REPO_URL (default branch)"
    git clone --depth 1 "$REPO_URL" "$tmp_dir/free"
  fi
  echo "Installing Free from source..."
  if command -v pnpm >/dev/null 2>&1; then
    (cd "$tmp_dir/free" && pnpm install --frozen-lockfile)
  else
    (cd "$tmp_dir/free" && npm install)
  fi
  install_packed_source "$tmp_dir/free"
}

if is_local_checkout; then
  install_from_local_checkout
else
  install_from_git_source
fi

if ! FREE_BIN="$(resolve_free_bin)"; then
  echo "Free was installed, but the global bin could not be found." >&2
  echo "npm global prefix: $(npm prefix -g)" >&2
  exit 1
fi
if ! command -v free >/dev/null 2>&1; then
  print_path_hint "$FREE_BIN"
fi

auth_args=(auth login)
host_args=(host install --system)
if [ -n "$RELAY_URL" ]; then
  auth_args+=(--relay-url "$RELAY_URL")
  host_args+=(--relay-url "$RELAY_URL")
fi
if [ "$FORCE_LOGIN" -eq 1 ]; then
  auth_args+=(--force)
fi

if [ "$RUN_LOGIN" -eq 1 ]; then
  if [ "$SYSTEM_HOST" -eq 1 ]; then
    auth_args+=(--no-host)
    "$FREE_BIN" "${auth_args[@]}"
    "$FREE_BIN" "${host_args[@]}"
  else
    if [ "$NO_HOST" -eq 1 ]; then
      auth_args+=(--no-host)
    fi
    "$FREE_BIN" "${auth_args[@]}"
  fi
fi

echo "Free installed: $FREE_BIN"
