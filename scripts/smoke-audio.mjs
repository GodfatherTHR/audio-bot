import fs from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";

const wavPath = process.argv[2];
if (!wavPath) {
  console.error("usage: node scripts/smoke-audio.mjs <file.wav> [en|bn]");
  process.exit(1);
}
const language = process.argv[3] === "bn" || process.env.AUDIO_LANGUAGE === "bn" ? "bn" : "en";

const absolutePath = path.resolve(wavPath);
const data = (await fs.readFile(absolutePath)).toString("base64");
const extension = path.extname(absolutePath).toLowerCase();
const mime =
  extension === ".webm"
    ? "audio/webm"
    : extension === ".ogg"
      ? "audio/ogg"
      : extension === ".m4a" || extension === ".mp4"
        ? "audio/mp4"
        : "audio/wav";
const ws = new WebSocket(process.env.WS_URL || "ws://127.0.0.1:3333/ws");
let finished = false;

const timeout = setTimeout(() => {
  console.error("\nAudio smoke test timed out.");
  process.exit(1);
}, 300000);

function finish(code) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  ws.close();
  setTimeout(() => process.exit(code), 200);
}

ws.on("open", () => console.log("connected"));

ws.on("message", (raw) => {
  const message = JSON.parse(raw.toString());
  switch (message.type) {
    case "hello":
      console.log(`sending ${mime} audio (${language})...`);
      ws.send(JSON.stringify({ type: "audio", data, mime, language }));
      break;
    case "status":
      console.log(`[status] ${message.status}${message.label ? `: ${message.label}` : ""}`);
      break;
    case "transcript":
      console.log(`[transcript] ${message.text}`);
      break;
    case "translation":
      console.log(`[translation] ${message.text}`);
      break;
    case "polished":
      console.log(`[polished] ${message.text}`);
      break;
    case "approval_request":
      console.log(`[approval] ${message.tool}: ${JSON.stringify(message.detail)}`);
      ws.send(
        JSON.stringify({
          type: "approval",
          id: message.id,
          tool: message.tool,
          allow: true,
          remember: false
        })
      );
      break;
    case "agent_delta":
      process.stdout.write(message.text);
      break;
    case "tool_start":
      console.log(`\n[tool start] ${message.tool} ${JSON.stringify(message.args)}`);
      break;
    case "tool_end":
      console.log(`[tool end] ${message.tool} ${message.isError ? "ERROR" : "ok"}`);
      break;
    case "error":
      console.error(`\n[error] ${message.message}`);
      setTimeout(() => finish(1), 100);
      break;
    case "done":
      console.log("\n--- audio smoke test complete ---");
      finish(0);
      break;
    default:
      break;
  }
});

ws.on("error", (error) => {
  console.error("websocket error", error.message);
  finish(1);
});

ws.on("close", () => {
  if (!finished) {
    console.error("websocket closed early");
    finish(1);
  }
});
