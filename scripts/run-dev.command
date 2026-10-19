#!/bin/zsh
set -euo pipefail
script_dir="${0:A:h}"
function failed() {
  local result=$?
  if (( result != 0 && result != 130 )); then
    print -u2 "PicPatch launcher failed. Read the message above."
    if [[ -t 0 ]]; then read '?Press Enter to close…'; fi
  fi
}
trap failed EXIT
if ! command -v node >/dev/null; then print -u2 'Node.js 24 or newer is required for development launchers.'; exit 1; fi
print 'PicPatch: run-dev '
node "$script_dir/launch.mjs" dev
