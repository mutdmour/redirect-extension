(function () {
  "use strict";

  // background.js reconciles the actual browser.alarms wake-up reactively
  // from storage.onChanged, so this content script (like the Safari
  // userscript) only ever needs to read/write rules directly.
  const storage = {
    getRules: () => browser.storage.local.get(STORAGE_KEY).then((d) => d[STORAGE_KEY] || []),
    setRules: (rules) => browser.storage.local.set({ [STORAGE_KEY]: rules }),
  };

  async function main() {
    const data = await browser.storage.local.get("justRedirected");
    const flag = data.justRedirected;
    const justArrived =
      Boolean(flag) && flag.url === location.href && Date.now() - flag.at < JUST_REDIRECTED_WINDOW_MS;
    if (justArrived) await browser.storage.local.remove("justRedirected");

    const rules = await storage.getRules();
    const ownsRuleHere = hasAnyRuleForHost(rules, location.hostname);
    if (!ownsRuleHere && !justArrived) return;

    const start = () => {
      if (ownsRuleHere || justArrived) injectManagerPanel(storage);
      if (justArrived) {
        injectPauseButton(
          POST_REDIRECT_PAUSE_MINUTES,
          () => pauseRule(storage, flag.ruleId, POST_REDIRECT_PAUSE_MINUTES),
          `v${BUILD_HASH}`
        );
      }
    };

    if (document.body) start();
    else document.addEventListener("DOMContentLoaded", start, { once: true });
  }

  main();
})();
