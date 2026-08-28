const STORAGE_KEY = "rules";
const PAUSE_OPTIONS = [
  { label: "5 min", minutes: 5 },
  { label: "15 min", minutes: 15 },
];
const EXTEND_MINUTES = 15;

const countdownEls = new Map();

const listEl = document.getElementById("rules-list");
const emptyEl = document.getElementById("empty-state");
const form = document.getElementById("add-form");
const fromInput = document.getElementById("from-input");
const toInput = document.getElementById("to-input");

function genId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function extractHost(value) {
  const v = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    return new URL(v).hostname;
  } catch (e) {
    return null;
  }
}

function getRules() {
  return browser.storage.local.get(STORAGE_KEY).then((d) => d[STORAGE_KEY] || []);
}

function setRules(rules) {
  return browser.storage.local.set({ [STORAGE_KEY]: rules });
}

function formatRemaining(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

async function updateRule(id, mutate) {
  const rules = await getRules();
  const rule = rules.find((r) => r.id === id);
  if (!rule) return;
  mutate(rule);
  await setRules(rules);
  render();
}

async function render() {
  const rules = await getRules();
  listEl.innerHTML = "";
  emptyEl.style.display = rules.length ? "none" : "block";
  countdownEls.clear();

  for (const rule of rules) {
    const isPaused = Boolean(rule.disabledUntil && rule.disabledUntil > Date.now());

    const li = document.createElement("li");
    li.className = "rule";

    const info = document.createElement("div");
    info.className = "rule-info";
    info.innerHTML = `<span class="from">${rule.fromHost}</span> &rarr; <span class="to">${rule.to}</span>`;
    if (isPaused) {
      const countdown = document.createElement("div");
      countdown.className = "countdown";
      countdown.textContent = `Paused — resumes in ${formatRemaining(rule.disabledUntil - Date.now())}`;
      info.appendChild(countdown);
      countdownEls.set(rule.id, { el: countdown, disabledUntil: rule.disabledUntil });
    }

    const controls = document.createElement("div");
    controls.className = "rule-controls";

    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.title = "Enable / disable this rule";
    toggle.checked = rule.enabled && !isPaused;
    toggle.addEventListener("change", async () => {
      await browser.alarms.clear(`reenable-${rule.id}`);
      await updateRule(rule.id, (r) => {
        r.enabled = toggle.checked;
        r.disabledUntil = null;
      });
    });
    controls.appendChild(toggle);

    if (isPaused) {
      const extendBtn = document.createElement("button");
      extendBtn.type = "button";
      extendBtn.className = "extend-btn";
      extendBtn.textContent = `Extend +${EXTEND_MINUTES}m`;
      extendBtn.addEventListener("click", async () => {
        const newUntil = rule.disabledUntil + EXTEND_MINUTES * 60000;
        await browser.alarms.create(`reenable-${rule.id}`, { when: newUntil });
        await updateRule(rule.id, (r) => {
          r.disabledUntil = newUntil;
        });
      });
      controls.appendChild(extendBtn);
    } else {
      const pauseSelect = document.createElement("select");
      const defaultOpt = document.createElement("option");
      defaultOpt.textContent = "Pause for…";
      defaultOpt.value = "";
      pauseSelect.appendChild(defaultOpt);
      for (const opt of PAUSE_OPTIONS) {
        const o = document.createElement("option");
        o.value = String(opt.minutes);
        o.textContent = opt.label;
        pauseSelect.appendChild(o);
      }
      pauseSelect.addEventListener("change", async () => {
        const minutes = Number(pauseSelect.value);
        if (!minutes) return;
        await browser.alarms.create(`reenable-${rule.id}`, { delayInMinutes: minutes });
        await updateRule(rule.id, (r) => {
          r.disabledUntil = Date.now() + minutes * 60000;
        });
      });
      controls.appendChild(pauseSelect);
    }

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "delete-btn";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", async () => {
      await browser.alarms.clear(`reenable-${rule.id}`);
      const rules = await getRules();
      await setRules(rules.filter((r) => r.id !== rule.id));
      render();
    });
    controls.appendChild(deleteBtn);

    li.appendChild(info);
    li.appendChild(controls);
    listEl.appendChild(li);
  }
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const fromHost = extractHost(fromInput.value);
  const to = toInput.value.trim();
  if (!fromHost || !to) return;

  const rules = await getRules();
  rules.push({
    id: genId(),
    fromHost,
    to,
    enabled: true,
    disabledUntil: null,
  });
  await setRules(rules);

  fromInput.value = "";
  toInput.value = "";
  render();
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[STORAGE_KEY]) render();
});

function tickCountdowns() {
  for (const { el, disabledUntil } of countdownEls.values()) {
    el.textContent = `Paused — resumes in ${formatRemaining(disabledUntil - Date.now())}`;
  }
}

setInterval(tickCountdowns, 1000);
render();
