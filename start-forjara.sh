#!/bin/bash
set -euo pipefail

vscode=false
web=false
IFS=',' read -ra requested <<< "${FORJARA_SERVICES:-vscode,web}"
for service in "${requested[@]}"; do
  case "${service//[[:space:]]/}" in
    vscode) vscode=true ;;
    web) web=true ;;
    *) echo "unknown FORJARA_SERVICES entry: $service (expected vscode or web)" >&2; exit 2 ;;
  esac
done
$vscode || $web || { echo "FORJARA_SERVICES must enable vscode, web, or both" >&2; exit 2; }

# Bind-mounted repositories commonly have a host UID that differs from the
# unprivileged container user. Every repository visible here is already inside
# the explicitly mounted workspace boundary.
git config --global --get-all safe.directory 2>/dev/null | grep -Fx '*' >/dev/null \
  || git config --global --add safe.directory '*'

if $vscode; then
  settings="$HOME/.local/share/code-server/User/settings.json"
  [ -e "$settings" ] || { mkdir -p "${settings%/*}"; printf '{\n  "workbench.colorTheme": "Dark Modern"\n}\n' > "$settings"; }
fi

if $vscode && ! $web; then
  exec code-server "$@"
fi
if $web && ! $vscode; then
  exec forjara-web
fi

code-server "$@" &
code_pid=$!
forjara-web &
web_pid=$!

shutdown() {
  kill "$code_pid" "$web_pid" 2>/dev/null || true
  wait "$code_pid" "$web_pid" 2>/dev/null || true
}
trap shutdown INT TERM EXIT

set +e
wait -n "$code_pid" "$web_pid"
status=$?
set -e
exit "$status"
