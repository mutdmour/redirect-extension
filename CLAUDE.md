# Redirect Manager (Firefox extension)

A Firefox WebExtension that redirects top-level page navigations from one
site to another. There's no toolbar popup and no options page — rules are
managed entirely from an in-page floating panel (same UI as the Safari
build), opened via a "⇄" tab injected next to the pause button.

## Structure

- `shared/rules-core.js` — the rule-matching/data logic, the post-redirect
  pause button, and the in-page manager panel (the "⇄" tab + floating
  panel), all shared with the Safari userscript (see `safari-userscript/`).
  Plain script, no module system: it's loaded as an extra `<script>`/`js`
  entry ahead of each consumer (background, content script) so they share
  one global scope, and it's spliced verbatim into the built userscript.
  Edit rule-matching or UI logic here, not in the per-platform files, so
  both stay in sync. Panel/pause-button code takes a `storage` param
  (`{ getRules, setRules }`) so it doesn't need to know whether it's
  talking to `browser.storage.local` or GM storage.
- `manifest.json` — Manifest V2. Uses `webRequest` + `webRequestBlocking`
  (not `declarativeNetRequest`) because rules are user-editable at runtime
  and each rule needs an independent, timed pause.
- `background.js` — persistent background script. Keeps an in-memory
  `rulesCache` synced from `storage.local` via `storage.onChanged` (the
  `onBeforeRequest` listener must stay synchronous, so it can't read
  storage directly on each request). Redirects only `main_frame` requests.
  Seeds `DEFAULT_RULES` once (see Data model). Records a `justRedirected`
  flag in storage whenever it redirects. Also reactively reconciles
  `browser.alarms` from the rules list on every `storage.onChanged` (see
  Data model) — this is the only thing that needs `browser.alarms`, since
  `content.js` (a content script) can't call it directly and now just
  writes `disabledUntil` straight into storage, same as the panel and the
  Safari userscript.
- `content.js` — runs on every page. Shows the shared manager panel (via
  `injectManagerPanel`) on any page whose hostname owns a rule, and shows
  the shared pause-button widget (via `injectPauseButton`) when
  `justRedirected` in storage points at the current URL and is recent.
  Both read/write rules straight to `browser.storage.local` — no messaging
  the background script needed.
- `safari-userscript/` — the Safari (iOS, via wBlock) build. See its
  README for why it exists and how it differs. `redirect-manager.src.js`
  holds the Safari-only wrapper (GM storage adapter, seeding, the
  redirect/visibility-recheck logic). `redirect-manager.user.js` is a
  **generated file** — `build.sh` concatenates the userscript header,
  `shared/rules-core.js`, and `redirect-manager.src.js` into it; don't
  hand-edit it.

## Data model

Rules are stored under `storage.local["rules"]` as an array of:

```js
{ id, fromHost, to, enabled, disabledUntil }
```

- `fromHost` — bare hostname (no protocol/path), matched exactly or as a
  subdomain (`hostMatches` in `background.js`).
- `to` — raw user input (may or may not include a protocol); normalized to
  a URL at redirect time. Redirects always land on `to` as given (its own
  path, if any) — the original request's path/query/hash is dropped, not
  appended.
- `enabled` — manual on/off toggle.
- `disabledUntil` — epoch ms; set when a rule is paused via the manager
  panel's dropdown, or via the post-redirect pause button — both just
  write it straight into storage. A rule is active only if `enabled` is
  true AND (`disabledUntil` is null or in the past).

`DEFAULT_RULES` (in `shared/rules-core.js`) is seeded into storage exactly
once, ever, on first run — tracked by a separate `seeded` flag so deleting
a seeded rule later doesn't bring it back. Same seed list on both
platforms, so a fresh install auto-redirects those domains immediately.

On Firefox, pauses additionally wake a dormant tab via `browser.alarms`
(`reenable-<ruleId>`), which `background.js` reactively (re)schedules or
clears from `storage.onChanged` to match each rule's current
`disabledUntil` — callers (the panel, the pause button) never create or
clear alarms themselves, they just write `disabledUntil`. The alarm
handler clears the stale `disabledUntil` flag (the `onBeforeRequest` check
already treats an expired `disabledUntil` as active on its own) and also
redirects any currently-active tab that's already sitting on the rule's
`fromHost` — otherwise a dormant tab open before the pause ended wouldn't
trigger a new `main_frame` request and would sit un-redirected until the
user next navigated. Safari has no `browser.alarms`; it covers the same
gap with a `visibilitychange`/`pageshow` recheck instead (see the Safari
README).

## Conventions / constraints to preserve

- Keep all rule management in the in-page manager panel — don't add a
  toolbar popup or an options page unless asked (explicit UX decision).
- Redirects must stay scoped to `main_frame` only — don't widen to other
  resource types without asking (explicit UX decision).
- No master on/off switch — each rule has its own enable/disable and pause
  state (explicit UX decision).
- Known, accepted gap: no loop guard for mutually-redirecting rules
  (A→B and B→A). Don't silently "fix" this with added complexity; call it
  out if it becomes relevant.

## Testing

No test suite. `./build.sh` validates `manifest.json` and syntax-checks
every JS file (including the generated userscript), then produces
`redirect-extension.xpi` and regenerates
`safari-userscript/redirect-manager.user.js`. Run it after any change,
including changes to `shared/rules-core.js`.

Then reload via `about:debugging#/runtime/this-firefox` → "Reload" and
verify manually in the browser.

`.githooks/pre-commit` runs `./build.sh --check` and blocks the commit if
`redirect-manager.user.js` is stale relative to `shared/rules-core.js` /
`redirect-manager.src.js`. Not enabled by default (`core.hooksPath` isn't
set — a git config change we don't make for you); enable it yourself once
with `git config core.hooksPath .githooks`.
