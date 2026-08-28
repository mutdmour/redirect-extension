# Redirect Manager (Firefox extension)

A Firefox WebExtension that redirects top-level page navigations from one
site to another. Rules are managed entirely from the toolbar popup — there
is no options page.

## Structure

- `manifest.json` — Manifest V2. Uses `webRequest` + `webRequestBlocking`
  (not `declarativeNetRequest`) because rules are user-editable at runtime
  and each rule needs an independent, timed pause.
- `background.js` — persistent background script. Keeps an in-memory
  `rulesCache` synced from `storage.local` via `storage.onChanged` (the
  `onBeforeRequest` listener must stay synchronous, so it can't read
  storage directly on each request). Redirects only `main_frame` requests.
- `popup.html` / `popup.js` / `popup.css` — the entire UI: add-rule form,
  rule list, per-rule enable/disable checkbox, per-rule "Pause for…"
  dropdown (5 min / 15 min / 1 hr), delete button, live countdown.

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
- `disabledUntil` — epoch ms; set when a rule is paused via the popup
  dropdown. A rule is active only if `enabled` is true AND (`disabledUntil`
  is null or in the past).

Pauses are implemented with `browser.alarms` (`reenable-<ruleId>`) so they
survive popup close. The alarm handler clears the stale `disabledUntil`
flag (the `onBeforeRequest` check already treats an expired `disabledUntil`
as active on its own) and also redirects any currently-active tab that's
already sitting on the rule's `fromHost` — otherwise a dormant tab open
before the pause ended wouldn't trigger a new `main_frame` request and
would sit un-redirected until the user next navigated.

## Conventions / constraints to preserve

- Keep all rule management in the popup — don't add an options page unless
  asked (explicit UX decision).
- Redirects must stay scoped to `main_frame` only — don't widen to other
  resource types without asking (explicit UX decision).
- No master on/off switch — each rule has its own enable/disable and pause
  state (explicit UX decision).
- Known, accepted gap: no loop guard for mutually-redirecting rules
  (A→B and B→A). Don't silently "fix" this with added complexity; call it
  out if it becomes relevant.

## Testing

No test suite / build step. Validate changes with:

```sh
python3 -mjson.tool manifest.json > /dev/null
node -c background.js
node -c popup.js
```

Then reload via `about:debugging#/runtime/this-firefox` → "Reload" and
verify manually in the browser.
