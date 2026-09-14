#!/bin/sh
# Builds both distributables from the shared core in shared/rules-core.js:
#   - redirect-extension.xpi                      (Firefox, in this same folder)
#   - safari-userscript/redirect-manager.user.js  (Safari via wBlock)
#
# Pass --check to instead verify the committed redirect-manager.user.js is
# up to date without touching it or building the .xpi (used by the
# pre-commit hook in .githooks/pre-commit).
set -e

cd "$(dirname "$0")"

CHECK=0
[ "$1" = "--check" ] && CHECK=1

python3 -mjson.tool manifest.json > /dev/null
node -c shared/rules-core.js
node -c background.js
node -c content.js
node -c popup.js
node -c safari-userscript/redirect-manager.src.js

USERSCRIPT_HEADER='// ==UserScript==
// @name         Redirect Manager
// @namespace    redirect-manager.local
// @version      1.0.0
// @description  Redirect one website to another, with per-rule enable/disable and pause. Managed via a floating in-page panel.
// @match        *://*/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM.getValue
// @grant        GM.setValue
// ==/UserScript==
'

build_userscript() {
  # Content hash of the two source files that make up the userscript body,
  # shown in the pause button ("Pause 15m (vHASH)") so it's obvious whether
  # wBlock is actually running the latest edit.
  hash=$(cat shared/rules-core.js safari-userscript/redirect-manager.src.js | shasum -a 256 | cut -c1-8)

  printf '%s\n' "$USERSCRIPT_HEADER"
  cat shared/rules-core.js
  echo
  sed "s/const BUILD_HASH = \"dev\";/const BUILD_HASH = \"$hash\";/" safari-userscript/redirect-manager.src.js
}

if [ "$CHECK" = 1 ]; then
  tmp=$(mktemp)
  trap 'rm -f "$tmp"' EXIT
  build_userscript > "$tmp"
  if ! diff -q "$tmp" safari-userscript/redirect-manager.user.js > /dev/null 2>&1; then
    echo "safari-userscript/redirect-manager.user.js is stale — run ./build.sh and commit the result." >&2
    exit 1
  fi
  echo "safari-userscript/redirect-manager.user.js is up to date."
  exit 0
fi

rm -f redirect-extension.xpi
zip -r -FS redirect-extension.xpi manifest.json background.js content.js popup.html popup.js popup.css shared icons -x ".*"
echo "Built redirect-extension.xpi"

build_userscript > safari-userscript/redirect-manager.user.js
node -c safari-userscript/redirect-manager.user.js
echo "Built safari-userscript/redirect-manager.user.js"
