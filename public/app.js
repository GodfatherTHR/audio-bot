const els = {
  statusLabel: document.getElementById("statusLabel"),
  talkButton: document.getElementById("talkButton"),
  talkLabel: document.getElementById("talkLabel"),
  recordTimer: document.getElementById("recordTimer"),
  levelRing: document.getElementById("levelRing"),
  transcript: document.getElementById("transcript"),
  transcriptLabel: document.getElementById("transcriptLabel"),
  transcriptFoot: document.getElementById("transcriptFoot"),
  clearTranscript: document.getElementById("clearTranscript"),
  langSwitch: document.getElementById("langSwitch"),
  voiceHint: document.getElementById("voiceHint"),
  privacyLabel: document.getElementById("privacyLabel"),
  chatScroll: document.getElementById("chatScroll"),
  chatThread: document.getElementById("chatThread"),
  chatForm: document.getElementById("chatForm"),
  chatInput: document.getElementById("chatInput"),
  chatSend: document.getElementById("chatSend"),
  chatSubtitle: document.getElementById("chatSubtitle"),
  newSession: document.getElementById("newSession"),
  abort: document.getElementById("abort"),
  modelBadge: document.getElementById("modelBadge"),
  sessionBadge: document.getElementById("sessionBadge"),
  healthDot: document.getElementById("healthDot"),
  workspaceLabel: document.getElementById("workspaceLabel"),
  footerModel: document.getElementById("footerModel"),
  approvalModal: document.getElementById("approvalModal"),
  approvalTool: document.getElementById("approvalTool"),
  approvalDetail: document.getElementById("approvalDetail"),
  approvalRemember: document.getElementById("approvalRemember"),
  allowButton: document.getElementById("allowButton"),
  denyButton: document.getElementById("denyButton"),
  toast: document.getElementById("toast")
};

const MAX_RECORDING_MS = 60000;
const CHAT_STORAGE_KEY = "audio-bot-chat-v1";
const CHAT_SNAPSHOT_MAX = 2_000_000;

const SPARKLE_SVG =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3c.7 4.6 3.4 7.3 8 8-4.6.7-7.3 3.4-8 8-.7-4.6-3.4-7.3-8-8 4.6-.7 7.3-3.4 8-8Z"/></svg>';

const TOOL_ICONS = {
  bash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m7 8 4 4-4 4"/><path d="M13 16h4"/></svg>',
  write:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L18 10l-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L18 10l-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/></svg>',
  read: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h8l4 4v14H6V3Z"/><path d="M14 3v4h4"/></svg>',
  ls: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>',
  find: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/></svg>',
  grep: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/></svg>'
};

const FALLBACK_TOOL_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 4v16M4 12h16"/></svg>';

const state = {
  ws: null,
  connected: false,
  reconnectTimer: null,
  busy: false,
  processing: false,
  recording: false,
  mediaRecorder: null,
  mediaStream: null,
  audioContext: null,
  analyser: null,
  levelRaf: null,
  chunks: [],
  recordStartedAt: 0,
  recordTimer: null,
  recordLimitTimer: null,
  openAssistant: null,
  toolCards: new Map(),
  runHasText: false,
  abortRequested: false,
  currentApproval: null,
  toastTimer: null,
  currentPrompt: null,
  language: "en",
  sessionId: null,
  sessionLoaded: false,
  chatSaveTimer: null
};

function setStatus(kind, label) {
  els.statusLabel.className = `status ${kind}`;
  els.statusLabel.textContent = label;
}

function showToast(message, isError = false) {
  clearTimeout(state.toastTimer);
  els.toast.textContent = message;
  els.toast.className = `toast${isError ? " error" : ""}`;
  els.toast.hidden = false;
  state.toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, 4200);
}

function setSession(sessionId) {
  state.sessionId = sessionId;
  els.sessionBadge.textContent = `session ${sessionId.slice(-8)}`;
  els.sessionBadge.title = sessionId;
}

function readChatSnapshot() {
  try {
    const raw = localStorage.getItem(CHAT_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function clearChatSnapshot() {
  try {
    localStorage.removeItem(CHAT_STORAGE_KEY);
  } catch {
    // Storage can be disabled by browser privacy settings.
  }
}

function scheduleChatSave() {
  if (!state.sessionId) return;
  clearTimeout(state.chatSaveTimer);
  state.chatSaveTimer = setTimeout(saveChatSnapshot, 250);
}

function saveChatSnapshot() {
  clearTimeout(state.chatSaveTimer);
  state.chatSaveTimer = null;
  if (!state.sessionId) return;

  let html = els.chatThread.innerHTML;
  if (html.length > CHAT_SNAPSHOT_MAX) {
    const trimmed = els.chatThread.cloneNode(true);
    while (trimmed.children.length > 4 && trimmed.innerHTML.length > CHAT_SNAPSHOT_MAX) {
      trimmed.firstElementChild?.remove();
    }
    html = trimmed.innerHTML;
  }

  const snapshot = {
    sessionId: state.sessionId,
    savedAt: Date.now(),
    hasMessages: Boolean(els.chatThread.querySelector(".chat-message, .chat-tool, .chat-notice")),
    html,
    scrollTop: els.chatScroll.scrollTop,
    busy: state.busy,
    transcriptText: els.transcript.textContent,
    transcriptEmpty: els.transcript.classList.contains("empty"),
    transcriptLang: els.transcript.lang || ""
  };

  try {
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // A full storage quota should never break the live conversation.
  }
}

function restoreChatSnapshot(sessionId) {
  const saved = readChatSnapshot();
  if (!saved) return false;
  if (saved.sessionId !== sessionId) {
    clearChatSnapshot();
    return false;
  }
  if (!saved.hasMessages || !saved.html) return false;

  els.chatThread.innerHTML = saved.html;
  els.chatThread.querySelectorAll(".chat-empty").forEach((empty) => empty.remove());
  els.chatThread.querySelectorAll(".typing, .stream-cursor").forEach((node) => node.remove());

  for (const body of els.chatThread.querySelectorAll(".chat-message.assistant .chat-body")) {
    if (!body.textContent.trim()) body.closest(".chat-message")?.remove();
  }

  for (const card of els.chatThread.querySelectorAll(".chat-tool.pending")) {
    card.classList.remove("pending");
    card.classList.add("interrupted");
    const stateEl = card.querySelector(".tool-state");
    if (stateEl) stateEl.textContent = "interrupted";
  }

  if (saved.transcriptEmpty) {
    els.transcript.textContent = "Your words will appear here.";
    els.transcript.classList.add("empty");
    els.transcript.removeAttribute("lang");
  } else if (saved.transcriptText) {
    els.transcript.textContent = saved.transcriptText;
    els.transcript.classList.remove("empty");
    if (saved.transcriptLang === "bn" || saved.transcriptLang === "en") {
      els.transcript.lang = saved.transcriptLang;
    }
  }

  state.toolCards.clear();
  state.openAssistant = null;
  state.currentPrompt = null;
  state.runHasText = false;
  state.abortRequested = false;
  state.processing = false;
  setBusy(false);
  hideApproval();
  setStatus("ready", "Ready");

  if (saved.busy) {
    addNotice("", "The previous run stopped when you left this page.");
  }

  requestAnimationFrame(() => {
    els.chatScroll.scrollTop = Number(saved.scrollTop) || els.chatScroll.scrollHeight;
  });
  return true;
}

function setModel(model) {
  els.modelBadge.textContent = model;
  const short = model.includes("/") ? model.split("/").slice(1).join("/") : model;
  els.footerModel.textContent = short;
  els.chatSubtitle.textContent = `pi · ${short}`;
}

function updateComposer() {
  els.chatSend.disabled = !state.connected || state.busy || state.processing;
  els.abort.hidden = !state.busy;
  els.chatInput.placeholder = state.busy
    ? "pi is working…"
    : state.processing
      ? state.language === "bn" ? "Transcribing Bengali…" : "Transcribing…"
      : state.language === "bn" ? "Message pi in Bengali or English…" : "Message pi…";
}

function setLanguage(language, persist = true) {
  const next = language === "bn" ? "bn" : "en";
  state.language = next;
  for (const button of els.langSwitch.querySelectorAll("button[data-lang]")) {
    const active = button.dataset.lang === next;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  if (next === "bn") {
    els.voiceHint.innerHTML = "Speak Bengali. Release to transcribe, translate, and run.";
    els.transcriptLabel.textContent = "Transcript · বাংলা";
    els.transcriptFoot.textContent = "Bengali speech is transcribed and translated locally.";
    els.privacyLabel.textContent = "ASR + translation stay on this machine";
  } else {
    els.voiceHint.innerHTML =
      "Hold <kbd>Space</kbd> or press and hold the mic. Release to transcribe and run.";
    els.transcriptLabel.textContent = "Transcript";
    els.transcriptFoot.textContent = "Voice prompts land here. Type in the chat panel.";
    els.privacyLabel.textContent = "ASR stays on this machine";
  }
  if (persist) {
    try {
      localStorage.setItem("audio-bot-language", next);
    } catch {
      // Language choice is optional; storage can be blocked by privacy settings.
    }
  }
  updateComposer();
}

function savedLanguage() {
  try {
    return localStorage.getItem("audio-bot-language") === "bn" ? "bn" : "en";
  } catch {
    return "en";
  }
}

function isBengaliText(text) {
  return /[\u0980-\u09FF]/.test(text);
}

function setBusy(busy) {
  state.busy = busy;
  updateComposer();
}

function autoResizeComposer() {
  els.chatInput.style.height = "auto";
  els.chatInput.style.height = `${Math.min(els.chatInput.scrollHeight, 160)}px`;
}

function connect() {
  clearTimeout(state.reconnectTimer);
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${protocol}://${location.host}/ws`);
  state.ws = ws;

  ws.addEventListener("open", () => {
    state.connected = true;
    setStatus("ready", "Ready");
    updateComposer();
  });

  ws.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    handleServerMessage(message);
  });

  ws.addEventListener("close", () => {
    state.connected = false;
    state.processing = false;
    setBusy(false);
    finalizeAssistant();
    hideApproval();
    setStatus("", "Disconnected");
    if (state.recording) stopRecording();
    updateComposer();
    state.reconnectTimer = setTimeout(connect, 1500);
  });

  ws.addEventListener("error", () => {
    ws.close();
  });
}

function sendMessage(message) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    showToast("Server connection is not ready yet.", true);
    return false;
  }
  state.ws.send(JSON.stringify(message));
  return true;
}

function handleServerMessage(message) {
  switch (message.type) {
    case "hello":
      setSession(message.sessionId);
      setModel(message.model);
      els.workspaceLabel.textContent = message.workspace;
      els.workspaceLabel.title = message.workspace;
      if (!state.sessionLoaded) {
        state.sessionLoaded = true;
        restoreChatSnapshot(message.sessionId);
      }
      break;
    case "session":
      setSession(message.sessionId);
      resetChat();
      break;
    case "status":
      handleStatus(message);
      break;
    case "transcript":
      setTranscript(message.text, message.language);
      break;
    case "prompt":
      beginPrompt(message.text, message);
      break;
    case "translation":
      setPromptTranslation(message.text, false);
      break;
    case "polished":
      setPromptTranslation(message.text, message.polished !== false);
      break;
    case "agent_status":
      handleStatus({ status: message.status, label: message.detail || undefined });
      break;
    case "agent_delta":
      appendAgentDelta(message.text);
      break;
    case "tool_start":
      addToolCard(message);
      setStatus("working", `Running ${message.tool}...`);
      break;
    case "tool_output":
      updateToolOutput(message);
      break;
    case "tool_end":
      finishToolCard(message);
      break;
    case "approval_request":
      showApproval(message);
      break;
    case "done":
      finishPrompt(message);
      break;
    case "error":
      showError(message.message);
      break;
    case "message":
      showToast(message.message);
      break;
    default:
      break;
  }
}

function handleStatus(message) {
  const status = message.status;
  if (status === "thinking") {
    if (!state.openAssistant) startAssistantMessage();
    setStatus("working", message.label || "Thinking...");
  } else if (status === "transcribing") {
    state.processing = true;
    setStatus("working", message.label || "Transcribing locally...");
    updateComposer();
  } else if (status === "translating") {
    state.processing = true;
    setStatus("working", message.label || "Translating Bengali to English...");
    updateComposer();
  } else if (status === "polishing") {
    state.processing = true;
    setStatus("working", message.label || "Polishing prompt...");
    updateComposer();
  } else if (status === "retrying") {
    setStatus("working", message.detail || "Retrying...");
  } else if (status === "compacting") {
    setStatus("working", "Compacting context...");
  } else if (status === "idle") {
    state.processing = false;
    setStatus("ready", "Ready");
    updateComposer();
  } else {
    setStatus("working", message.label || "Working...");
  }
}

function setTranscript(text, language) {
  els.transcript.textContent = text;
  els.transcript.classList.remove("empty");
  if (language) els.transcript.lang = language === "bn" ? "bn" : "en";
  scheduleChatSave();
}

function clearTranscript() {
  els.transcript.textContent = "Your words will appear here.";
  els.transcript.classList.add("empty");
  els.transcript.removeAttribute("lang");
  scheduleChatSave();
}

function resetChat() {
  clearChatSnapshot();
  finalizeAssistant();
  state.toolCards.clear();
  state.runHasText = false;
  state.abortRequested = false;
  state.openAssistant = null;
  state.currentPrompt = null;
  els.chatThread.textContent = "";
  renderEmptyState();
  clearTranscript();
  hideApproval();
  setBusy(false);
  setStatus("ready", "Ready");
}

function renderEmptyState() {
  const empty = document.createElement("div");
  empty.className = "chat-empty";
  empty.innerHTML = `
    <div class="chat-empty-mark" aria-hidden="true">${SPARKLE_SVG}</div>
    <p class="chat-empty-title">Ask pi to build something</p>
    <p class="chat-empty-copy">Hold Space to talk in English or বাংলা, or type below. pi will plan, use tools in the workspace, and report back.</p>
  `;
  els.chatThread.append(empty);
}

function ensureThread() {
  els.chatThread.querySelector(".chat-empty")?.remove();
}

function chatNearBottom() {
  const el = els.chatScroll;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 160;
}

function scrollChat(force = false) {
  if (!force && !chatNearBottom()) return;
  requestAnimationFrame(() => {
    els.chatScroll.scrollTop = els.chatScroll.scrollHeight;
  });
}

function startAssistantMessage() {
  ensureThread();
  const message = document.createElement("div");
  message.className = "chat-message assistant";

  const avatar = document.createElement("div");
  avatar.className = "chat-avatar";
  avatar.innerHTML = SPARKLE_SVG;

  const content = document.createElement("div");
  content.className = "chat-content";

  const author = document.createElement("div");
  author.className = "chat-author";
  author.textContent = "pi";

  const body = document.createElement("div");
  body.className = "chat-body";
  body.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';

  content.append(author, body);
  message.append(avatar, content);
  els.chatThread.append(message);

  state.openAssistant = { el: message, body, text: "" };
  return state.openAssistant;
}

function appendAgentDelta(text) {
  if (!text) return;
  const stick = chatNearBottom();
  if (!state.openAssistant) startAssistantMessage();
  const open = state.openAssistant;
  open.text += text;
  if (open.text.trim()) state.runHasText = true;
  open.body.innerHTML = `${renderMarkdown(open.text)}<span class="stream-cursor"></span>`;
  if (stick) scrollChat(true);
}

function finalizeAssistant() {
  if (!state.openAssistant) return;
  const open = state.openAssistant;
  state.openAssistant = null;
  open.body.querySelector(".stream-cursor")?.remove();
  if (open.text.trim()) {
    open.body.innerHTML = renderMarkdown(open.text);
  } else {
    open.el.remove();
  }
}

function translationBlock(text, polished) {
  const block = document.createElement("div");
  block.className = "chat-prompt-translation";
  const label = document.createElement("span");
  label.className = "chat-prompt-translation-label";
  label.textContent = polished ? "Polished English" : "English prompt";
  const copy = document.createElement("div");
  copy.className = "chat-prompt-translation-text";
  copy.textContent = text;
  block.append(label, copy);
  return block;
}

function beginPrompt(text, meta = {}) {
  finalizeAssistant();
  setBusy(true);
  state.processing = false;
  state.runHasText = false;
  state.abortRequested = false;
  ensureThread();

  const prompt = document.createElement("div");
  prompt.className = "chat-message user";
  const bubble = document.createElement("div");
  bubble.className = "chat-bubble";
  if (meta.language === "bn") bubble.lang = "bn";

  const original = document.createElement("div");
  original.className = "chat-bubble-text";
  original.textContent = text;
  bubble.append(original);

  let block = null;
  let pending = null;
  if (meta.english) {
    block = translationBlock(meta.english, Boolean(meta.polished));
    bubble.append(block);
  } else if (meta.language === "bn") {
    pending = document.createElement("div");
    pending.className = "chat-prompt-status";
    pending.textContent = "Translating to English…";
    bubble.append(pending);
  }

  prompt.append(bubble);
  els.chatThread.append(prompt);
  state.currentPrompt = { el: prompt, bubble, block, pending };

  if (!pending) startAssistantMessage();
  setStatus("working", pending ? "Translating Bengali..." : "Asking pi...");
  updateComposer();
  scrollChat(true);
}

function setPromptTranslation(text, polished) {
  const prompt = state.currentPrompt;
  if (!prompt) return;

  if (prompt.pending) {
    prompt.pending.remove();
    prompt.pending = null;
  }

  if (prompt.block) {
    prompt.block.querySelector(".chat-prompt-translation-label").textContent = polished
      ? "Polished English"
      : "English prompt";
    prompt.block.querySelector(".chat-prompt-translation-text").textContent = text;
  } else {
    prompt.block = translationBlock(text, polished);
    prompt.bubble.append(prompt.block);
  }
  scrollChat();
}

function finishPrompt(message) {
  if (state.currentPrompt?.pending) {
    state.currentPrompt.pending.remove();
    state.currentPrompt.pending = null;
  }
  if (message.text && !state.runHasText) {
    const open = state.openAssistant || startAssistantMessage();
    open.text = message.text;
    state.runHasText = Boolean(message.text.trim());
    open.body.innerHTML = renderMarkdown(message.text);
  }
  finalizeAssistant();

  if (message.aborted) {
    addNotice("", "Stopped by user.");
  }

  state.abortRequested = false;
  state.processing = false;
  setBusy(false);
  setStatus("ready", "Ready");
  hideApproval();
  if (message.sessionId) setSession(message.sessionId);
  updateComposer();
  scrollChat();
}

function addNotice(kind, text) {
  ensureThread();
  const notice = document.createElement("div");
  notice.className = `chat-notice${kind ? ` ${kind}` : ""}`;
  const icon = document.createElement("span");
  icon.className = "notice-icon";
  icon.textContent = kind === "error" ? "!" : "i";
  const copy = document.createElement("div");
  copy.className = "notice-copy";
  copy.textContent = text;
  notice.append(icon, copy);
  els.chatThread.append(notice);
}

function showError(message) {
  finalizeAssistant();
  const stick = chatNearBottom();
  addNotice("error", message);
  if (state.currentPrompt?.pending) {
    state.currentPrompt.pending.textContent = "Could not translate this prompt.";
    state.currentPrompt.pending.classList.add("error");
    state.currentPrompt.pending = null;
  }
  state.abortRequested = false;
  state.processing = false;
  setBusy(false);
  setStatus("", "Needs attention");
  hideApproval();
  showToast(message, true);
  if (stick) scrollChat(true);
}

function toolIcon(tool) {
  return TOOL_ICONS[tool] || FALLBACK_TOOL_ICON;
}

function formatToolTarget(tool, args) {
  if (!args || typeof args !== "object") return "";
  if (tool === "bash") return String(args.command || "").split("\n")[0].trim();
  const target = args.path || args.file_path || args.filePath || args.target || args.filename;
  if (target) return String(target);
  if (args.query) return String(args.query);
  if (args.pattern) return String(args.pattern);
  return "";
}

function truncate(value, limit) {
  const text = String(value);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function formatToolArgs(args) {
  try {
    return truncate(JSON.stringify(args ?? {}, null, 2), 6000);
  } catch {
    return String(args ?? "");
  }
}

function addToolCard(message) {
  finalizeAssistant();
  ensureThread();

  const existing = state.toolCards.get(message.toolCallId);
  if (existing) {
    existing.nameEl.textContent = message.tool;
    existing.targetEl.textContent = truncate(formatToolTarget(message.tool, message.args), 120);
    existing.argsPre.textContent = formatToolArgs(message.args);
    return existing;
  }

  const stick = chatNearBottom();
  const card = document.createElement("div");
  card.className = "chat-tool pending";

  const head = document.createElement("button");
  head.type = "button";
  head.className = "chat-tool-head";
  head.setAttribute("aria-expanded", "false");

  const glyph = document.createElement("span");
  glyph.className = "tool-glyph";
  glyph.innerHTML = toolIcon(message.tool);

  const copy = document.createElement("span");
  copy.className = "tool-copy";
  const nameEl = document.createElement("span");
  nameEl.className = "tool-name";
  nameEl.textContent = message.tool;
  const targetEl = document.createElement("span");
  targetEl.className = "tool-target";
  targetEl.textContent = truncate(formatToolTarget(message.tool, message.args), 120);
  copy.append(nameEl, targetEl);

  const stateEl = document.createElement("span");
  stateEl.className = "tool-state";
  stateEl.textContent = "running";

  const chevron = document.createElement("span");
  chevron.className = "tool-chevron";
  chevron.textContent = "›";

  head.append(glyph, copy, stateEl, chevron);

  const detail = document.createElement("div");
  detail.className = "chat-tool-detail";
  detail.hidden = true;

  const argsLabel = document.createElement("div");
  argsLabel.className = "tool-section-label";
  argsLabel.textContent = "Arguments";
  const argsPre = document.createElement("pre");
  argsPre.className = "tool-args";
  argsPre.textContent = formatToolArgs(message.args);

  const outputWrap = document.createElement("div");
  outputWrap.className = "tool-output-wrap";
  outputWrap.hidden = true;
  const outputLabel = document.createElement("div");
  outputLabel.className = "tool-section-label";
  outputLabel.textContent = "Output";
  const outputPre = document.createElement("pre");
  outputPre.className = "tool-output";
  outputWrap.append(outputLabel, outputPre);

  detail.append(argsLabel, argsPre, outputWrap);
  card.append(head, detail);
  els.chatThread.append(card);

  const record = {
    el: card,
    head,
    stateEl,
    detail,
    argsPre,
    outputWrap,
    outputPre,
    nameEl,
    targetEl,
    tool: message.tool,
    args: message.args,
    output: ""
  };
  state.toolCards.set(message.toolCallId, record);
  if (stick) scrollChat(true);
  return record;
}

function updateToolOutput(message) {
  const card = state.toolCards.get(message.toolCallId);
  if (!card) return;
  card.output += message.text;
  card.outputPre.textContent = truncate(card.output, 12000);
  card.outputWrap.hidden = false;
}

function finishToolCard(message) {
  let card = state.toolCards.get(message.toolCallId);
  if (!card) {
    card = addToolCard({
      toolCallId: message.toolCallId,
      tool: message.tool,
      args: {}
    });
  }
  if (!card) return;

  card.el.classList.remove("pending", "waiting");
  card.el.classList.toggle("ok", !message.isError);
  card.el.classList.toggle("fail", Boolean(message.isError));
  card.stateEl.textContent = message.isError ? "failed" : "done";

  if (message.text) {
    card.output = message.text;
  }
  if (card.output) {
    card.outputPre.textContent = truncate(card.output, 12000);
    card.outputWrap.hidden = false;
  }

  if (message.isError) {
    card.detail.hidden = false;
    card.head.setAttribute("aria-expanded", "true");
    card.el.classList.add("open");
  }
}

function findToolCard(toolCallId) {
  return state.toolCards.get(toolCallId);
}

function renderApprovalDetail(tool, detail) {
  els.approvalDetail.textContent = "";
  if (!detail) return;

  const addField = (label, value) => {
    if (!value) return;
    const field = document.createElement("div");
    field.className = "field";
    const fieldLabel = document.createElement("span");
    fieldLabel.className = "field-label";
    fieldLabel.textContent = label;
    const pre = document.createElement("pre");
    pre.textContent = value;
    field.append(fieldLabel, pre);
    els.approvalDetail.append(field);
  };

  if (tool === "bash") {
    addField("command", detail.command);
    addField("working directory", detail.cwd);
  } else if (tool === "write" || tool === "edit") {
    addField("path", detail.path);
    addField("preview", detail.preview || detail.newText);
    addField("replacing", detail.oldText);
  } else {
    addField("arguments", detail.raw);
  }
}

function showApproval(message) {
  let card = findToolCard(message.toolCallId);
  if (!card) {
    const args = message.detail?.command
      ? { command: message.detail.command }
      : message.detail?.path
        ? { path: message.detail.path }
        : {};
    card = addToolCard({
      toolCallId: message.toolCallId,
      tool: message.tool,
      args
    });
  }
  if (card) {
    card.el.classList.remove("pending", "ok", "fail");
    card.el.classList.add("waiting");
    card.stateEl.textContent = "waiting";
  }

  state.currentApproval = message;
  els.approvalTool.textContent = message.tool;
  renderApprovalDetail(message.tool, message.detail);
  els.approvalRemember.checked = false;
  els.approvalModal.hidden = false;
  setStatus("working", "Waiting for approval...");
  els.denyButton.focus();
}

function hideApproval() {
  els.approvalModal.hidden = true;
  state.currentApproval = null;
}

function respondApproval(allow) {
  const approval = state.currentApproval;
  if (!approval) return;

  const card = findToolCard(approval.toolCallId);
  if (card) {
    card.el.classList.remove("waiting", "ok", "fail");
    card.el.classList.add(allow ? "pending" : "fail");
    card.stateEl.textContent = allow ? "running" : "denied";
  }

  sendMessage({
    type: "approval",
    id: approval.id,
    tool: approval.tool,
    allow,
    remember: allow && els.approvalRemember.checked
  });
  hideApproval();
  setStatus("working", allow ? "Approved. Continuing..." : "Denied. Continuing...");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return character;
    }
  });
}

function safeUrl(value) {
  const raw = String(value).replace(/&amp;/g, "&").trim();
  try {
    const url = new URL(raw, location.origin);
    if (!["http:", "https:", "mailto:"].includes(url.protocol)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function formatInline(line) {
  const code = [];
  let text = escapeHtml(line).replace(/`([^`]+)`/g, (_, content) => {
    const token = `\u0000${code.length}\u0000`;
    code.push(`<code>${content}</code>`);
    return token;
  });

  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, url) => {
    const href = safeUrl(url);
    if (!href) return match;
    return `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer noopener">${label}</a>`;
  });

  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  text = text.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  text = text.replace(/\u0000(\d+)\u0000/g, (_, index) => code[Number(index)] || "");
  return text;
}

function renderCodeBlock(code, language) {
  const label = /^[\w.+-]+$/.test(language) ? language : "code";
  return `<div class="code-block"><div class="code-head"><span>${escapeHtml(label)}</span><button class="code-copy" type="button">Copy</button></div><pre><code>${escapeHtml(code)}</code></pre></div>`;
}

function renderMarkdown(markdown) {
  const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
  const html = [];
  let paragraph = [];
  let list = null;
  let listType = null;
  let quote = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${paragraph.map(formatInline).join("<br>")}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    html.push(`<${listType}>${list.join("")}</${listType}>`);
    list = null;
    listType = null;
  };
  const flushQuote = () => {
    if (!quote.length) return;
    html.push(`<blockquote>${quote.map(formatInline).join("<br>")}</blockquote>`);
    quote = [];
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const fence = line.match(/^\s*```\s*([\w.+-]*)\s*$/);

    if (fence) {
      flushAll();
      const code = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      html.push(renderCodeBlock(code.join("\n"), fence[1] || ""));
      continue;
    }

    if (!line.trim()) {
      flushAll();
      index += 1;
      continue;
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      flushAll();
      html.push("<hr>");
      index += 1;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushAll();
      const level = heading[1].length;
      html.push(`<h${level}>${formatInline(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }

    const quoted = line.match(/^\s*>\s?(.*)$/);
    if (quoted) {
      flushParagraph();
      flushList();
      quote.push(quoted[1]);
      index += 1;
      continue;
    }

    const listItem = line.match(/^\s*([-*+]|\d+\.)\s+(.*)$/);
    if (listItem) {
      flushParagraph();
      flushQuote();
      const type = /\d+\./.test(listItem[1]) ? "ol" : "ul";
      if (listType && listType !== type) flushList();
      listType = type;
      list ||= [];
      list.push(`<li>${formatInline(listItem[2])}</li>`);
      index += 1;
      continue;
    }

    flushList();
    flushQuote();
    paragraph.push(line);
    index += 1;
  }

  flushAll();
  return html.join("");
}

async function copyCode(button) {
  const code = button.closest(".code-block")?.querySelector("code");
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code.textContent || "");
    button.textContent = "Copied";
    setTimeout(() => {
      button.textContent = "Copy";
    }, 1400);
  } catch {
    showToast("Could not copy the code block.", true);
  }
}

async function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function ensureMicrophone() {
  if (state.mediaStream) return state.mediaStream;
  state.mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  });

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  state.audioContext = new AudioContextClass();
  const source = state.audioContext.createMediaStreamSource(state.mediaStream);
  state.analyser = state.audioContext.createAnalyser();
  state.analyser.fftSize = 1024;
  source.connect(state.analyser);
  return state.mediaStream;
}

function startLevelMeter() {
  if (!state.analyser) return;
  const data = new Uint8Array(state.analyser.fftSize);
  const tick = () => {
    if (!state.recording || !state.analyser) {
      document.documentElement.style.setProperty("--level", "0");
      return;
    }
    state.analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (const value of data) {
      const centered = (value - 128) / 128;
      sum += centered * centered;
    }
    const rms = Math.sqrt(sum / data.length);
    const level = Math.min(1, rms * 5.5);
    document.documentElement.style.setProperty("--level", level.toFixed(3));
    state.levelRaf = requestAnimationFrame(tick);
  };
  tick();
}

function updateRecordTimer() {
  const seconds = Math.floor((Date.now() - state.recordStartedAt) / 1000);
  const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");
  els.recordTimer.textContent = `${mm}:${ss}`;
}

async function startRecording() {
  if (state.recording || state.busy || state.processing || !state.connected) return;
  if (els.approvalModal.hidden === false) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    showToast("This browser does not support microphone capture.", true);
    return;
  }

  try {
    const stream = await ensureMicrophone();
    if (state.audioContext?.state === "suspended") await state.audioContext.resume();

    const candidates = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/mp4"
    ];
    const mimeType = candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

    state.chunks = [];
    state.mediaRecorder = recorder;
    state.recording = true;
    state.recordStartedAt = Date.now();

    recorder.addEventListener("dataavailable", (event) => {
      if (event.data && event.data.size > 0) state.chunks.push(event.data);
    });

    recorder.addEventListener("stop", async () => {
      const blob = new Blob(state.chunks, { type: recorder.mimeType || "audio/webm" });
      state.chunks = [];
      if (blob.size === 0) {
        showToast("No audio was captured.", true);
        state.processing = false;
        setStatus("ready", "Ready");
        updateComposer();
        return;
      }
      state.processing = true;
      setStatus(
        "working",
        state.language === "bn" ? "Transcribing Bengali..." : "Transcribing locally..."
      );
      updateComposer();
      const data = await blobToBase64(blob);
      if (
        !sendMessage({
          type: "audio",
          data,
          mime: blob.type || "audio/webm",
          language: state.language
        })
      ) {
        state.processing = false;
        updateComposer();
      }
    });

    recorder.start(200);
    els.talkButton.classList.add("recording");
    els.talkLabel.textContent = "Listening…";
    els.recordTimer.textContent = "00:00";
    setStatus("recording", "Recording (max 60s)");
    state.recordTimer = setInterval(updateRecordTimer, 200);
    state.recordLimitTimer = setTimeout(() => {
      if (state.recording) stopRecording();
    }, MAX_RECORDING_MS);
    startLevelMeter();
  } catch (error) {
    state.recording = false;
    clearTimeout(state.recordLimitTimer);
    state.recordLimitTimer = null;
    showToast(`Microphone unavailable: ${error.message}`, true);
    setStatus("", "Microphone blocked");
  }
}

function stopRecording() {
  if (!state.recording) return;
  state.recording = false;
  clearInterval(state.recordTimer);
  state.recordTimer = null;
  clearTimeout(state.recordLimitTimer);
  state.recordLimitTimer = null;
  cancelAnimationFrame(state.levelRaf);
  state.levelRaf = null;
  document.documentElement.style.setProperty("--level", "0");
  els.talkButton.classList.remove("recording");
  els.talkLabel.textContent = "Hold to talk";
  els.recordTimer.textContent = "00:00";

  const recorder = state.mediaRecorder;
  state.mediaRecorder = null;
  if (recorder && recorder.state !== "inactive") {
    recorder.stop();
  } else {
    setStatus("ready", "Ready");
  }
}

function newSession() {
  if (state.busy || state.processing) {
    showToast("Stop the current run before starting a new session.", true);
    return;
  }
  sendMessage({ type: "new_session" });
}

function isTypingTarget(target) {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target?.isContentEditable
  );
}

function isInteractiveTarget(target) {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest("button, a, select, input, textarea, [role='button']"));
}

async function pollHealth() {
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    const health = await response.json();
    const llamaOk = health.llama?.ok;
    const piOk = health.pi?.ok;
    if (llamaOk && piOk) {
      els.healthDot.className = "health good";
      els.healthDot.title = "Local ASR and pi are ready.";
    } else if (llamaOk || piOk) {
      els.healthDot.className = "health partial";
      els.healthDot.title = [
        `ASR: ${llamaOk ? "ready" : "unavailable"}`,
        `pi: ${piOk ? "ready" : "unavailable"}`
      ].join(" · ");
    } else {
      els.healthDot.className = "health bad";
      els.healthDot.title = "ASR and pi are both unavailable.";
    }
    if (health.bengali && state.language === "bn") {
      if (health.bengali.asr && health.bengali.translator?.ok) {
        els.healthDot.title += " Bengali ready.";
      } else {
        if (els.healthDot.className === "health good") els.healthDot.className = "health partial";
        els.healthDot.title += " Bengali unavailable.";
      }
    }
    if (health.model) setModel(health.model);
    if (health.workspace) {
      els.workspaceLabel.textContent = health.workspace;
      els.workspaceLabel.title = health.workspace;
    }
  } catch {
    els.healthDot.className = "health bad";
    els.healthDot.title = "Voice bot server is unreachable.";
  }
}

els.talkButton.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  els.talkButton.setPointerCapture?.(event.pointerId);
  startRecording();
});

window.addEventListener("pointerup", () => stopRecording());
window.addEventListener("pointercancel", () => stopRecording());

window.addEventListener("keydown", (event) => {
  if (event.code === "Escape" && !els.approvalModal.hidden) {
    respondApproval(false);
    return;
  }
  if (event.code !== "Space" || isInteractiveTarget(event.target) || !els.approvalModal.hidden) return;
  event.preventDefault();
  if (!event.repeat) startRecording();
});

window.addEventListener("keyup", (event) => {
  if (event.code !== "Space") return;
  event.preventDefault();
  stopRecording();
});

window.addEventListener("blur", () => stopRecording());
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopRecording();
});

els.chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = els.chatInput.value.trim();
  if (!text) return;
  if (!state.connected) {
    showToast("Server connection is not ready yet.", true);
    return;
  }
  if (state.busy || state.processing) {
    showToast("Wait for the current run to finish.", true);
    return;
  }
  const bengali = isBengaliText(text);
  if (!sendMessage({ type: "prompt", text, language: bengali ? "bn" : "en" })) return;
  els.chatInput.value = "";
  autoResizeComposer();
  setTranscript(text, bengali ? "bn" : "en");
  setBusy(true);
  setStatus("working", bengali ? "Translating Bengali..." : "Asking pi...");
});

els.chatInput.addEventListener("input", autoResizeComposer);
els.chatInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  els.chatForm.requestSubmit();
});

els.chatThread.addEventListener("click", (event) => {
  const copy = event.target.closest?.(".code-copy");
  if (copy) {
    copyCode(copy);
    return;
  }
  const head = event.target.closest?.(".chat-tool-head");
  if (!head) return;
  const card = head.closest(".chat-tool");
  const detail = card?.querySelector(".chat-tool-detail");
  if (!detail) return;
  detail.hidden = !detail.hidden;
  head.setAttribute("aria-expanded", String(!detail.hidden));
  card.classList.toggle("open", !detail.hidden);
});

els.clearTranscript.addEventListener("click", clearTranscript);
els.langSwitch.addEventListener("click", (event) => {
  const button = event.target.closest?.("button[data-lang]");
  if (!button) return;
  if (state.recording || state.busy || state.processing) {
    showToast("Finish the current request before switching language.", true);
    return;
  }
  setLanguage(button.dataset.lang);
});
els.newSession.addEventListener("click", newSession);
els.abort.addEventListener("click", () => {
  if (!state.busy) return;
  state.abortRequested = true;
  sendMessage({ type: "abort" });
  setStatus("working", "Stopping...");
});
els.allowButton.addEventListener("click", () => respondApproval(true));
els.denyButton.addEventListener("click", () => respondApproval(false));
els.approvalModal.addEventListener("click", (event) => {
  if (event.target === els.approvalModal) respondApproval(false);
});

const chatObserver = new MutationObserver(scheduleChatSave);
chatObserver.observe(els.chatThread, {
  childList: true,
  subtree: true,
  characterData: true
});

window.addEventListener("pagehide", saveChatSnapshot);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") saveChatSnapshot();
});

setLanguage(savedLanguage(), false);
autoResizeComposer();
updateComposer();
connect();
pollHealth();
setInterval(pollHealth, 15000);
