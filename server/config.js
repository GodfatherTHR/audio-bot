import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const config = {
  root,
  host: process.env.HOST || "127.0.0.1",
  port: Number(process.env.PORT || 3333),
  workspace: path.resolve(process.env.WORKSPACE || path.join(root, "workspace")),
  dataDir: path.join(root, "data"),
  audioDir: path.join(root, "data", "audio"),
  sessionDir: path.join(root, "data", "pi-sessions"),
  sessionFile: path.join(root, "data", "session.json"),
  approvalExtension: path.join(root, "server", "pi", "approval.ts"),
  llamaUrl: (process.env.LLAMA_URL || "http://127.0.0.1:8099").replace(/\/$/, ""),
  asr: {
    systemPrompt: process.env.ASR_SYSTEM_PROMPT || "Perform ASR in English.",
    timeoutMs: Number(process.env.ASR_TIMEOUT_MS || 240000)
  },
  bengali: {
    enabled: process.env.BENGALI_ENABLED !== "0",
    sherpaBin: path.join(root, "runtime", "sherpa", "bin", "sherpa-onnx"),
    sherpaLib: path.join(root, "runtime", "sherpa", "lib"),
    sherpaModelDir: path.join(root, "models", "bengali-asr"),
    sherpaTimeoutMs: Number(process.env.BENGALI_ASR_TIMEOUT_MS || 180000),
    threads: Number(process.env.BENGALI_THREADS || 4),
    translatorUrl: (process.env.BENGALI_TRANSLATOR_URL || "http://127.0.0.1:8098").replace(/\/$/, ""),
    translatorTimeoutMs: Number(process.env.BENGALI_TRANSLATOR_TIMEOUT_MS || 120000),
    polish: {
      enabled: process.env.BENGALI_POLISH !== "0",
      model: process.env.BENGALI_POLISH_MODEL || process.env.PI_MODEL || "beam:cloud",
      timeoutMs: Number(process.env.BENGALI_POLISH_TIMEOUT_MS || 45000)
    }
  },
  pi: {
    provider: process.env.PI_PROVIDER || "ollama",
    model: process.env.PI_MODEL || "beam:cloud",
    thinking: process.env.PI_THINKING || "low",
    tools: process.env.PI_TOOLS || "read,ls,find,grep,write,edit,bash",
    runTimeoutMs: Number(process.env.PI_RUN_TIMEOUT_MS || 600000),
    approvalTimeoutMs: Number(process.env.APPROVAL_TIMEOUT_MS || 120000)
  }
};

export const readOnlyTools = new Set(["read", "ls", "find", "grep", "tool_search"]);

export function newSessionId() {
  return `voice-${crypto.randomBytes(6).toString("hex")}`;
}

export function newRunId() {
  return crypto.randomBytes(8).toString("hex");
}
