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

# One content hash for the whole extension, substituted into
# shared/rules-core.js's BUILD_HASH placeholder and shown in the pause
# button ("Pause 15m (vHASH)") on both platforms, so it's obvious whether
# a freshly loaded package/userscript is actually running the latest edit.
BUILD_HASH=$(cat shared/rules-core.js background.js content.js popup.js safari-userscript/redirect-manager.src.js | shasum -a 256 | cut -c1-8)

tmp_shared=$(mktemp)
tmp_check=$(mktemp)
stage=$(mktemp -d)
trap 'rm -f "$tmp_shared" "$tmp_check"; rm -rf "$stage"' EXIT

sed "s/const BUILD_HASH = \"dev\";/const BUILD_HASH = \"$BUILD_HASH\";/" shared/rules-core.js > "$tmp_shared"

build_userscript() {
  printf '%s\n' "$USERSCRIPT_HEADER"
  cat "$tmp_shared"
  echo
  cat safari-userscript/redirect-manager.src.js
}

if [ "$CHECK" = 1 ]; then
  build_userscript > "$tmp_check"
  if ! diff -q "$tmp_check" safari-userscript/redirect-manager.user.js > /dev/null 2>&1; then
    echo "safari-userscript/redirect-manager.user.js is stale — run ./build.sh and commit the result." >&2
    exit 1
  fi
  echo "safari-userscript/redirect-manager.user.js is up to date."
  exit 0
fi

# The .xpi needs the substituted shared/rules-core.js, not the working-tree
# copy (which keeps the "dev" placeholder as source), so stage a build
# directory instead of zipping the repo files directly.
mkdir -p "$stage/shared"
cp manifest.json background.js content.js popup.html popup.js popup.css "$stage/"
cp -r icons "$stage/icons"
cp "$tmp_shared" "$stage/shared/rules-core.js"

rm -f redirect-extension.xpi
(cd "$stage" && zip -r -FS "$OLDPWD/redirect-extension.xpi" manifest.json background.js content.js popup.html popup.js popup.css shared icons -x ".*")
echo "Built redirect-extension.xpi"

build_userscript > safari-userscript/redirect-manager.user.js
node -c safari-userscript/redirect-manager.user.js
echo "Built safari-userscript/redirect-manager.user.js"
