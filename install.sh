#!/usr/bin/env sh
# Installs cc-session to ~/.local/bin (override with PREFIX_BIN=/usr/local/bin).
set -e
bin=${PREFIX_BIN:-$HOME/.local/bin}
mkdir -p "$bin"
src=$(dirname "$0")/cc-session
if [ -f "$src" ]; then cp "$src" "$bin/cc-session"; else
  curl -fsSL "${CC_SESSION_URL:?run from a clone, or set CC_SESSION_URL to the raw cc-session URL}" -o "$bin/cc-session"; fi
chmod +x "$bin/cc-session"
echo "installed $bin/cc-session"
case ":$PATH:" in *":$bin:"*) ;; *) echo "add $bin to your PATH" ;; esac
