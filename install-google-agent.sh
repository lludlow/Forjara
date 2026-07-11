#!/bin/bash
# Installs the Google coding agent at image build time.
#   antigravity (default) — consumer accounts (free/AI Pro/Ultra)
#   gemini               — enterprise / API-key accounts
#   none                 — skip
set -euo pipefail

case "${1:-antigravity}" in
  antigravity)
    # installer targets ~/.local/bin; redirect HOME and move to system path
    export HOME=/tmp/agy-install
    mkdir -p "$HOME"
    curl -fsSL https://antigravity.google/cli/install.sh | bash
    install -m 0755 "$HOME/.local/bin/agy" /usr/local/bin/agy
    rm -rf "$HOME"
    agy --version
    ;;
  gemini)
    npm install -g @google/gemini-cli
    ;;
  none) ;;
  *)
    echo "unknown GOOGLE_AGENT: $1 (antigravity|gemini|none)" >&2
    exit 1
    ;;
esac
