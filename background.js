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

// content.js's pause button and the in-page manager panel (shared with the
// Safari userscript) write disabledUntil straight into storage — neither a
// content script nor a userscript can call browser.alarms itself, so this
// reactively (re)schedules or clears each rule's wake-up alarm to match,
// instead of every caller having to know about alarms.
async function reconcileAlarms(rules) {
  const activeIds = new Set(rules.map((r) => r.id));
  const alarms = await browser.alarms.getAll();
  for (const alarm of alarms) {
    if (!alarm.name.startsWith("reenable-")) continue;
    if (!activeIds.has(alarm.name.slice("reenable-".length))) {
      await browser.alarms.clear(alarm.name);
    }
  }
  for (const rule of rules) {
    const alarmName = `reenable-${rule.id}`;
    if (rule.disabledUntil && rule.disabledUntil > Date.now()) {
      await browser.alarms.create(alarmName, { when: rule.disabledUntil });
    } else {
      await browser.alarms.clear(alarmName);
    }
  }
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[STORAGE_KEY]) {
    rulesCache = changes[STORAGE_KEY].newValue || [];
    reconcileAlarms(rulesCache);
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

loadRules();
ensureSeeded();
