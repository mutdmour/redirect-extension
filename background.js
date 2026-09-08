let rulesCache = [];

function loadRules() {
  return browser.storage.local.get(STORAGE_KEY).then((data) => {
    rulesCache = data[STORAGE_KEY] || [];
  });
}

function saveRules() {
  return browser.storage.local.set({ [STORAGE_KEY]: rulesCache });
}

// Seed the default rules exactly once, ever — tracked separately from the
// rules list itself so deleting a seeded rule later doesn't bring it back.
async function ensureSeeded() {
  const data = await browser.storage.local.get("seeded");
  if (data.seeded) return;
  await loadRules();
  for (const { fromHost, to } of DEFAULT_RULES) {
    rulesCache.push({ id: genId(), fromHost, to, enabled: true, disabledUntil: null });
  }
  await saveRules();
  await browser.storage.local.set({ seeded: true });
}

// Lets content.js show a "Pause" button on the page a redirect just landed
// on. Fire-and-forget: onBeforeRequest must return synchronously, and this
// write doesn't need to finish before that happens.
function rememberJustRedirected(rule, redirectUrl) {
  browser.storage.local.set({
    justRedirected: { url: redirectUrl, ruleId: rule.id, at: Date.now() },
  });
}

browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!rulesCache.length) return {};

    let url;
    try {
      url = new URL(details.url);
    } catch (e) {
      return {};
    }

    const match = pickRedirect(rulesCache, url.hostname, details.url);
    if (!match) return {};

    rememberJustRedirected(match.rule, match.redirectUrl);
    return { redirectUrl: match.redirectUrl };
  },
  { urls: ["<all_urls>"], types: ["main_frame"] },
  ["blocking"]
);

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[STORAGE_KEY]) {
    rulesCache = changes[STORAGE_KEY].newValue || [];
  }
});

// When a pause's alarm fires, clear the stored disabledUntil flag (the
// onBeforeRequest check above already treats disabledUntil <= now as
// active on its own, so this just tidies the flag / covers clock drift and
// alarms restored across a browser restart). Also catch up any tab that's
// already sitting on the now-redirected site, since a dormant tab won't
// trigger a new main_frame request on its own.
browser.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith("reenable-")) return;
  const ruleId = alarm.name.slice("reenable-".length);

  loadRules().then(async () => {
    const rule = rulesCache.find((r) => r.id === ruleId);
    if (!rule) return;

    if (rule.disabledUntil) {
      rule.disabledUntil = null;
      await saveRules();
    }
    if (!isRuleActive(rule)) return;

    const redirectUrl = buildRedirectUrl(rule);
    if (!redirectUrl) return;

    const tabs = await browser.tabs.query({ active: true });
    for (const tab of tabs) {
      if (!tab.url) continue;
      let tabUrl;
      try {
        tabUrl = new URL(tab.url);
      } catch (e) {
        continue;
      }
      if (!hostMatches(tabUrl.hostname, rule.fromHost)) continue;
      if (redirectUrl !== tab.url) {
        rememberJustRedirected(rule, redirectUrl);
        browser.tabs.update(tab.id, { url: redirectUrl });
      }
    }
  });
});

// content.js runs on ordinary web pages, which can only reach
// browser.storage and browser.runtime — not browser.alarms — so its pause
// button asks the background page to actually schedule the reenable alarm.
browser.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== "pause-rule") return;

  return loadRules().then(async () => {
    const rule = rulesCache.find((r) => r.id === message.ruleId);
    if (!rule) return;
    const until = Date.now() + message.minutes * 60000;
    rule.disabledUntil = until;
    await saveRules();
    await browser.alarms.create(`reenable-${rule.id}`, { when: until });
  });
});

loadRules();
ensureSeeded();
