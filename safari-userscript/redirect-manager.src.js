(function () {
  "use strict";

  const JUST_REDIRECTED_KEY = "justRedirected";
  const HIDE_TIMEOUT_MS = 2000;

  // The redirect check is async (GM storage round-trip), so the original
  // page can render for a moment before location.replace() fires. Hide it
  // immediately and only reveal once we know no redirect is needed, so
  // that gap reads as a brief blank screen instead of a content flash.
  // Capped so a slow or broken check can never leave the page stuck blank.
  function hidePage() {
    if (document.documentElement) document.documentElement.style.visibility = "hidden";
  }

  function revealPage() {
    if (document.documentElement) document.documentElement.style.visibility = "visible";
  }

  hidePage();
  const revealFallbackTimer = setTimeout(revealPage, HIDE_TIMEOUT_MS);

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

  const storage = { getRules, setRules };

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

  async function main() {
    const hostname = location.hostname;
    let rules;

    try {
      await ensureSeeded();
      rules = await getRules();

      const match = pickRedirect(rules, hostname, location.href);
      if (match) {
        await gmSet(JUST_REDIRECTED_KEY, {
          url: match.redirectUrl,
          ruleId: match.rule.id,
          at: Date.now(),
        });
        location.replace(match.redirectUrl);
        return; // leave the page hidden — it's navigating away
      }
    } catch (e) {
      clearTimeout(revealFallbackTimer);
      revealPage();
      throw e;
    }

    // No redirect applies to this page — safe to show it now.
    clearTimeout(revealFallbackTimer);
    revealPage();

    const justRedirectedFlag = await gmGet(JUST_REDIRECTED_KEY, null);
    const justArrived =
      Boolean(justRedirectedFlag) &&
      justRedirectedFlag.url === location.href &&
      Date.now() - justRedirectedFlag.at < JUST_REDIRECTED_WINDOW_MS;
    if (justArrived) await gmSet(JUST_REDIRECTED_KEY, null);

    const ownsRuleHere = hasAnyRuleForHost(rules, hostname);
    const start = () => {
      if (ownsRuleHere || justArrived) injectManagerPanel(storage);
      if (justArrived) {
        injectPauseButton(
          POST_REDIRECT_PAUSE_MINUTES,
          () => pauseRule(storage, justRedirectedFlag.ruleId, POST_REDIRECT_PAUSE_MINUTES),
          `v${BUILD_HASH}`
        );
      }
    };
    if (ownsRuleHere || justArrived) {
      if (document.body) start();
      else document.addEventListener("DOMContentLoaded", start, { once: true });
    }

    // browser.alarms isn't available to a userscript, so a paused rule
    // can't be woken by an alarm while its tab sits dormant. Instead,
    // recheck only when the tab is actually being looked at again — that's
    // the only moment a stale redirect would be observable — rather than
    // polling on a timer regardless of whether anyone's there.
    async function recheckRedirect() {
      const currentRules = await getRules();
      const m = pickRedirect(currentRules, hostname, location.href);
      if (m) {
        await gmSet(JUST_REDIRECTED_KEY, { url: m.redirectUrl, ruleId: m.rule.id, at: Date.now() });
        location.replace(m.redirectUrl);
      }
    }
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") recheckRedirect();
    });
    window.addEventListener("pageshow", recheckRedirect);
  }

  main();
})();
