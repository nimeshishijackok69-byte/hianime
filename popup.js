const DEFAULTS = {
  deepgramApiKey: "",
  "overlay.lines": 4,
  "overlay.fontSize": 32,
  "overlay.opacity": 0.45,
  "overlay.showInterim": true
};

const STATUS_LABELS = {
  idle: "Idle",
  creating_offscreen: "Preparing audio engine",
  awaiting_capture_permission: "Waiting for tab selection",
  capturing: "Capturing audio",
  connecting_deepgram: "Connecting to Deepgram",
  listening: "Listening",
  stopping: "Stopping",
  error: "Error"
};

const ACTIVE_SESSION_STATES = new Set([
  "creating_offscreen",
  "awaiting_capture_permission",
  "capturing",
  "connecting_deepgram",
  "listening",
  "stopping"
]);

const els = {
  apiKey: document.getElementById("apiKey"),
  saveKey: document.getElementById("saveKey"),
  clearKey: document.getElementById("clearKey"),
  keyHint: document.getElementById("keyHint"),
  lines: document.getElementById("lines"),
  linesValue: document.getElementById("linesValue"),
  fontSize: document.getElementById("fontSize"),
  fontSizeValue: document.getElementById("fontSizeValue"),
  opacity: document.getElementById("opacity"),
  opacityValue: document.getElementById("opacityValue"),
  showInterim: document.getElementById("showInterim"),
  start: document.getElementById("start"),
  stop: document.getElementById("stop"),
  statusText: document.getElementById("statusText"),
  statusDot: document.getElementById("statusDot")
};

let overlaySaveTimer = null;

function storageGet(keys) {
  return chrome.storage.local.get(keys);
}

function storageSet(values) {
  return chrome.storage.local.set(values);
}

function storageRemove(keys) {
  return chrome.storage.local.remove(keys);
}

function getOverlayConfig() {
  return {
    lines: Number(els.lines.value),
    fontSize: Number(els.fontSize.value),
    opacity: Number(els.opacity.value),
    showInterim: els.showInterim.checked,
    chunkMs: 40
  };
}

function getApiKey() {
  return els.apiKey.value.trim();
}

function getSessionConfig() {
  return {
    ...getOverlayConfig(),
    apiKey: getApiKey(),
    language: "ja"
  };
}

function getPersistedOverlaySettings() {
  const config = getOverlayConfig();
  return {
    "overlay.lines": config.lines,
    "overlay.fontSize": config.fontSize,
    "overlay.opacity": config.opacity,
    "overlay.showInterim": config.showInterim
  };
}

function updateValueLabels() {
  els.linesValue.textContent = els.lines.value;
  els.fontSizeValue.textContent = `${els.fontSize.value}px`;
  els.opacityValue.textContent = `${Math.round(Number(els.opacity.value) * 100)}%`;
}

function updateStartState() {
  const hasApiKey = getApiKey().length > 0;
  const isBusy = ACTIVE_SESSION_STATES.has(els.statusDot.dataset.state || "idle");
  els.start.disabled = !hasApiKey || isBusy;
  els.stop.disabled = !isBusy;
}

function setStatus(state, detail = "") {
  els.statusDot.dataset.state = state;
  els.statusText.textContent = detail || STATUS_LABELS[state] || state;
  els.statusDot.classList.toggle("live", state === "listening");
  els.statusDot.classList.toggle("error", state === "error");
  updateStartState();
}

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  if (!tab?.id) {
    throw new Error("No active tab found.");
  }

  return tab.id;
}

async function persistOverlaySettings() {
  await storageSet(getPersistedOverlaySettings());
}

async function persistApiKey() {
  const apiKey = getApiKey();
  await storageSet({ deepgramApiKey: apiKey });
  els.keyHint.textContent = apiKey ? "Saved locally." : "Enter a Deepgram API key to start.";
  updateStartState();
}

async function persistAllSettings() {
  await storageSet({
    deepgramApiKey: getApiKey(),
    ...getPersistedOverlaySettings()
  });
  els.keyHint.textContent = getApiKey() ? "Saved locally." : "Enter a Deepgram API key to start.";
  updateStartState();
}

function scheduleOverlaySettingsSave() {
  window.clearTimeout(overlaySaveTimer);
  overlaySaveTimer = window.setTimeout(() => {
    persistOverlaySettings().catch((error) => setStatus("error", error.message));
  }, 200);
}

async function applyOverlaySettingsToTab() {
  updateValueLabels();
  scheduleOverlaySettingsSave();

  try {
    const tabId = await getActiveTabId();
    await chrome.runtime.sendMessage({
      type: "APPLY_SETTINGS",
      tabId,
      config: getOverlayConfig()
    });
  } catch {
    // The overlay may not be present before the first session.
  }
}

async function startSession() {
  const config = getSessionConfig();
  if (!config.apiKey) {
    setStatus("error", "Add an API key first");
    return;
  }

  await persistAllSettings();
  const tabId = await getActiveTabId();
  setStatus("creating_offscreen");

  const response = await chrome.runtime.sendMessage({
    type: "START_SESSION",
    tabId,
    config
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Unable to start session.");
  }
}

async function stopSession() {
  setStatus("stopping");
  const response = await chrome.runtime.sendMessage({
    type: "STOP_SESSION"
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Unable to stop session.");
  }
}

async function load() {
  const values = {
    ...DEFAULTS,
    ...(await storageGet(Object.keys(DEFAULTS)))
  };

  els.apiKey.value = values.deepgramApiKey || "";
  els.lines.value = values["overlay.lines"];
  els.fontSize.value = values["overlay.fontSize"];
  els.opacity.value = values["overlay.opacity"];
  els.showInterim.checked = Boolean(values["overlay.showInterim"]);

  updateValueLabels();
  setStatus("idle");

  const status = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
  if (status?.ok) {
    setStatus(status.state || "idle");
  }

  chrome.runtime.sendMessage({ type: "ENSURE_OFFSCREEN" }).catch(() => {});
}

els.saveKey.addEventListener("click", () => {
  persistApiKey().catch((error) => setStatus("error", error.message));
});

els.clearKey.addEventListener("click", async () => {
  els.apiKey.value = "";
  window.clearTimeout(overlaySaveTimer);
  await storageRemove(["deepgramApiKey"]);
  els.keyHint.textContent = "Key cleared.";
  updateStartState();
});

els.apiKey.addEventListener("input", () => {
  els.keyHint.textContent = getApiKey() ? "Unsaved API key changes." : "Enter a Deepgram API key to start.";
  updateStartState();
});

for (const input of [els.lines, els.fontSize, els.opacity, els.showInterim]) {
  input.addEventListener("input", () => {
    applyOverlaySettingsToTab().catch((error) => setStatus("error", error.message));
  });
}

els.start.addEventListener("click", () => {
  startSession().catch((error) => setStatus("error", error.message));
});

els.stop.addEventListener("click", () => {
  stopSession().catch((error) => setStatus("error", error.message));
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "STATE") {
    setStatus(message.state);
  }

  if (message?.type === "ERROR") {
    setStatus("error", message.message);
  }
});

load().catch((error) => setStatus("error", error.message));
