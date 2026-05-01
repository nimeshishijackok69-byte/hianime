(function () {
  if (window.__dgLiveSubtitleBootstrapped) {
    return;
  }
  window.__dgLiveSubtitleBootstrapped = true;

  const ROOT_ID = "dg-live-subtitle-overlay";
  const STYLE_ID = "dg-live-subtitle-style";

  const defaults = {
    lines: 4,
    fontSize: 32,
    opacity: 0.45,
    showInterim: true
  };

  const state = window.__dgLiveSubtitleState || {
    finalLines: [],
    settings: { ...defaults },
    root: null,
    finalNodes: [],
    interimNode: null
  };
  window.__dgLiveSubtitleState = state;

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${ROOT_ID} {
        position: fixed;
        left: 50%;
        bottom: 6%;
        transform: translateX(-50%);
        z-index: 2147483647;
        max-width: min(80vw, 980px);
        pointer-events: auto;
        user-select: text;
        color: #ffffff;
        text-align: center;
        line-height: 1.35;
        white-space: pre-wrap;
        font-family: "Yu Gothic UI", "Meiryo", "Hiragino Sans", "Noto Sans JP", sans-serif;
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.95);
        padding: 10px 16px;
        border-radius: 8px;
        box-sizing: border-box;
      }

      #${ROOT_ID} .dg-final-line,
      #${ROOT_ID} .dg-interim-line {
        min-height: 1.35em;
        overflow-wrap: anywhere;
      }

      #${ROOT_ID} .dg-final-line {
        opacity: 0.98;
        font-weight: 650;
      }

      #${ROOT_ID} .dg-interim-line {
        opacity: 0.72;
        font-style: italic;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function ensureRoot() {
    ensureStyle();

    if (state.root?.isConnected) {
      return state.root;
    }

    let root = document.getElementById(ROOT_ID);
    if (!root) {
      root = document.createElement("div");
      root.id = ROOT_ID;
      root.setAttribute("aria-live", "polite");
      (document.body || document.documentElement).appendChild(root);
    }

    state.root = root;
    rebuildLineNodes();
    applySettings(state.settings);
    return root;
  }

  function rebuildLineNodes() {
    const root = state.root;
    if (!root) {
      return;
    }

    root.textContent = "";
    state.finalNodes = [];

    for (let i = 0; i < state.settings.lines; i += 1) {
      const line = document.createElement("div");
      line.className = "dg-final-line";
      root.appendChild(line);
      state.finalNodes.push(line);
    }

    const interim = document.createElement("div");
    interim.className = "dg-interim-line";
    root.appendChild(interim);
    state.interimNode = interim;
    renderFinalLines();
  }

  function applySettings(config = {}) {
    ensureRoot();
    const previousLineCount = state.settings.lines;
    state.settings = {
      ...state.settings,
      ...config
    };
    state.settings.lines = Number(state.settings.lines) || defaults.lines;
    state.settings.fontSize = Number(state.settings.fontSize) || defaults.fontSize;
    state.settings.opacity = Number(state.settings.opacity) || defaults.opacity;
    state.settings.showInterim = Boolean(state.settings.showInterim);

    if (previousLineCount !== state.settings.lines) {
      state.finalLines = state.finalLines.slice(-state.settings.lines);
      rebuildLineNodes();
    }

    state.root.style.fontSize = `${state.settings.fontSize}px`;
    state.root.style.background = `rgba(0, 0, 0, ${state.settings.opacity})`;
    state.interimNode.style.display = state.settings.showInterim ? "block" : "none";
    renderFinalLines();
  }

  function renderFinalLines() {
    ensureRoot();
    const visible = state.finalLines.slice(-state.settings.lines);
    const blankCount = state.settings.lines - visible.length;

    for (let i = 0; i < state.finalNodes.length; i += 1) {
      state.finalNodes[i].textContent = visible[i - blankCount] || "";
    }
  }

  function commitFinal(text) {
    const cleanText = text.trim();
    if (!cleanText || state.finalLines[state.finalLines.length - 1] === cleanText) {
      return;
    }

    state.finalLines.push(cleanText);
    state.finalLines = state.finalLines.slice(-state.settings.lines);
    state.interimNode.textContent = "";
    renderFinalLines();
  }

  function renderInterim(text) {
    ensureRoot();
    state.interimNode.textContent = state.settings.showInterim ? text.trim() : "";
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (!message?.type) {
      return;
    }

    ensureRoot();

    if (message.type === "APPLY_SETTINGS") {
      applySettings(message.config);
      return;
    }

    if (message.type === "DG_TRANSCRIPT") {
      if (message.isFinal) {
        commitFinal(message.text || "");
      } else {
        renderInterim(message.text || "");
      }
      return;
    }

    if (message.type === "CLEAR_INTERIM") {
      state.interimNode.textContent = "";
      return;
    }

    if (message.type === "CLEAR_ALL") {
      state.finalLines = [];
      state.interimNode.textContent = "";
      renderFinalLines();
    }
  });

  ensureRoot();
})();
