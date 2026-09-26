#!/usr/bin/env sh
# Installs cc-session to ~/.local/bin (override with PREFIX_BIN=/usr/local/bin).
# From a clone: ./install.sh.  Straight from GitHub:
#   curl -fsSL https://raw.githubusercontent.com/t7spotter/cc-session/main/install.sh | sh
set -e
bin=${PREFIX_BIN:-$HOME/.local/bin}
mkdir -p "$bin"
src=$(dirname "$0")/cc-session
if [ -f "$0" ] && [ -f "$src" ]; then cp "$src" "$bin/cc-session"; else
  curl -fsSL "${CC_SESSION_URL:-https://raw.githubusercontent.com/t7spotter/cc-session/main/cc-session}" -o "$bin/cc-session"; fi
chmod +x "$bin/cc-session"
echo "installed $bin/cc-session"
case ":$PATH:" in *":$bin:"*) ;; *) echo "add $bin to your PATH" ;; esac
