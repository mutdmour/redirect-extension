const STORAGE_KEY = "rules";

let rulesCache = [];

function toAbsoluteUrl(value) {
  const v = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    return new URL(v);
  } catch (e) {
    return null;
  }
}

function loadRules() {
  return browser.storage.local.get(STORAGE_KEY).then((data) => {
    rulesCache = data[STORAGE_KEY] || [];
  });
}

function saveRules() {
  return browser.storage.local.set({ [STORAGE_KEY]: rulesCache });
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
  if (!target) return null;
  return target.href;
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

    for (const rule of rulesCache) {
      if (!isRuleActive(rule)) continue;
      if (!hostMatches(url.hostname, rule.fromHost)) continue;

      const redirectUrl = buildRedirectUrl(rule);
      if (redirectUrl && redirectUrl !== details.url) {
        return { redirectUrl };
      }
    }

    return {};
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
        browser.tabs.update(tab.id, { url: redirectUrl });
      }
    }
  });
});

loadRules();
