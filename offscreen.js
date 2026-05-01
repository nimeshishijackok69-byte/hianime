const DEEPGRAM_BASE_URL = "wss://api.deepgram.com/v1/listen";
const TARGET_SAMPLE_RATE = 16000;

let session = null;
let lastInterimText = "";
let lastFinalText = "";
let intentionalStop = false;

function sendRuntimeMessage(message) {
  return chrome.runtime.sendMessage(message).catch(() => {});
}

function setState(state) {
  return sendRuntimeMessage({
    type: "OFFSCREEN_STATE",
    state
  });
}

function reportError(code, message) {
  return sendRuntimeMessage({
    type: "OFFSCREEN_ERROR",
    code,
    message
  });
}

function buildDeepgramUrl(config) {
  const params = new URLSearchParams({
    language: config.language || "ja",
    encoding: "linear16",
    sample_rate: String(TARGET_SAMPLE_RATE),
    channels: "1",
    interim_results: "true",
    endpointing: "250",
    utterance_end_ms: "700",
    smart_format: "false"
  });

  if (config.model) {
    params.set("model", config.model);
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
    type: "OFFSCREEN_TRANSCRIPT",
    tabId,
    event
  });
}

async function disposeSessionResources(current) {
  try {
    if (current.websocket?.readyState === WebSocket.OPEN) {
      current.websocket.send(JSON.stringify({ type: "Finalize" }));
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
  const finalState = options.finalState || "idle";

  if (!session) {
    await setState(finalState);
    return;
  }

  intentionalStop = true;
  await setState("stopping");

  const current = session;
  session = null;
  await disposeSessionResources(current);

  await sendRuntimeMessage({
    type: "OFFSCREEN_CLEAR_INTERIM",
    tabId: current.tabId
  });
  await setState(finalState);
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
    await setState("awaiting_capture_permission");
    await sendRuntimeMessage({
      type: "OFFSCREEN_CLEAR_ALL",
      tabId
    });

    displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      },
      preferCurrentTab: true,
      systemAudio: "include",
      surfaceSwitching: "include"
    });

    const [audioTrack] = displayStream.getAudioTracks();
    if (!audioTrack) {
      for (const track of displayStream.getTracks()) {
        track.stop();
      }
      await reportError("NO_AUDIO_TRACK", "No shared audio detected");
      await setState("idle");
      return;
    }

    await setState("capturing");

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
        chunkMs: config.chunkMs || 40
      }
    });
    const silenceNode = audioContext.createGain();
    silenceNode.gain.value = 0;

    sourceNode.connect(workletNode);
    workletNode.connect(silenceNode);
    silenceNode.connect(audioContext.destination);

    await setState("connecting_deepgram");
    const websocket = new WebSocket(buildDeepgramUrl(config), ["token", config.apiKey]);
    websocket.binaryType = "arraybuffer";

    session = {
      tabId,
      config,
      displayStream,
      audioContext,
      sourceNode,
      workletNode,
      silenceNode,
      websocket
    };

    audioTrack.addEventListener("ended", () => {
      if (!intentionalStop) {
        stopSession();
      }
    });

    workletNode.port.onmessage = (event) => {
      if (event.data?.type !== "PCM_CHUNK") {
        return;
      }

      if (session?.websocket?.readyState === WebSocket.OPEN) {
        session.websocket.send(event.data.buffer);
      }
    };

    websocket.addEventListener("open", async () => {
      await setState("listening");
      if (audioContext.state === "suspended") {
        await audioContext.resume();
      }
    });

    websocket.addEventListener("message", (event) => {
      try {
        const payload = JSON.parse(event.data);
        const transcriptEvent = normalizeDeepgramResult(payload);
        if (transcriptEvent) {
          forwardTranscript(tabId, transcriptEvent);
        }
      } catch {
        reportError("DG_PARSE", "Deepgram sent an unreadable transcript event");
      }
    });

    websocket.addEventListener("error", () => {
      if (!intentionalStop) {
        reportError("DG_NETWORK", "Deepgram network error");
      }
    });

    websocket.addEventListener("close", (event) => {
      if (intentionalStop) {
        return;
      }

      const authish = event.code === 1008 || event.code === 1011;
      reportError(authish ? "DG_AUTH" : "DG_CLOSED", authish ? "Deepgram auth failed" : "Deepgram connection closed");
      stopSession({ finalState: "error" });
    });

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

  if (message.type === "START") {
    startSession(message.tabId, message.config);
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "STOP") {
    stopSession();
    sendResponse({ ok: true });
    return false;
  }

  sendResponse({ ok: false, error: "Unknown offscreen message type." });
  return false;
});
