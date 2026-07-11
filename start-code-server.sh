#!/bin/sh
set -eu

settings="$HOME/.local/share/code-server/User/settings.json"
[ -e "$settings" ] || { mkdir -p "${settings%/*}"; printf '{\n  "workbench.colorTheme": "Dark Modern"\n}\n' > "$settings"; }

exec tini -- code-server "$@"
