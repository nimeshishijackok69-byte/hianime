import "./constants.js";

const { MSG, STATE } = globalThis.HIANIME;
const OFFSCREEN_DOCUMENT = "offscreen.html";

let creatingOffscreen = null;
let activeTabId = null;
let currentState = STATE.IDLE;
let lastOverlayConfig = null;
let lastTabMessageError = "";

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
      files: ["constants.js", "contentScript.js"]
    });
  } catch (error) {
    throw new Error(`Unable to inject subtitle overlay: ${error.message}`);
  }
}

async function sendToTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
    lastTabMessageError = "";
    return true;
  } catch (error) {
    lastTabMessageError = error.message;
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
      type: MSG.APPLY_SETTINGS,
      config: lastOverlayConfig
    });
  }
  delivered = await sendToTab(tabId, message);

  if (!delivered) {
    const suffix = lastTabMessageError ? ` ${lastTabMessageError}` : "";
    throw new Error(`Subtitle overlay is unavailable in the target tab.${suffix}`);
  }
}

async function startSession({ tabId, config }) {
  activeTabId = tabId;
  lastOverlayConfig = config;
  currentState = STATE.CREATING_OFFSCREEN;

  await ensureOverlayAndSend(tabId, {
    type: MSG.CLEAR_ALL
  });
  await ensureOverlayAndSend(tabId, {
    type: MSG.APPLY_SETTINGS,
    config
  });
  await ensureOffscreenDocument();
  await chrome.runtime.sendMessage({
    type: MSG.START,
    target: "offscreen",
    tabId,
    config
  });

  return { ok: true };
}

async function stopSession() {
  await ensureOffscreenDocument();
  await chrome.runtime.sendMessage({
    type: MSG.STOP,
    target: "offscreen"
  });
  return { ok: true };
}

async function applySettings({ tabId, config }) {
  lastOverlayConfig = config;
  const targetTabId = tabId || activeTabId;

  if (targetTabId) {
    await ensureOverlayAndSend(targetTabId, {
      type: MSG.APPLY_SETTINGS,
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
      case MSG.ENSURE_OFFSCREEN:
        await ensureOffscreenDocument();
        return { ok: true };

      case MSG.START_SESSION:
        return startSession(message);

      case MSG.STOP_SESSION:
        return stopSession();

      case MSG.APPLY_SETTINGS:
        return applySettings(message);

      case MSG.GET_STATUS:
        return {
          ok: true,
          state: currentState,
          tabId: activeTabId
        };

      case MSG.OFFSCREEN_STATE:
        currentState = message.state;
        if (message.state === STATE.IDLE) {
          activeTabId = null;
        }
        chrome.runtime.sendMessage({
          type: MSG.STATE,
          state: message.state
        }).catch(() => {});
        return { ok: true };

      case MSG.OFFSCREEN_ERROR:
        currentState = STATE.ERROR;
        chrome.runtime.sendMessage({
          type: MSG.ERROR,
          code: message.code,
          message: message.message
        }).catch(() => {});
        return { ok: true };

      case MSG.OFFSCREEN_TRANSCRIPT:
        await ensureOverlayAndSend(message.tabId, {
          type: MSG.DG_TRANSCRIPT,
          isFinal: message.event.isFinal,
          text: message.event.text,
          ts: message.event.ts
        });
        return { ok: true };

      case MSG.OFFSCREEN_CLEAR_INTERIM:
        if (message.tabId) {
          await ensureOverlayAndSend(message.tabId, {
            type: MSG.CLEAR_INTERIM
          });
        }
        return { ok: true };

      case MSG.OFFSCREEN_CLEAR_ALL:
        if (message.tabId) {
          await ensureOverlayAndSend(message.tabId, {
            type: MSG.CLEAR_ALL
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
  if (tabId !== activeTabId || changeInfo.status !== "complete" || currentState === STATE.IDLE) {
    return;
  }

  injectContentScript(tabId)
    .then(() => {
      if (!lastOverlayConfig) {
        return null;
      }
      return sendToTab(tabId, {
        type: MSG.APPLY_SETTINGS,
        config: lastOverlayConfig
      });
    })
    .catch(() => {});
});
