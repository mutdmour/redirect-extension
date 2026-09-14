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
// Replaced by build.sh with a content hash of the extension's source, so
// the pause button can show which build is actually running (shared by
// both platforms since both load this file). Left as "dev" when a file
// is loaded straight from the source tree without going through the
// build (e.g. Firefox's unpacked "Reload").
const BUILD_HASH = "dev";

// Seeded once, ever, on first run so there's an example rule to build from.
// hostMatches() already treats a fromHost as covering its subdomains, so
// "reddit.com" alone also covers "www.reddit.com" — a separate entry for
// it would just be a second rule racing the first to redirect the same
// hostname (and having to be paused separately).
const DEFAULT_RULES = [{ fromHost: "reddit.com", to: "https://app.mutasem.dev" }];

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

// Neither platform has a toolbar popup (Safari userscripts never had one;
// Firefox's was removed so both share one UI), so the pause button and the
// manager-panel tab both live in this one fixed container instead of each
// positioning themselves independently.
function getButtonBar() {
  let bar = document.getElementById("rm-button-bar");
  if (!bar && document.body) {
    bar = document.createElement("div");
    bar.id = "rm-button-bar";
    bar.style.cssText =
      "position:fixed;bottom:16px;left:16px;z-index:2147483647;display:flex;" +
      "align-items:center;gap:8px;";
    document.body.appendChild(bar);
  }
  return bar;
}

// Applies a rule's pause directly to storage. Shared by the post-redirect
// pause button and the manager panel's pause dropdown/extend button on both
// platforms — neither a content script nor a userscript can call
// browser.alarms itself, so on Firefox background.js reconciles the actual
// alarm reactively from storage.onChanged instead of callers managing it.
async function pauseRule(storage, ruleId, minutes) {
  const rules = await storage.getRules();
  const rule = rules.find((r) => r.id === ruleId);
  if (!rule) return;
  rule.disabledUntil = Date.now() + minutes * 60000;
  await storage.setRules(rules);
}

// Shown briefly on the page a redirect just landed on, as a quick way to
// undo it without opening the full rule manager. Shared between the Firefox
// content script and the Safari userscript — only `onPause` differs (how
// each platform actually persists the pause).
function injectPauseButton(minutes, onPause, versionLabel) {
  if (!document.body) return;

  const btn = document.createElement("button");
  btn.textContent = versionLabel ? `Pause ${minutes}m (${versionLabel})` : `Pause ${minutes}m`;
  btn.style.cssText =
    "padding:8px 14px;border-radius:20px;background:#222;color:#fff;border:1px solid #555;" +
    "font-size:13px;box-shadow:0 1px 4px rgba(0,0,0,0.4);";

  // Many destination sites are single-page apps that re-render and wipe
  // document.body shortly after load, which would silently remove this
  // button. Keep re-attaching it for as long as it's meant to be shown.
  let active = true;
  function attach() {
    const bar = getButtonBar();
    if (!btn.isConnected && bar) bar.appendChild(btn);
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

// --- In-page management panel ------------------------------------------
// Neither platform has a toolbar popup, so rule management lives in this
// small floating panel instead: a "⇄" tab (next to the pause button, in the
// shared button bar above) opens it. Shown only on pages whose hostname
// already owns a rule. `storage` abstracts the two platforms' persistence
// (browser.storage.local vs GM storage) — everything else is identical.
let rmPanelEl = null;
let rmCountdownTimer = null;
const rmCountdownEls = new Map();

function rmButtonStyle() {
  return "font-size:12px;padding:3px 8px;background:#333;color:#eee;border:1px solid #555;border-radius:4px;";
}

function rmTickCountdowns() {
  for (const { el, disabledUntil } of rmCountdownEls.values()) {
    el.textContent = `Paused — resumes in ${formatRemaining(disabledUntil - Date.now())}`;
  }
}

async function renderManagerPanel(storage) {
  if (!rmPanelEl) return;
  const rules = await storage.getRules();
  const list = rmPanelEl.querySelector("#rm-list");
  const empty = rmPanelEl.querySelector("#rm-empty");
  list.innerHTML = "";
  rmCountdownEls.clear();
  empty.style.display = rules.length ? "none" : "block";

  for (const rule of rules) {
    const isPaused = Boolean(rule.disabledUntil && rule.disabledUntil > Date.now());

    const li = document.createElement("li");
    li.style.cssText =
      "display:flex;flex-direction:column;gap:6px;padding:10px 0;border-bottom:1px solid #333;";

    const info = document.createElement("div");
    info.style.cssText = "font-size:13px;color:#eee;word-break:break-all;";
    info.innerHTML = `<strong>${rule.fromHost}</strong> &rarr; ${rule.to}`;
    li.appendChild(info);

    if (isPaused) {
      const countdown = document.createElement("div");
      countdown.style.cssText = "font-size:12px;color:#f6c453;";
      countdown.textContent = `Paused — resumes in ${formatRemaining(rule.disabledUntil - Date.now())}`;
      li.appendChild(countdown);
      rmCountdownEls.set(rule.id, { el: countdown, disabledUntil: rule.disabledUntil });
    }

    const controls = document.createElement("div");
    controls.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap;";

    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = rule.enabled && !isPaused;
    toggle.addEventListener("change", async () => {
      const current = await storage.getRules();
      const r = current.find((x) => x.id === rule.id);
      if (!r) return;
      r.enabled = toggle.checked;
      r.disabledUntil = null;
      await storage.setRules(current);
      renderManagerPanel(storage);
    });
    controls.appendChild(toggle);

    if (isPaused) {
      const extendBtn = document.createElement("button");
      extendBtn.type = "button";
      extendBtn.textContent = `+${EXTEND_MINUTES}m`;
      extendBtn.style.cssText = rmButtonStyle();
      extendBtn.addEventListener("click", async () => {
        const current = await storage.getRules();
        const r = current.find((x) => x.id === rule.id);
        if (!r) return;
        r.disabledUntil = (r.disabledUntil || Date.now()) + EXTEND_MINUTES * 60000;
        await storage.setRules(current);
        renderManagerPanel(storage);
      });
      controls.appendChild(extendBtn);
    } else {
      const pauseSelect = document.createElement("select");
      pauseSelect.style.cssText = "font-size:12px;padding:2px;";
      const def = document.createElement("option");
      def.textContent = "Pause for…";
      def.value = "";
      pauseSelect.appendChild(def);
      for (const opt of PAUSE_OPTIONS) {
        const o = document.createElement("option");
        o.value = String(opt.minutes);
        o.textContent = opt.label;
        pauseSelect.appendChild(o);
      }
      pauseSelect.addEventListener("change", async () => {
        const minutes = Number(pauseSelect.value);
        if (!minutes) return;
        const current = await storage.getRules();
        const r = current.find((x) => x.id === rule.id);
        if (!r) return;
        r.disabledUntil = Date.now() + minutes * 60000;
        await storage.setRules(current);
        renderManagerPanel(storage);
      });
      controls.appendChild(pauseSelect);
    }

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.textContent = "Delete";
    deleteBtn.style.cssText = rmButtonStyle();
    deleteBtn.addEventListener("click", async () => {
      const current = await storage.getRules();
      await storage.setRules(current.filter((x) => x.id !== rule.id));
      renderManagerPanel(storage);
    });
    controls.appendChild(deleteBtn);

    li.appendChild(controls);
    list.appendChild(li);
  }
}

function injectManagerPanel(storage) {
  if (rmPanelEl || !document.body) return;

  const tab = document.createElement("button");
  tab.textContent = "⇄";
  tab.title = "Redirect Manager";
  tab.style.cssText =
    "width:32px;height:32px;border-radius:50%;background:#222;color:#fff;border:1px solid #555;" +
    "font-size:16px;opacity:0.85;box-shadow:0 1px 4px rgba(0,0,0,0.4);";
  const bar = getButtonBar();
  if (bar) bar.appendChild(tab);

  const panel = document.createElement("div");
  panel.style.cssText =
    "position:fixed;inset:8vh 5vw;z-index:2147483647;background:#1b1b1b;color:#eee;" +
    "border-radius:10px;padding:14px;display:none;flex-direction:column;gap:10px;" +
    "font:13px -apple-system,sans-serif;box-shadow:0 4px 20px rgba(0,0,0,0.6);overflow:auto;";
  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;">
      <strong style="font-size:15px;">Redirect Manager</strong>
      <button id="rm-close" style="${rmButtonStyle()}">Close</button>
    </div>
    <form id="rm-form" style="display:flex;gap:6px;flex-wrap:wrap;">
      <input id="rm-from" placeholder="From (old-site.com)" required
        style="flex:1;min-width:120px;padding:6px;background:#111;color:#eee;border:1px solid #444;border-radius:4px;" />
      <input id="rm-to" placeholder="To (new-site.com)" required
        style="flex:1;min-width:120px;padding:6px;background:#111;color:#eee;border:1px solid #444;border-radius:4px;" />
      <button type="submit" style="${rmButtonStyle()}">Add</button>
    </form>
    <ul id="rm-list" style="list-style:none;margin:0;padding:0;"></ul>
    <p id="rm-empty" style="color:#999;">No redirect rules yet.</p>
  `;

  document.body.appendChild(panel);
  rmPanelEl = panel;

  function openPanel() {
    panel.style.display = "flex";
    renderManagerPanel(storage);
    if (!rmCountdownTimer) rmCountdownTimer = setInterval(rmTickCountdowns, 1000);
  }

  function closePanel() {
    panel.style.display = "none";
    if (rmCountdownTimer) {
      clearInterval(rmCountdownTimer);
      rmCountdownTimer = null;
    }
  }

  tab.addEventListener("click", () => {
    if (panel.style.display === "none") openPanel();
    else closePanel();
  });

  panel.querySelector("#rm-close").addEventListener("click", closePanel);

  panel.querySelector("#rm-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fromInput = panel.querySelector("#rm-from");
    const toInput = panel.querySelector("#rm-to");
    const fromHost = extractHost(fromInput.value);
    const to = toInput.value.trim();
    if (!fromHost || !to) return;

    const rules = await storage.getRules();
    rules.push({ id: genId(), fromHost, to, enabled: true, disabledUntil: null });
    await storage.setRules(rules);

    fromInput.value = "";
    toInput.value = "";
    renderManagerPanel(storage);
  });
}
