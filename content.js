(function () {
  "use strict";

  async function main() {
    const data = await browser.storage.local.get("justRedirected");
    const flag = data.justRedirected;
    if (!flag) return;

    const justArrived =
      flag.url === location.href && Date.now() - flag.at < JUST_REDIRECTED_WINDOW_MS;
    if (!justArrived) return;

    await browser.storage.local.remove("justRedirected");

    injectPauseButton(
      POST_REDIRECT_PAUSE_MINUTES,
      () =>
        browser.runtime.sendMessage({
          type: "pause-rule",
          ruleId: flag.ruleId,
          minutes: POST_REDIRECT_PAUSE_MINUTES,
        }),
      `v${BUILD_HASH}`
    );
  }

  if (document.body) main();
  else document.addEventListener("DOMContentLoaded", main, { once: true });
})();
