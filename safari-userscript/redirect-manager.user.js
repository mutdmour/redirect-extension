// ==UserScript==
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

(function () {
  "use strict";

  const STORAGE_KEY = "rules";
  const PAUSE_OPTIONS = [
    { label: "5 min", minutes: 5 },
    { label: "15 min", minutes: 15 },
  ];
  const EXTEND_MINUTES = 15;
  const RECHECK_INTERVAL_MS = 15000;
  const JUST_REDIRECTED_KEY = "justRedirected";
  const JUST_REDIRECTED_WINDOW_MS = 10000;
  const PAUSE_BUTTON_DISPLAY_MS = 60000;
  const POST_REDIRECT_PAUSE_MINUTES = 15;

  // wBlock's engine (and others) may only expose the promise-based GM.*
  // variants rather than the classic sync GM_* ones, so wrap both behind a
  // single async interface.
  function gmGet(key, fallback) {
    if (typeof GM !== "undefined" && GM.getValue) return GM.getValue(key, fallback);
    if (typeof GM_getValue === "function") return Promise.resolve(GM_getValue(key, fallback));
    return Promise.resolve(fallback);
  }

  function gmSet(key, value) {
    if (typeof GM !== "undefined" && GM.setValue) return GM.setValue(key, value);
    if (typeof GM_setValue === "function") return Promise.resolve(GM_setValue(key, value));
    return Promise.resolve();
  }

  function getRules() {
    return gmGet(STORAGE_KEY, []);
  }

  function setRules(rules) {
    return gmSet(STORAGE_KEY, rules);
  }

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

  // Pure lookup so callers can reuse an already-fetched rules array instead
  // of re-reading storage on every check. Returns the rule alongside the
  // URL so a caller can later act on that specific rule (e.g. pause it).
  function pickRedirect(rules, hostname) {
    for (const rule of rules) {
      if (!isRuleActive(rule)) continue;
      if (!hostMatches(hostname, rule.fromHost)) continue;
      const redirectUrl = buildRedirectUrl(rule);
      if (redirectUrl && redirectUrl !== location.href) return { rule, redirectUrl };
    }
    return null;
  }

  function hasAnyRuleForHost(rules, hostname) {
    return rules.some((rule) => hostMatches(hostname, rule.fromHost));
  }

  const DEFAULT_RULES = [{ fromHost: "reddit.com", to: "https://app.mutasem.dev" }];

  // Seed the default rules exactly once, ever — tracked separately from the
  // rules list itself so deleting a seeded rule later doesn't bring it back.
  async function ensureSeeded() {
    const seeded = await gmGet("seeded", false);
    if (seeded) return;
    const rules = await getRules();
    for (const { fromHost, to } of DEFAULT_RULES) {
      rules.push({ id: genId(), fromHost, to, enabled: true, disabledUntil: null });
    }
    await setRules(rules);
    await gmSet("seeded", true);
  }

  // --- Management panel ------------------------------------------------
  // No browser-action popup is available to a userscript, so the rule
  // manager is a small floating tab injected into every page instead.

  let panelEl = null;
  let countdownTimer = null;
  const countdownEls = new Map();

  function tickCountdowns() {
    for (const { el, disabledUntil } of countdownEls.values()) {
      el.textContent = `Paused — resumes in ${formatRemaining(disabledUntil - Date.now())}`;
    }
  }

  async function renderPanel() {
    if (!panelEl) return;
    const rules = await getRules();
    const list = panelEl.querySelector("#rm-list");
    const empty = panelEl.querySelector("#rm-empty");
    list.innerHTML = "";
    countdownEls.clear();
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
        countdownEls.set(rule.id, { el: countdown, disabledUntil: rule.disabledUntil });
      }

      const controls = document.createElement("div");
      controls.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap;";

      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.checked = rule.enabled && !isPaused;
      toggle.addEventListener("change", async () => {
        const current = await getRules();
        const r = current.find((x) => x.id === rule.id);
        if (!r) return;
        r.enabled = toggle.checked;
        r.disabledUntil = null;
        await setRules(current);
        renderPanel();
      });
      controls.appendChild(toggle);

      if (isPaused) {
        const extendBtn = document.createElement("button");
        extendBtn.type = "button";
        extendBtn.textContent = `+${EXTEND_MINUTES}m`;
        extendBtn.style.cssText = rmButtonStyle();
        extendBtn.addEventListener("click", async () => {
          const current = await getRules();
          const r = current.find((x) => x.id === rule.id);
          if (!r) return;
          r.disabledUntil = (r.disabledUntil || Date.now()) + EXTEND_MINUTES * 60000;
          await setRules(current);
          renderPanel();
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
          const current = await getRules();
          const r = current.find((x) => x.id === rule.id);
          if (!r) return;
          r.disabledUntil = Date.now() + minutes * 60000;
          await setRules(current);
          renderPanel();
        });
        controls.appendChild(pauseSelect);
      }

      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.textContent = "Delete";
      deleteBtn.style.cssText = rmButtonStyle();
      deleteBtn.addEventListener("click", async () => {
        const current = await getRules();
        await setRules(current.filter((x) => x.id !== rule.id));
        renderPanel();
      });
      controls.appendChild(deleteBtn);

      li.appendChild(controls);
      list.appendChild(li);
    }
  }

  function rmButtonStyle() {
    return "font-size:12px;padding:3px 8px;background:#333;color:#eee;border:1px solid #555;border-radius:4px;";
  }

  function injectPanel() {
    if (panelEl || !document.body) return;

    const tab = document.createElement("button");
    tab.textContent = "⇄";
    tab.title = "Redirect Manager";
    tab.style.cssText =
      "position:fixed;bottom:16px;right:16px;z-index:2147483647;width:40px;height:40px;" +
      "border-radius:50%;background:#222;color:#fff;border:1px solid #555;font-size:18px;" +
      "opacity:0.55;box-shadow:0 1px 4px rgba(0,0,0,0.4);";

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

    document.body.appendChild(tab);
    document.body.appendChild(panel);
    panelEl = panel;

    function openPanel() {
      panel.style.display = "flex";
      renderPanel();
      if (!countdownTimer) countdownTimer = setInterval(tickCountdowns, 1000);
    }

    function closePanel() {
      panel.style.display = "none";
      if (countdownTimer) {
        clearInterval(countdownTimer);
        countdownTimer = null;
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

      const rules = await getRules();
      rules.push({ id: genId(), fromHost, to, enabled: true, disabledUntil: null });
      await setRules(rules);

      fromInput.value = "";
      toInput.value = "";
      renderPanel();
    });
  }

  // Shown briefly on the page a redirect just landed on, as a quick way to
  // undo it without opening the full manager panel.
  function injectPauseButton(ruleId) {
    if (!document.body) return;

    const btn = document.createElement("button");
    btn.textContent = `Pause ${POST_REDIRECT_PAUSE_MINUTES}m`;
    btn.style.cssText =
      "position:fixed;bottom:16px;left:16px;z-index:2147483647;padding:8px 14px;" +
      "border-radius:20px;background:#222;color:#fff;border:1px solid #555;font-size:13px;" +
      "box-shadow:0 1px 4px rgba(0,0,0,0.4);";
    document.body.appendChild(btn);

    const dismissTimer = setTimeout(() => btn.remove(), PAUSE_BUTTON_DISPLAY_MS);

    btn.addEventListener("click", async () => {
      clearTimeout(dismissTimer);
      const rules = await getRules();
      const rule = rules.find((r) => r.id === ruleId);
      if (rule) {
        rule.disabledUntil = Date.now() + POST_REDIRECT_PAUSE_MINUTES * 60000;
        await setRules(rules);
      }
      btn.textContent = "Paused ✓";
      setTimeout(() => btn.remove(), 1200);
    });
  }

  async function main() {
    await ensureSeeded();

    const hostname = location.hostname;
    const rules = await getRules();

    const match = pickRedirect(rules, hostname);
    if (match) {
      await gmSet(JUST_REDIRECTED_KEY, {
        url: match.redirectUrl,
        ruleId: match.rule.id,
        at: Date.now(),
      });
      location.replace(match.redirectUrl);
      return;
    }

    const justRedirectedFlag = await gmGet(JUST_REDIRECTED_KEY, null);
    const justArrived =
      Boolean(justRedirectedFlag) &&
      justRedirectedFlag.url === location.href &&
      Date.now() - justRedirectedFlag.at < JUST_REDIRECTED_WINDOW_MS;
    if (justArrived) await gmSet(JUST_REDIRECTED_KEY, null);

    const ownsRuleHere = hasAnyRuleForHost(rules, hostname);
    const start = () => {
      if (ownsRuleHere) injectPanel();
      if (justArrived) injectPauseButton(justRedirectedFlag.ruleId);
    };
    if (ownsRuleHere || justArrived) {
      if (document.body) start();
      else document.addEventListener("DOMContentLoaded", start, { once: true });
    }

    // browser.alarms isn't available to a userscript, so instead of an
    // alarm waking a dormant tab when a pause expires, poll while the page
    // stays open and catch up the moment a rule becomes active again.
    setInterval(async () => {
      const currentRules = await getRules();
      const m = pickRedirect(currentRules, hostname);
      if (m) {
        await gmSet(JUST_REDIRECTED_KEY, { url: m.redirectUrl, ruleId: m.rule.id, at: Date.now() });
        location.replace(m.redirectUrl);
      }
    }, RECHECK_INTERVAL_MS);
  }

  main();
})();
