const OFFSCREEN_DOCUMENT = "offscreen.html";

let creatingOffscreen = null;
let activeTabId = null;
let currentState = "idle";
let lastOverlayConfig = null;

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT);
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [offscreenUrl]
  });

  if (existingContexts.length > 0) {
    return;
  }

  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT,
      reasons: [chrome.offscreen.Reason.DISPLAY_MEDIA],
      justification: "Capture shared tab audio and stream it to live transcription."
    });
  }

  await creatingOffscreen;
  creatingOffscreen = null;
}

async function injectContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["contentScript.js"]
    });
  } catch (error) {
    throw new Error(`Unable to inject subtitle overlay: ${error.message}`);
  }
}

async function sendToTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
    return true;
  } catch {
    return false;
  }
}

async function ensureOverlayAndSend(tabId, message) {
  let delivered = await sendToTab(tabId, message);
  if (delivered) {
    return;
  }

  await injectContentScript(tabId);
  if (lastOverlayConfig) {
    await sendToTab(tabId, {
      type: "APPLY_SETTINGS",
      config: lastOverlayConfig
    });
  }
  delivered = await sendToTab(tabId, message);

  if (!delivered) {
    throw new Error("Subtitle overlay is unavailable in the target tab.");
  }
}

async function startSession({ tabId, config }) {
  activeTabId = tabId;
  lastOverlayConfig = config;
  currentState = "creating_offscreen";

  await injectContentScript(tabId);
  await sendToTab(tabId, {
    type: "APPLY_SETTINGS",
    config
  });
  await ensureOffscreenDocument();
  await chrome.runtime.sendMessage({
    type: "START",
    target: "offscreen",
    tabId,
    config
  });

  return { ok: true };
}

async function stopSession() {
  await ensureOffscreenDocument();
  await chrome.runtime.sendMessage({
    type: "STOP",
    target: "offscreen"
  });
  return { ok: true };
}

async function applySettings({ tabId, config }) {
  lastOverlayConfig = config;
  const targetTabId = tabId || activeTabId;

  if (targetTabId) {
    await ensureOverlayAndSend(targetTabId, {
      type: "APPLY_SETTINGS",
      config
    });
  }

  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target === "offscreen") {
    return false;
  }

  const run = async () => {
    switch (message.type) {
      case "ENSURE_OFFSCREEN":
        await ensureOffscreenDocument();
        return { ok: true };

      case "START_SESSION":
        return startSession(message);

      case "STOP_SESSION":
        return stopSession();

      case "APPLY_SETTINGS":
        return applySettings(message);

      case "GET_STATUS":
        return {
          ok: true,
          state: currentState,
          tabId: activeTabId
        };

      case "OFFSCREEN_STATE":
        currentState = message.state;
        chrome.runtime.sendMessage({
          type: "STATE",
          state: message.state
        }).catch(() => {});
        return { ok: true };

      case "OFFSCREEN_ERROR":
        currentState = "error";
        chrome.runtime.sendMessage({
          type: "ERROR",
          code: message.code,
          message: message.message
        }).catch(() => {});
        return { ok: true };

      case "OFFSCREEN_TRANSCRIPT":
        await ensureOverlayAndSend(message.tabId, {
          type: "DG_TRANSCRIPT",
          isFinal: message.event.isFinal,
          text: message.event.text,
          ts: message.event.ts
        });
        return { ok: true };

      case "OFFSCREEN_CLEAR_INTERIM":
        if (message.tabId) {
          await ensureOverlayAndSend(message.tabId, {
            type: "CLEAR_INTERIM"
          });
        }
        return { ok: true };

      case "OFFSCREEN_CLEAR_ALL":
        if (message.tabId) {
          await ensureOverlayAndSend(message.tabId, {
            type: "CLEAR_ALL"
          });
        }
        return { ok: true };

      default:
        return { ok: false, error: "Unknown message type." };
    }
  };

  run()
    .then(sendResponse)
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error.message
      });
    });

  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId !== activeTabId || changeInfo.status !== "complete" || currentState === "idle") {
    return;
  }

  injectContentScript(tabId)
    .then(() => {
      if (!lastOverlayConfig) {
        return null;
      }
      return sendToTab(tabId, {
        type: "APPLY_SETTINGS",
        config: lastOverlayConfig
      });
    })
    .catch(() => {});
});
