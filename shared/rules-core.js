"use strict";

const STORAGE_KEY = "rules";
const PAUSE_OPTIONS = [
  { label: "5 min", minutes: 5 },
  { label: "15 min", minutes: 15 },
];
const EXTEND_MINUTES = 15;
const POST_REDIRECT_PAUSE_MINUTES = 15;
const PAUSE_BUTTON_DISPLAY_MS = 60000;
const JUST_REDIRECTED_WINDOW_MS = 10000;

// Seeded once, ever, on first run so there's an example rule to build from.
const DEFAULT_RULES = [
  { fromHost: "reddit.com", to: "https://app.mutasem.dev" },
  { fromHost: "www.reddit.com", to: "https://app.mutasem.dev" },
];

function genId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function toAbsoluteUrl(value) {
  const v = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    return new URL(v);
  } catch (e) {
    return null;
  }
}

function extractHost(value) {
  const url = toAbsoluteUrl(value);
  return url ? url.hostname : null;
}

function isRuleActive(rule) {
  if (!rule.enabled) return false;
  if (rule.disabledUntil && rule.disabledUntil > Date.now()) return false;
  return true;
}

function hostMatches(hostname, fromHost) {
  return hostname === fromHost || hostname.endsWith(`.${fromHost}`);
}

function buildRedirectUrl(rule) {
  const target = toAbsoluteUrl(rule.to);
  return target ? target.href : null;
}

function formatRemaining(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Pure lookup so callers can reuse an already-fetched rules array instead of
// re-reading storage on every check. `currentUrl` excludes a rule whose
// target is already the page/tab being checked.
function pickRedirect(rules, hostname, currentUrl) {
  for (const rule of rules) {
    if (!isRuleActive(rule)) continue;
    if (!hostMatches(hostname, rule.fromHost)) continue;
    const redirectUrl = buildRedirectUrl(rule);
    if (redirectUrl && redirectUrl !== currentUrl) return { rule, redirectUrl };
  }
  return null;
}

function hasAnyRuleForHost(rules, hostname) {
  return rules.some((rule) => hostMatches(hostname, rule.fromHost));
}

// Shown briefly on the page a redirect just landed on, as a quick way to
// undo it without opening the full rule manager. Shared between the Firefox
// content script and the Safari userscript — only `onPause` differs (how
// each platform actually persists the pause).
function injectPauseButton(minutes, onPause) {
  if (!document.body) return;

  const btn = document.createElement("button");
  btn.textContent = `Pause ${minutes}m`;
  btn.style.cssText =
    "position:fixed;bottom:16px;left:16px;z-index:2147483647;padding:8px 14px;" +
    "border-radius:20px;background:#222;color:#fff;border:1px solid #555;font-size:13px;" +
    "box-shadow:0 1px 4px rgba(0,0,0,0.4);";

  // Many destination sites are single-page apps that re-render and wipe
  // document.body shortly after load, which would silently remove this
  // button. Keep re-attaching it for as long as it's meant to be shown.
  let active = true;
  function attach() {
    if (!btn.isConnected && document.body) document.body.appendChild(btn);
  }
  attach();

  const observer = new MutationObserver(() => {
    if (active) attach();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  function cleanup() {
    active = false;
    observer.disconnect();
    btn.remove();
  }

  const dismissTimer = setTimeout(cleanup, PAUSE_BUTTON_DISPLAY_MS);

  btn.addEventListener("click", async () => {
    clearTimeout(dismissTimer);
    active = false;
    observer.disconnect();
    await onPause();
    btn.textContent = "Paused ✓";
    setTimeout(() => btn.remove(), 1200);
  });
}
