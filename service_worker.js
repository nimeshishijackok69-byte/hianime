import "./constants.js";

const { MSG, STATE } = globalThis.LIVESUBS;
const OFFSCREEN_DOCUMENT = "offscreen.html";
const SESSION_STATE_KEY = "livesubs.sw";

let creatingOffscreen = null;
let activeTabId = null;
let currentState = STATE.IDLE;
let lastOverlayConfig = null;
let lastTabMessageError = "";

// The MV3 service worker may be suspended after ~30 s of idleness while a
// session is live (the offscreen document keeps running independently).
// Persist session state to storage.session and restore it on cold start so
// the popup, stop/restart paths, and navigation re-injection keep behaving
// as if the worker had stayed alive.
let stateLoaded = null;

async function loadSessionState() {
  if (!stateLoaded) {
    stateLoaded = chrome.storage.session
      .get(SESSION_STATE_KEY)
      .then((stored) => {
        const snapshot = stored?.[SESSION_STATE_KEY];
        if (snapshot) {
          activeTabId = typeof snapshot.activeTabId === "number" ? snapshot.activeTabId : null;
          currentState = typeof snapshot.currentState === "string" ? snapshot.currentState : STATE.IDLE;
          lastOverlayConfig = snapshot.lastOverlayConfig || null;
        }
      })
      .catch(() => {});
  }

  return stateLoaded;
}

function persistSessionState() {
  chrome.storage.session
    .set({
      [SESSION_STATE_KEY]: {
        activeTabId,
        currentState,
        lastOverlayConfig
      }
    })
    .catch(() => {});
}

async function getOffscreenContexts() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT);
  return chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [offscreenUrl]
  });
}

async function hasOffscreenDocument() {
  const existingContexts = await getOffscreenContexts();
  return existingContexts.length > 0;
}

async function ensureOffscreenDocument() {
  const existingContexts = await getOffscreenContexts();
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

  try {
    await creatingOffscreen;
    creatingOffscreen = null;
  } catch (error) {
    // A cached rejected promise would poison every subsequent start until
    // the (suspendable) service worker happened to restart.
    creatingOffscreen = null;
    throw error;
  }
}

async function closeOffscreenDocumentIfPresent() {
  if (await hasOffscreenDocument()) {
    await chrome.offscreen.closeDocument();
  }
}

function getOverlayConfig(config) {
  return {
    lines: config.lines,
    fontSize: config.fontSize,
    opacity: config.opacity,
    showInterim: config.showInterim
  };
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

// Transcripts are delivered off the response path (the offscreen caller
// never reads the reply), but they are chained so that messages can never
// interleave — a stale interim must not render after its final.
let transcriptDelivery = Promise.resolve();

function deliverTranscript(message) {
  transcriptDelivery = transcriptDelivery.then(() =>
    ensureOverlayAndSend(message.tabId, {
      type: MSG.DG_TRANSCRIPT,
      isFinal: message.event.isFinal,
      text: message.event.text,
      ts: message.event.ts
    })
  ).catch(() => {
    // Best-effort: delivery failures surface via the next event's
    // injection retry; nothing here needs to reject the chain.
  });
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
  await loadSessionState();
  const overlayConfig = getOverlayConfig(config);

  activeTabId = tabId;
  lastOverlayConfig = overlayConfig;
  currentState = STATE.CREATING_OFFSCREEN;
  persistSessionState();

  try {
    await ensureOverlayAndSend(tabId, {
      type: MSG.CLEAR_ALL
    });
    await ensureOverlayAndSend(tabId, {
      type: MSG.APPLY_SETTINGS,
      config: overlayConfig
    });
    await ensureOffscreenDocument();
    await chrome.runtime.sendMessage({
      type: MSG.START,
      target: "offscreen",
      tabId,
      config
    });
  } catch (error) {
    // Early failures (injection refused, offscreen creation failed) left
    // currentState parked in creating_offscreen forever. Reset so the
    // popup and started-state logic return to a sane idle.
    currentState = STATE.IDLE;
    activeTabId = null;
    lastOverlayConfig = null;
    persistSessionState();
    closeOffscreenDocumentIfPresent().catch(() => {});
    throw error;
  }

  return { ok: true };
}

async function stopSession() {
  await loadSessionState();
  if (!(await hasOffscreenDocument())) {
    currentState = STATE.IDLE;
    activeTabId = null;
    persistSessionState();
    chrome.runtime.sendMessage({
      type: MSG.STATE,
      state: STATE.IDLE
    }).catch(() => {});
    return { ok: true };
  }

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
    await loadSessionState();
    switch (message.type) {
      case MSG.ENSURE_OFFSCREEN:
        return {
          ok: true,
          exists: await hasOffscreenDocument()
        };

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
        await loadSessionState();
        currentState = message.state;
        if (message.state === STATE.IDLE) {
          activeTabId = null;
        }
        persistSessionState();
        chrome.runtime.sendMessage({
          type: MSG.STATE,
          state: message.state
        }).catch(() => {});
        if (message.state === STATE.IDLE || message.state === STATE.ERROR) {
          await closeOffscreenDocumentIfPresent();
        }
        return { ok: true };

      case MSG.OFFSCREEN_ERROR:
        await loadSessionState();
        currentState = STATE.ERROR;
        persistSessionState();
        chrome.runtime.sendMessage({
          type: MSG.ERROR,
          code: message.code,
          message: message.message
        }).catch(() => {});
        return { ok: true };

      case MSG.OFFSCREEN_TRANSCRIPT:
        deliverTranscript(message);
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

      case MSG.OFFSCREEN_REMOVE_OVERLAY:
        if (message.tabId) {
          // Direct send, never inject: if the content script is gone the
          // overlay is gone with it, and we must not inject just to delete.
          await sendToTab(message.tabId, {
            type: MSG.REMOVE_OVERLAY
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

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  await loadSessionState();
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
