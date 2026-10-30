import express from "express";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WebSocketServer, WebSocket } from "ws";
import { config, newRunId, newSessionId, readOnlyTools } from "./config.js";
import { transcribe } from "./asr.js";
import { convertToWav } from "./audio.js";
import { startAgent } from "./agent.js";
import {
  bengaliHealth,
  isBengali,
  polishEnglishPrompt,
  transcribeBengali,
  translateBengali
} from "./bengali.js";

const execFileAsync = promisify(execFile);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const clients = new Set();
const pendingApprovals = new Map();

let currentSessionId = newSessionId();
let activeRun = null;
let asrBusy = false;
let preparingPrompt = false;

const sessionIdPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

async function persistSession() {
  await fs
    .writeFile(config.sessionFile, `${JSON.stringify({ sessionId: currentSessionId })}\n`)
    .catch(() => {});
}

async function restoreSession() {
  try {
    const stored = JSON.parse(await fs.readFile(config.sessionFile, "utf8"));
    if (typeof stored.sessionId === "string" && sessionIdPattern.test(stored.sessionId)) {
      currentSessionId = stored.sessionId;
    }
  } catch {
    return;
  }
}
let piVersionCache = { value: null, checkedAt: 0, error: null };

app.use(express.json({ limit: "8mb" }));
app.use(express.static(path.join(config.root, "public")));

function send(ws, event) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(event));
  }
}

function broadcast(event) {
  for (const client of clients) send(client, event);
}

async function audit(event) {
  const line = `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`;
  try {
    await fs.appendFile(path.join(config.dataDir, "audit.log"), line);
  } catch {
    return;
  }
}

function isInsideWorkspace(candidate) {
  if (typeof candidate !== "string" || !candidate.trim()) return false;
  const resolved = path.resolve(config.workspace, candidate);
  return resolved === config.workspace || resolved.startsWith(`${config.workspace}${path.sep}`);
}

const WORKSPACE_MAX_ENTRIES = 4000;
const WORKSPACE_MAX_DEPTH = 12;
const WORKSPACE_MAX_EDIT_BYTES = 1024 * 1024;

let workspaceRealRoot = null;

async function getWorkspaceRealRoot() {
  if (!workspaceRealRoot) {
    workspaceRealRoot = await fs.realpath(config.workspace);
  }
  return workspaceRealRoot;
}

function workspaceTarget(input) {
  if (typeof input !== "string" || !input || input.includes("\0")) return null;
  if (path.isAbsolute(input)) return null;
  const full = path.resolve(config.workspace, input);
  if (!isInsideWorkspace(full)) return null;
  const relative = path.relative(config.workspace, full);
  const segments = relative ? relative.split(path.sep) : [];
  if (segments.includes(".git")) return null;
  return { full, rel: segments.join("/") };
}

async function workspaceFile(input) {
  const target = workspaceTarget(input);
  if (!target || !target.rel) {
    return { error: "Invalid file path.", status: 400 };
  }

  let stat;
  try {
    stat = await fs.lstat(target.full);
  } catch {
    return { error: "File not found.", status: 404 };
  }

  if (stat.isSymbolicLink()) {
    return { error: "Symlinks are not followed.", status: 403 };
  }
  if (!stat.isFile()) {
    return { error: "That path is not a regular file.", status: 400 };
  }

  const root = await getWorkspaceRealRoot();
  let real;
  try {
    real = await fs.realpath(target.full);
  } catch {
    return { error: "File not found.", status: 404 };
  }

  const relativeReal = path.relative(root, real);
  if (relativeReal.startsWith("..") || path.isAbsolute(relativeReal) || relativeReal.split(path.sep).includes(".git")) {
    return { error: "Path is outside the workspace.", status: 403 };
  }

  return { ...target, stat, real };
}

async function readWorkspaceTree(dir, base, depth, state) {
  if (depth > WORKSPACE_MAX_DEPTH || state.count >= WORKSPACE_MAX_ENTRIES) {
    state.truncated = true;
    return [];
  }

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  entries.sort((left, right) => {
    const leftDir = left.isDirectory() ? 0 : 1;
    const rightDir = right.isDirectory() ? 0 : 1;
    if (leftDir !== rightDir) return leftDir - rightDir;
    return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
  });

  const result = [];
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    if (state.count >= WORKSPACE_MAX_ENTRIES) {
      state.truncated = true;
      break;
    }

    const full = path.join(dir, entry.name);
    const relative = base ? `${base}/${entry.name}` : entry.name;
    let stat;
    try {
      stat = await fs.lstat(full);
    } catch {
      continue;
    }

    const type = entry.isSymbolicLink()
      ? "symlink"
      : entry.isDirectory()
        ? "dir"
        : entry.isFile()
          ? "file"
          : "other";
    const node = {
      name: entry.name,
      path: relative,
      type,
      size: stat.size,
      mtimeMs: stat.mtimeMs
    };

    state.count += 1;
    if (type === "dir") {
      node.children = await readWorkspaceTree(full, relative, depth + 1, state);
    }
    result.push(node);
  }

  return result;
}

function argPath(args) {
  if (!args || typeof args !== "object") return null;
  for (const key of ["path", "file_path", "filePath", "target", "filename"]) {
    if (typeof args[key] === "string") return args[key];
  }
  return null;
}

const dangerousCommandPatterns = [
  /(^|[\s;&|])sudo(\s|$)/,
  /(^|[\s;&|])su(\s|$)/,
  /\brm\s+(-[^\s]*\s+)*\/(\s|$)/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bpoweroff\b/,
  /\bgit\s+push\b/,
  /\bchmod\s+-R\s+777\s+\//,
  /\b(curl|wget)[^|]*\|\s*(ba)?sh\b/
];

function dangerousCommand(command) {
  if (typeof command !== "string") return null;
  return dangerousCommandPatterns.find((pattern) => pattern.test(command)) || null;
}

function truncateString(value, limit) {
  if (typeof value !== "string" || value.length <= limit) return value;
  return `${value.slice(0, limit)}\n... (${value.length - limit} chars truncated)`;
}

function summarizeToolArgs(args) {
  if (!args || typeof args !== "object") return {};
  const limits = {
    command: 4000,
    content: 2000,
    oldText: 1200,
    newText: 1200,
    path: 1000,
    file_path: 1000,
    filePath: 1000,
    target: 1000,
    filename: 1000,
    query: 1000,
    pattern: 1000,
    cwd: 1000
  };
  const summary = {};
  for (const [key, limit] of Object.entries(limits)) {
    if (args[key] === undefined) continue;
    summary[key] = truncateString(args[key], limit);
  }
  if (Object.keys(summary).length > 0) return summary;
  const serialized = JSON.stringify(args, null, 2);
  return serialized.length > 2000 ? { preview: `${serialized.slice(0, 2000)}\n...` } : args;
}

function toolDetail(tool, args) {
  if (tool === "bash") {
    return {
      command: typeof args?.command === "string" ? args.command : "",
      cwd: typeof args?.cwd === "string" ? args.cwd : config.workspace
    };
  }
  if (tool === "write") {
    return {
      path: argPath(args) || "",
      preview: typeof args?.content === "string" ? args.content.slice(0, 1500) : ""
    };
  }
  if (tool === "edit") {
    return {
      path: argPath(args) || "",
      oldText: typeof args?.oldText === "string" ? args.oldText.slice(0, 800) : "",
      newText: typeof args?.newText === "string" ? args.newText.slice(0, 800) : ""
    };
  }
  const serialized = JSON.stringify(args ?? {}, null, 2);
  return { raw: serialized.length > 2000 ? `${serialized.slice(0, 2000)}\n...` : serialized };
}

function denyAllPending(reason) {
  for (const [id, pending] of pendingApprovals) {
    pending.resolve({ allow: false, reason });
    pendingApprovals.delete(id);
  }
}

function requestApproval({ runId, tool, toolCallId, args }) {
  if (!activeRun || activeRun.runId !== runId) {
    return Promise.resolve({ allow: false, reason: "No active agent run" });
  }
  if (readOnlyTools.has(tool)) {
    return Promise.resolve({ allow: true });
  }
  if ((tool === "write" || tool === "edit") && isInsideWorkspace(argPath(args))) {
    return Promise.resolve({ allow: true });
  }
  if (tool === "bash") {
    const blocked = dangerousCommand(args?.command);
    if (blocked) {
      audit({
        event: "approval_denied",
        runId,
        tool,
        toolCallId,
        reason: "dangerous_command",
        command: args?.command
      });
      return Promise.resolve({
        allow: false,
        reason: "Blocked by the voice-bot safety policy (privileged or destructive command)."
      });
    }
  }
  if (activeRun.allowedTools.has(tool)) {
    return Promise.resolve({ allow: true });
  }

  const target = activeRun.ws;
  if (!target || target.readyState !== WebSocket.OPEN) {
    return Promise.resolve({
      allow: false,
      reason: "No browser is connected to approve this tool call."
    });
  }

  const approvalId = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingApprovals.delete(approvalId);
      audit({ event: "approval_timeout", runId, tool, toolCallId, approvalId });
      resolve({ allow: false, reason: "Approval timed out." });
    }, config.pi.approvalTimeoutMs);

    pendingApprovals.set(approvalId, {
      resolve: (decision) => {
        clearTimeout(timer);
        resolve(decision);
      }
    });

    audit({ event: "approval_requested", runId, tool, toolCallId, approvalId });
    send(target, {
      type: "approval_request",
      id: approvalId,
      tool,
      toolCallId,
      detail: toolDetail(tool, args)
    });
  });
}

async function prepareBengaliPrompt(text, ws, source) {
  const original = text.trim();
  send(ws, { type: "prompt", text: original, language: "bn" });
  audit({ event: "bengali_prompt", text: original, source });

  send(ws, { type: "status", status: "translating", label: "Translating Bengali to English..." });
  const translation = await translateBengali(original);
  await audit({
    event: "translation",
    source,
    sourceText: original,
    english: translation.english,
    ms: translation.ms
  });
  send(ws, { type: "translation", text: translation.english });

  send(ws, { type: "status", status: "polishing", label: "Polishing prompt..." });
  const polished = await polishEnglishPrompt({
    bengali: original,
    english: translation.english
  });
  await audit({
    event: "polish",
    source,
    model: polished.model,
    polished: polished.polished,
    text: polished.text,
    error: polished.error || null
  });
  send(ws, {
    type: "polished",
    text: polished.text,
    model: polished.model,
    polished: polished.polished
  });

  return {
    original,
    english: translation.english,
    polished: polished.text,
    usedPolish: polished.polished
  };
}

async function runPrompt(prompt, ws, meta = {}) {
  if (activeRun || asrBusy || preparingPrompt) {
    send(ws, { type: "error", message: "Another request is already in progress." });
    return;
  }

  const text = prompt.trim();
  if (!text) {
    send(ws, { type: "error", message: "The transcript was empty." });
    return;
  }

  const runId = newRunId();
  const approvalToken = crypto.randomBytes(24).toString("hex");
  const sessionId = currentSessionId;

  if (!meta.skipPromptEvent) {
    send(ws, {
      type: "prompt",
      text: meta.displayText || text,
      english: meta.english || null,
      language: meta.language || "en"
    });
  }
  send(ws, { type: "status", status: "thinking", label: "Asking pi..." });
  audit({
    event: "prompt",
    runId,
    sessionId,
    text,
    displayText: meta.displayText || null,
    english: meta.english || null,
    language: meta.language || "en",
    translated: Boolean(meta.translated)
  });

  let runner;
  runner = startAgent({
    prompt: text,
    sessionId,
    runId,
    approvalUrl: `http://127.0.0.1:${config.port}/internal/approval`,
    approvalToken,
    onEvent: (event) => {
      if (event.type === "tool_start") {
        const args = summarizeToolArgs(event.args);
        audit({ event: "tool_start", runId, tool: event.tool, args });
        send(ws, { ...event, args });
        return;
      }
      if (event.type === "tool_end") {
        audit({
          event: "tool_end",
          runId,
          tool: event.tool,
          isError: event.isError,
          text: truncateString(event.text, 4000)
        });
      }
      send(ws, event);
    }
  });

  activeRun = {
    runId,
    token: approvalToken,
    ws,
    sessionId,
    abort: () => runner.abort(),
    allowedTools: new Set()
  };

  try {
    const result = await runner.promise;
    await audit({
      event: "agent_done",
      runId,
      sessionId,
      aborted: result.aborted,
      text: result.text
    });
    send(ws, { type: "done", sessionId, text: result.text });
  } catch (error) {
    await audit({ event: "agent_error", runId, sessionId, message: error.message });
    if (error.message === "Agent run stopped by user.") {
      send(ws, { type: "done", sessionId, text: "", aborted: true });
    } else {
      send(ws, { type: "error", message: error.message });
      send(ws, { type: "done", sessionId, text: "" });
    }
  } finally {
    activeRun = null;
    denyAllPending("Agent run finished.");
  }
}

function extensionForMime(mime) {
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("mp4") || mime.includes("m4a")) return "m4a";
  if (mime.includes("wav")) return "wav";
  return "webm";
}

async function handleAudio({ data, mime, language }, ws) {
  if (activeRun || asrBusy || preparingPrompt) {
    send(ws, { type: "error", message: "Another request is already in progress." });
    return;
  }

  const buffer = Buffer.from(data, "base64");
  if (buffer.length === 0) {
    send(ws, { type: "error", message: "The recording was empty." });
    return;
  }
  if (buffer.length > 30 * 1024 * 1024) {
    send(ws, { type: "error", message: "The recording is too large." });
    return;
  }

  const bengaliMode = language === "bn";
  if (bengaliMode && !config.bengali.enabled) {
    send(ws, { type: "error", message: "Bengali support is disabled." });
    return;
  }
  const id = newRunId();
  const extension = extensionForMime(mime || "");
  const rawPath = path.join(config.audioDir, `${id}.${extension}`);
  const wavPath = path.join(config.audioDir, `${id}.16k.wav`);

  asrBusy = true;
  try {
    await fs.writeFile(rawPath, buffer);
    send(ws, {
      type: "status",
      status: "transcribing",
      label: bengaliMode ? "Transcribing Bengali locally..." : "Transcribing locally..."
    });
    await convertToWav(rawPath, wavPath);

    const transcript = bengaliMode
      ? await transcribeBengali(wavPath)
      : await transcribe(wavPath);
    await audit({ event: "transcript", text: transcript, language: bengaliMode ? "bn" : "en" });
    send(ws, { type: "transcript", text: transcript, language: bengaliMode ? "bn" : "en" });

    if (bengaliMode) {
      const prepared = await prepareBengaliPrompt(transcript, ws, "voice");
      asrBusy = false;
      if (ws.readyState !== WebSocket.OPEN) return;
      await runPrompt(prepared.polished, ws, {
        skipPromptEvent: true,
        displayText: prepared.original,
        english: prepared.polished,
        language: "bn",
        translated: true
      });
    } else {
      asrBusy = false;
      await runPrompt(transcript, ws, { language: "en" });
    }
  } catch (error) {
    await audit({ event: "asr_error", language: bengaliMode ? "bn" : "en", message: error.message });
    send(ws, { type: "error", message: error.message });
    send(ws, { type: "done", text: "" });
  } finally {
    asrBusy = false;
    await fs.rm(rawPath, { force: true }).catch(() => {});
    await fs.rm(wavPath, { force: true }).catch(() => {});
  }
}

async function handlePrompt(message, ws) {
  const raw = String(message.text || "").trim();
  if (!raw) {
    send(ws, { type: "error", message: "The prompt was empty." });
    return;
  }

  const bengaliMode = message.language === "bn" || isBengali(raw);
  if (bengaliMode && !config.bengali.enabled) {
    send(ws, { type: "error", message: "Bengali support is disabled." });
    return;
  }
  if (!bengaliMode) {
    await runPrompt(raw, ws, { language: "en" });
    return;
  }

  if (activeRun || asrBusy || preparingPrompt) {
    send(ws, { type: "error", message: "Another request is already in progress." });
    return;
  }

  preparingPrompt = true;
  try {
    const prepared = await prepareBengaliPrompt(raw, ws, "typed");
    preparingPrompt = false;
    if (ws.readyState !== WebSocket.OPEN) return;
    await runPrompt(prepared.polished, ws, {
      skipPromptEvent: true,
      displayText: prepared.original,
      english: prepared.polished,
      language: "bn",
      translated: true
    });
  } catch (error) {
    await audit({ event: "bengali_error", source: "typed", message: error.message });
    send(ws, { type: "error", message: error.message });
    send(ws, { type: "done", text: "" });
  } finally {
    preparingPrompt = false;
  }
}

async function checkLlama() {
  try {
    const response = await fetch(`${config.llamaUrl}/health`, {
      signal: AbortSignal.timeout(2500)
    });
    return { ok: response.ok, url: config.llamaUrl };
  } catch (error) {
    return { ok: false, url: config.llamaUrl, error: error.message };
  }
}

async function checkOllama() {
  try {
    const response = await fetch("http://127.0.0.1:11434/api/version", {
      signal: AbortSignal.timeout(2000)
    });
    return { ok: response.ok };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function checkPi() {
  if (Date.now() - piVersionCache.checkedAt < 30000) {
    return { ok: Boolean(piVersionCache.value), version: piVersionCache.value, error: piVersionCache.error };
  }
  try {
    const { stdout } = await execFileAsync("pi", ["--version"], { timeout: 10000 });
    piVersionCache = { value: stdout.trim(), checkedAt: Date.now(), error: null };
    return { ok: true, version: piVersionCache.value };
  } catch (error) {
    piVersionCache = { value: null, checkedAt: Date.now(), error: error.message };
    return { ok: false, error: error.message };
  }
}

app.get("/api/health", async (req, res) => {
  const [llama, pi, ollama, bengali] = await Promise.all([
    checkLlama(),
    checkPi(),
    checkOllama(),
    bengaliHealth()
  ]);
  res.json({
    ok: llama.ok && pi.ok,
    llama,
    pi,
    ollama,
    bengali,
    model: `${config.pi.provider}/${config.pi.model}`,
    workspace: config.workspace,
    sessionId: currentSessionId
  });
});

app.get("/api/state", (req, res) => {
  res.json({
    sessionId: currentSessionId,
    workspace: config.workspace,
    model: `${config.pi.provider}/${config.pi.model}`,
    busy: Boolean(activeRun) || asrBusy || preparingPrompt,
    sessionDir: config.sessionDir
  });
});

app.get("/workspace", (req, res) => {
  res.sendFile(path.join(config.root, "public", "workspace.html"));
});

app.get("/workspace/", (req, res) => {
  res.sendFile(path.join(config.root, "public", "workspace.html"));
});

app.get("/api/workspace/tree", async (req, res) => {
  const state = { count: 0, truncated: false };
  const entries = await readWorkspaceTree(config.workspace, "", 0, state);
  res.set("Cache-Control", "no-store");
  res.json({
    root: config.workspace,
    entries,
    count: state.count,
    truncated: state.truncated,
    maxEntries: WORKSPACE_MAX_ENTRIES
  });
});

app.get("/api/workspace/file", async (req, res) => {
  const file = await workspaceFile(req.query.path);
  if (file.error) {
    res.status(file.status).json({ error: file.error });
    return;
  }

  if (file.stat.size > WORKSPACE_MAX_EDIT_BYTES) {
    res.set("Cache-Control", "no-store");
    res.json({
      path: file.rel,
      name: path.basename(file.full),
      size: file.stat.size,
      mtimeMs: file.stat.mtimeMs,
      tooLarge: true,
      binary: false
    });
    return;
  }

  let buffer;
  try {
    buffer = await fs.readFile(file.full);
  } catch (error) {
    res.status(500).json({ error: `Could not read the file: ${error.message}` });
    return;
  }

  const binary = buffer.includes(0);
  res.set("Cache-Control", "no-store");
  res.json({
    path: file.rel,
    name: path.basename(file.full),
    size: file.stat.size,
    mtimeMs: file.stat.mtimeMs,
    tooLarge: false,
    binary,
    content: binary ? null : buffer.toString("utf8")
  });
});

app.get("/api/workspace/download", async (req, res) => {
  const file = await workspaceFile(req.query.path);
  if (file.error) {
    res.status(file.status).json({ error: file.error });
    return;
  }
  res.set("Cache-Control", "no-store");
  res.download(file.full, path.basename(file.full));
});

app.put("/api/workspace/file", async (req, res) => {
  const { path: targetPath, content } = req.body || {};
  if (typeof content !== "string") {
    res.status(400).json({ error: "File content must be a string." });
    return;
  }
  if (Buffer.byteLength(content, "utf8") > WORKSPACE_MAX_EDIT_BYTES) {
    res.status(413).json({ error: "File content is larger than the 1 MB editor limit." });
    return;
  }

  const file = await workspaceFile(targetPath);
  if (file.error) {
    res.status(file.status).json({ error: file.error });
    return;
  }

  try {
    await fs.writeFile(file.full, content, "utf8");
  } catch (error) {
    res.status(500).json({ error: `Could not save the file: ${error.message}` });
    return;
  }

  const stat = await fs.stat(file.full);
  await audit({ event: "workspace_save", path: file.rel, size: stat.size });
  res.json({ ok: true, path: file.rel, size: stat.size, mtimeMs: stat.mtimeMs });
});

app.post("/internal/approval", async (req, res) => {
  const token = req.get("x-audio-bot-token");
  const { runId, tool, toolCallId, args } = req.body || {};

  if (!activeRun || !token || token !== activeRun.token || runId !== activeRun.runId) {
    res.status(403).json({ allow: false, reason: "Invalid approval token." });
    return;
  }

  const decision = await requestApproval({ runId, tool, toolCallId, args });
  audit({
    event: decision.allow ? "approval_allowed" : "approval_denied",
    runId,
    tool,
    toolCallId,
    reason: decision.reason || null
  });
  res.json(decision);
});

wss.on("connection", (ws) => {
  clients.add(ws);

  send(ws, {
    type: "hello",
    sessionId: currentSessionId,
    workspace: config.workspace,
    model: `${config.pi.provider}/${config.pi.model}`
  });

  ws.on("message", async (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      send(ws, { type: "error", message: "Invalid client message." });
      return;
    }

    if (message.type === "ping") {
      send(ws, { type: "pong" });
      return;
    }

    if (message.type === "new_session") {
      if (activeRun || asrBusy || preparingPrompt) {
        send(ws, { type: "error", message: "Stop the current run before starting a new session." });
        return;
      }
      currentSessionId = newSessionId();
      await persistSession();
      await audit({ event: "new_session", sessionId: currentSessionId });
      broadcast({ type: "session", sessionId: currentSessionId });
      send(ws, { type: "message", message: "New session started." });
      return;
    }

    if (message.type === "abort") {
      if (activeRun) activeRun.abort();
      return;
    }

    if (message.type === "approval") {
      const pending = pendingApprovals.get(message.id);
      if (!pending) return;
      pendingApprovals.delete(message.id);
      if (message.remember && activeRun) {
        activeRun.allowedTools.add(message.tool);
      }
      pending.resolve({
        allow: Boolean(message.allow),
        reason: message.allow ? undefined : message.reason || "Denied by the user."
      });
      return;
    }

    if (message.type === "audio") {
      await handleAudio(message, ws);
      return;
    }

    if (message.type === "prompt") {
      await handlePrompt(message, ws);
      return;
    }

    send(ws, { type: "error", message: `Unknown message type: ${message.type}` });
  });

  ws.on("close", () => {
    clients.delete(ws);
    if (activeRun?.ws === ws) {
      denyAllPending("The browser disconnected.");
      activeRun.abort();
    }
  });

  ws.on("error", () => {
    clients.delete(ws);
  });
});

await fs.mkdir(config.workspace, { recursive: true });
await fs.mkdir(config.dataDir, { recursive: true });
await fs.mkdir(config.audioDir, { recursive: true });
await fs.mkdir(config.sessionDir, { recursive: true });
await fs.mkdir(path.join(config.root, "public"), { recursive: true });
await restoreSession();
await persistSession();

server.listen(config.port, config.host, () => {
  console.log(`audio-bot listening on http://${config.host}:${config.port}`);
  console.log(`workspace: ${config.workspace}`);
  console.log(`pi model: ${config.pi.provider}/${config.pi.model}`);
  console.log(`llama.cpp: ${config.llamaUrl}`);
});
