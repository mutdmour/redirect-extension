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

function buildRedirectUrl(originalUrl, rule) {
  const target = toAbsoluteUrl(rule.to);
  if (!target) return null;
  const src = new URL(originalUrl);
  return `${target.protocol}//${target.host}${src.pathname}${src.search}${src.hash}`;
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

      const redirectUrl = buildRedirectUrl(details.url, rule);
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

// Fallback for when a pause's alarm fires while the rule's disabledUntil
// timestamp is still in the future (e.g. clock drift) or the alarm was lost
// across a browser restart: the onBeforeRequest check above already treats
// disabledUntil <= now as active, so this just tidies the stored flag.
browser.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith("reenable-")) return;
  const ruleId = alarm.name.slice("reenable-".length);

  loadRules().then(() => {
    const rule = rulesCache.find((r) => r.id === ruleId);
    if (rule && rule.disabledUntil) {
      rule.disabledUntil = null;
      saveRules();
    }
  });
});

loadRules();
