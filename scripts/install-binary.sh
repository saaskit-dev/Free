#!/usr/bin/env bash
set -euo pipefail

REPO_SLUG="${FREE_REPO_SLUG:-saaskit-dev/Free}"
VERSION="${FREE_VERSION:-latest}"
INSTALL_DIR="${FREE_INSTALL_DIR:-$HOME/.local/bin}"
BASE_URL="${FREE_INSTALL_BASE_URL:-}"
RUN_LOGIN=1
FORCE_LOGIN=0
RELAY_URL="${FREE_RELAY_URL:-}"
RELAY_ENV="${FREE_RELAY_ENV:-}"
OS_OVERRIDE="${FREE_INSTALL_OS:-}"
ARCH_OVERRIDE="${FREE_INSTALL_ARCH:-}"

usage() {
  cat <<'EOF'
Usage:
  curl -fsSL https://free.saaskit.app/install | bash
  ./scripts/install-binary.sh [--no-login] [--force-login] [--relay-env online|local]

Options:
  --no-login       Only install the Free binary.
  --force-login    Force browser login refresh after installing.
  --relay-env      Relay environment passed to login: online or local.
  --relay-url      Custom relay WebSocket URL passed to login.
  --install-dir    Directory for the free binary. Default: ~/.local/bin.
  --version        GitHub release tag. Default: latest.
  --base-url       Override binary download base URL.
  --help           Show this help.

Environment:
  FREE_VERSION           GitHub release tag. Default: latest.
  FREE_INSTALL_DIR       Directory for the free binary.
  FREE_INSTALL_BASE_URL  Binary download base URL.
  FREE_RELAY_ENV         Relay environment passed to login.
  FREE_RELAY_URL         Custom relay WebSocket URL passed to login.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-login)
      RUN_LOGIN=0
      shift
      ;;
    --force-login)
      FORCE_LOGIN=1
      shift
      ;;
    --relay-env|--relay-url|--install-dir|--version|--base-url)
      if [ "$#" -lt 2 ]; then
        echo "Missing value for $1." >&2
        exit 2
      fi
      case "$1" in
        --relay-env) RELAY_ENV="$2" ;;
        --relay-url) RELAY_URL="$2" ;;
        --install-dir) INSTALL_DIR="$2" ;;
        --version) VERSION="$2" ;;
        --base-url) BASE_URL="$2" ;;
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

if [ -n "$RELAY_ENV" ] && [ -n "$RELAY_URL" ]; then
  echo "--relay-env and --relay-url cannot be used together." >&2
  exit 2
fi

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

detect_os() {
  if [ -n "$OS_OVERRIDE" ]; then
    printf "%s\n" "$OS_OVERRIDE"
    return
  fi
  uname -s | tr "[:upper:]" "[:lower:]"
}

detect_arch() {
  if [ -n "$ARCH_OVERRIDE" ]; then
    printf "%s\n" "$ARCH_OVERRIDE"
    return
  fi
  uname -m
}

binary_suffix() {
  os="$(detect_os)"
  arch="$(detect_arch)"
  case "$os:$arch" in
    darwin:arm64|darwin:aarch64) printf "darwin-arm64\n" ;;
    darwin:x86_64|darwin:amd64) printf "darwin-x64\n" ;;
    linux:arm64|linux:aarch64) printf "linux-arm64\n" ;;
    linux:x86_64|linux:amd64) printf "linux-x64\n" ;;
    *)
      echo "Unsupported platform: $os/$arch" >&2
      exit 1
      ;;
  esac
}

download_base_url() {
  if [ -n "$BASE_URL" ]; then
    printf "%s\n" "${BASE_URL%/}"
    return
  fi
  if [ "$VERSION" = "latest" ]; then
    printf "https://github.com/%s/releases/latest/download\n" "$REPO_SLUG"
  else
    printf "https://github.com/%s/releases/download/%s\n" "$REPO_SLUG" "$VERSION"
  fi
}

print_path_hint() {
  cat >&2 <<EOF
Free was installed at:
  $1

That directory is not on PATH for this shell:
  $(dirname "$1")

Add it to your shell startup file:
  export PATH="$(dirname "$1"):\$PATH"
EOF
}

ensure_active_path() {
  installed_bin="$1"
  active_bin="$(command -v free 2>/dev/null || true)"
  if [ -z "$active_bin" ]; then
    print_path_hint "$installed_bin"
    return
  fi
  installed_dir="$(cd "$(dirname "$installed_bin")" >/dev/null 2>&1 && pwd -P)"
  active_dir="$(cd "$(dirname "$active_bin")" >/dev/null 2>&1 && pwd -P)"
  if [ "$installed_dir/free" != "$active_dir/$(basename "$active_bin")" ]; then
    echo "Free was installed at $installed_bin, but PATH resolves free to $active_bin." >&2
    print_path_hint "$installed_bin"
  fi
}

require_command curl
require_command chmod
require_command mkdir
require_command mktemp

suffix="$(binary_suffix)"
binary_name="free-$suffix"
url="$(download_base_url)/$binary_name"
tmp_file="$(mktemp "${TMPDIR:-/tmp}/free-install.XXXXXX")"
trap 'rm -f "$tmp_file"' EXIT

echo "Downloading Free $VERSION for $suffix..."
curl -fL --retry 3 --retry-delay 1 "$url" -o "$tmp_file"

mkdir -p "$INSTALL_DIR"
installed_bin="$INSTALL_DIR/free"
cp "$tmp_file" "$installed_bin"
chmod 0755 "$installed_bin"

# Remove macOS quarantine flag that prevents unsigned binaries from launching.
if command -v xattr >/dev/null 2>&1; then
  xattr -cr "$installed_bin" 2>/dev/null || true
fi

# Apply ad-hoc code signature so macOS does not reject the binary on launch.
if command -v codesign >/dev/null 2>&1; then
  codesign --force --sign - "$installed_bin" 2>/dev/null || true
fi

ensure_active_path "$installed_bin"

auth_args=(login)
if [ -n "$RELAY_ENV" ]; then
  auth_args+=(--relay-env "$RELAY_ENV")
fi
if [ -n "$RELAY_URL" ]; then
  auth_args+=(--relay-url "$RELAY_URL")
fi
if [ "$FORCE_LOGIN" -eq 1 ]; then
  auth_args+=(--force)
fi

if [ "$RUN_LOGIN" -eq 1 ]; then
  "$installed_bin" "${auth_args[@]}"
fi

echo "Free installed: $installed_bin"
