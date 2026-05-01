const { MSG, STATE } = globalThis.HIANIME;

const DEEPGRAM_BASE_URL = "wss://api.deepgram.com/v1/listen";
const TARGET_SAMPLE_RATE = 16000;
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAYS = [1000, 2000, 4000];
const BACKPRESSURE_LIMIT_BYTES = 1_000_000;
const KEEPALIVE_INTERVAL_MS = 8000;
const FINALIZE_GRACE_MS = 1200;

let session = null;
let lastInterimText = "";
let lastFinalText = "";
let intentionalStop = false;

function sendRuntimeMessage(message) {
  return chrome.runtime.sendMessage(message).catch(() => {});
}

function setState(state) {
  return sendRuntimeMessage({
    type: MSG.OFFSCREEN_STATE,
    state
  });
}

function reportError(code, message) {
  return sendRuntimeMessage({
    type: MSG.OFFSCREEN_ERROR,
    code,
    message
  });
}

function buildDeepgramUrl(config) {
  const params = new URLSearchParams({
    model: config.model || "nova-3",
    language: config.language || "ja",
    encoding: "linear16",
    sample_rate: String(TARGET_SAMPLE_RATE),
    channels: "1",
    interim_results: "true",
    endpointing: String(config.endpointing || 300)
  });

  if (config.utteranceEndMs) {
    params.set("utterance_end_ms", String(config.utteranceEndMs));
    params.set("vad_events", "true");
  }

  if (config.smartFormat) {
    params.set("smart_format", "true");
  }

  return `${DEEPGRAM_BASE_URL}?${params.toString()}`;
}

function normalizeDeepgramResult(payload) {
  const transcript = payload?.channel?.alternatives?.[0]?.transcript || "";
  const text = transcript.trim();

  if (!text) {
    return null;
  }

  return {
    text,
    isFinal: Boolean(payload.is_final || payload.speech_final),
    ts: Date.now()
  };
}

async function forwardTranscript(tabId, event) {
  if (event.isFinal) {
    if (event.text === lastFinalText) {
      return;
    }
    lastFinalText = event.text;
    lastInterimText = "";
  } else {
    if (event.text === lastInterimText) {
      return;
    }
    lastInterimText = event.text;
  }

  await sendRuntimeMessage({
    type: MSG.OFFSCREEN_TRANSCRIPT,
    tabId,
    event
  });
}

function clearConnectionTimers(current) {
  if (current.reconnectTimer) {
    clearTimeout(current.reconnectTimer);
    current.reconnectTimer = null;
  }

  if (current.keepAliveTimer) {
    clearInterval(current.keepAliveTimer);
    current.keepAliveTimer = null;
  }
}

function waitForDeepgramFinalize(current) {
  if (current.websocket?.readyState !== WebSocket.OPEN) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      current.finalizeResolve = null;
      resolve();
    };
    const timer = setTimeout(finish, FINALIZE_GRACE_MS);

    current.finalizeResolve = finish;

    try {
      current.websocket.send(JSON.stringify({ type: "Finalize" }));
    } catch {
      finish();
    }
  });
}

async function disposeSessionResources(current, options = {}) {
  clearConnectionTimers(current);

  try {
    if (current.websocket?.readyState === WebSocket.OPEN) {
      if (options.waitForFinalTranscript) {
        await waitForDeepgramFinalize(current);
      }
      current.websocket.close(1000, "Stopped by user");
    } else if (current.websocket && current.websocket.readyState < WebSocket.CLOSING) {
      current.websocket.close();
    }
  } catch {}

  try {
    current.workletNode?.port?.close();
    current.sourceNode?.disconnect();
    current.workletNode?.disconnect();
    current.silenceNode?.disconnect();
  } catch {}

  try {
    if (current.audioContext?.state !== "closed") {
      await current.audioContext.close();
    }
  } catch {}

  for (const track of current.displayStream?.getTracks() || []) {
    track.stop();
  }
}

async function stopSession(options = {}) {
  const finalState = options.finalState || STATE.IDLE;

  if (!session) {
    await setState(finalState);
    return;
  }

  intentionalStop = true;
  await setState(STATE.STOPPING);

  const current = session;
  await disposeSessionResources(current, {
    waitForFinalTranscript: finalState === STATE.IDLE
  });
  if (session === current) {
    session = null;
  }

  await sendRuntimeMessage({
    type: MSG.OFFSCREEN_CLEAR_INTERIM,
    tabId: current.tabId
  });
  await setState(finalState);
}

function connectDeepgram(current, attempt = 0) {
  if (session !== current || intentionalStop) {
    return;
  }

  clearConnectionTimers(current);
  setState(STATE.CONNECTING_DEEPGRAM);

  const websocket = new WebSocket(buildDeepgramUrl(current.config), ["token", current.config.apiKey]);
  websocket.binaryType = "arraybuffer";
  current.websocket = websocket;
  current.reconnectAttempt = attempt;
  current.backpressureWarned = false;

  websocket.addEventListener("open", async () => {
    if (session !== current || intentionalStop) {
      websocket.close();
      return;
    }

    current.keepAliveTimer = setInterval(() => {
      if (session === current && websocket.readyState === WebSocket.OPEN) {
        websocket.send(JSON.stringify({ type: "KeepAlive" }));
      }
    }, KEEPALIVE_INTERVAL_MS);

    await setState(STATE.LISTENING);
    if (current.audioContext.state === "suspended") {
      await current.audioContext.resume();
    }
  });

  websocket.addEventListener("message", (event) => {
    try {
      const payload = JSON.parse(event.data);
      const transcriptEvent = normalizeDeepgramResult(payload);
      if (transcriptEvent && session === current) {
        forwardTranscript(current.tabId, transcriptEvent);
        if (transcriptEvent.isFinal && current.finalizeResolve) {
          current.finalizeResolve();
        }
      }
    } catch {
      reportError("DG_PARSE", "Deepgram sent an unreadable transcript event");
    }
  });

  websocket.addEventListener("error", () => {
    // The close event carries retry/auth handling. Avoid noisy duplicate errors here.
  });

  websocket.addEventListener("close", (event) => {
    clearConnectionTimers(current);
    if (session !== current || intentionalStop) {
      return;
    }

    const authish = event.code === 1008 || event.code === 1011;
    if (authish) {
      reportError("DG_AUTH", "Deepgram auth failed");
      stopSession({ finalState: STATE.ERROR });
      return;
    }

    if (attempt < MAX_RECONNECT_ATTEMPTS) {
      const delay = RECONNECT_DELAYS[attempt] || RECONNECT_DELAYS[RECONNECT_DELAYS.length - 1];
      current.reconnectTimer = setTimeout(() => {
        connectDeepgram(current, attempt + 1);
      }, delay);
      setState(STATE.CONNECTING_DEEPGRAM);
      return;
    }

    reportError("DG_CLOSED", `Deepgram connection closed (${event.code || "no code"})`);
    stopSession({ finalState: STATE.ERROR });
  });
}

async function startSession(tabId, config) {
  if (session) {
    await stopSession();
  }

  intentionalStop = false;
  lastInterimText = "";
  lastFinalText = "";

  if (!config?.apiKey) {
    await reportError("NO_API_KEY", "Add a Deepgram API key first");
    return;
  }

  let displayStream = null;
  let audioContext = null;

  try {
    await setState(STATE.AWAITING_CAPTURE_PERMISSION);
    await sendRuntimeMessage({
      type: MSG.OFFSCREEN_CLEAR_ALL,
      tabId
    });

    displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        displaySurface: "browser"
      },
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      },
      selfBrowserSurface: "exclude",
      systemAudio: "include",
      surfaceSwitching: "include"
    });

    const [audioTrack] = displayStream.getAudioTracks();
    const [videoTrack] = displayStream.getVideoTracks();
    const captureLabel = `${videoTrack?.label || ""} ${audioTrack?.label || ""}`;
    if (/live subtitle audio worker|chrome-extension/i.test(captureLabel)) {
      for (const track of displayStream.getTracks()) {
        track.stop();
      }
      await reportError("WRONG_CAPTURE_SOURCE", "Choose the anime tab, not the extension page");
      await setState(STATE.IDLE);
      return;
    }

    if (!audioTrack) {
      for (const track of displayStream.getTracks()) {
        track.stop();
      }
      await reportError("NO_AUDIO_TRACK", "No shared audio detected");
      await setState(STATE.IDLE);
      return;
    }

    await setState(STATE.CAPTURING);

    const audioStream = new MediaStream([audioTrack]);
    audioContext = new AudioContext();
    await audioContext.audioWorklet.addModule(chrome.runtime.getURL("audio-worklet.js"));

    const sourceNode = audioContext.createMediaStreamSource(audioStream);
    const workletNode = new AudioWorkletNode(audioContext, "pcm-capture-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: {
        targetSampleRate: TARGET_SAMPLE_RATE,
        chunkMs: config.chunkMs || 40,
        vadEnabled: config.vadEnabled !== false,
        vadThreshold: config.vadThreshold || 0.012,
        vadHangoverMs: config.vadHangoverMs || 250,
        vadPreRollMs: config.vadPreRollMs || 200
      }
    });
    const silenceNode = audioContext.createGain();
    silenceNode.gain.value = 0;

    sourceNode.connect(workletNode);
    workletNode.connect(silenceNode);
    silenceNode.connect(audioContext.destination);

    session = {
      tabId,
      config,
      displayStream,
      audioContext,
      sourceNode,
      workletNode,
      silenceNode,
      websocket: null,
      reconnectAttempt: 0,
      reconnectTimer: null,
      keepAliveTimer: null,
      backpressureWarned: false,
      finalizeResolve: null
    };
    const current = session;

    audioTrack.addEventListener("ended", () => {
      if (session === current && !intentionalStop) {
        stopSession();
      }
    });

    workletNode.port.onmessage = (event) => {
      if (event.data?.type !== MSG.PCM_CHUNK || session !== current) {
        return;
      }

      if (current.websocket?.readyState !== WebSocket.OPEN) {
        return;
      }

      if (current.websocket.bufferedAmount > BACKPRESSURE_LIMIT_BYTES) {
        current.backpressureWarned = true;
        return;
      }

      current.websocket.send(event.data.buffer);
    };

    connectDeepgram(current);

  } catch (error) {
    if (!session) {
      await disposeSessionResources({
        displayStream,
        audioContext
      });
    }

    await stopSession();

    if (error?.name === "NotAllowedError") {
      await reportError("CAPTURE_DENIED", "Permission denied");
      return;
    }

    if (error?.name === "NotFoundError") {
      await reportError("NO_AUDIO_TRACK", "No shared audio detected");
      return;
    }

    await reportError("START_FAILED", error?.message || "Unable to start capture");
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "offscreen") {
    return false;
  }

  if (message.type === MSG.START) {
    startSession(message.tabId, message.config);
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === MSG.STOP) {
    stopSession();
    sendResponse({ ok: true });
    return false;
  }

  sendResponse({ ok: false, error: "Unknown offscreen message type." });
  return false;
});
