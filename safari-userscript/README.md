# Redirect Manager — Safari on iOS (via wBlock userscript)

Safari on iOS doesn't support `webRequestBlocking` (the mechanism the
Firefox extension uses), and its `declarativeNetRequest` redirect action is
unreliable across Safari versions. This version instead runs as a
Greasemonkey-style userscript inside wBlock's userscript engine — no Xcode
project, no code signing, no reinstalling every 7 days.

## Install

1. In wBlock (iOS), go to the userscripts section and add
   `redirect-manager.user.js` (import by file, or paste its contents).
2. Enable the script and make sure it's allowed to run on all sites
   (`*://*/*`).
3. In iOS Settings → Safari → Extensions, confirm wBlock has permission
   for "All Websites".

## Usage

The extension has no toolbar popup (userscript engines don't expose one).
Instead, a small "⇄" tab appears in the bottom-right corner **only on
pages whose hostname already has a redirect rule** — tap it to open the
rule manager: add a rule, toggle it on/off, pause it for 5/15 minutes, or
delete it. Rules are stored via the userscript engine's own storage
(`GM_setValue`/`GM_getValue`), shared across all sites.

The script seeds one default rule the very first time it runs:
`reddit.com` → `https://app.mutasem.dev`. That rule (as long as it exists)
doubles as your entry point for adding rules for other sites — open the
panel on `reddit.com` and add a new "from" host there, and the tab will
then start appearing on that host too. If you delete every rule, there's
no page left where the tab shows up to add a new one (the default is only
seeded once, ever — deleting it won't bring it back).

## Known differences from the Firefox extension

- **No toolbar popup** — replaced by the in-page floating panel described
  above, since userscript engines don't provide a browser-action popup.
- **No `browser.alarms`** — a paused rule resumes the next time the
  userscript runs on that page (on load, or via a 15s poll while the page
  stays open), instead of via an alarm waking a dormant tab. Functionally
  equivalent for a tab you're actively looking at; a tab left open and
  totally idle in the background could take up to 15s to catch up once
  the pause expires, rather than being instant.
- **Redirect happens via `location.replace()`, not a blocked network
  request** — the target page's HTML starts loading before the script
  redirects, so there can be a brief flash of the original page. This is
  a fundamental Safari/WebKit limitation, not specific to this
  implementation.
- Same accepted gap as the Firefox extension: no loop guard for
  mutually-redirecting rules (A→B and B→A).
