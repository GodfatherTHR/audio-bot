import WebSocket from "ws";

const url = process.env.WS_URL || "ws://127.0.0.1:3333/ws";
const defaultPrompts = [
  "Use the write tool to create hello.txt in the current directory with exactly this content: hello from voice bot. Do not use bash.",
  "Run this exact bash command and nothing else: printf 'approved' > approval-test.txt"
];
const prompts = process.argv.slice(2).length > 0 ? process.argv.slice(2) : defaultPrompts;

const ws = new WebSocket(url);
let step = 0;
let finished = false;

const timeout = setTimeout(() => {
  console.error("\nSmoke test timed out.");
  process.exit(1);
}, 300000);

function finish(code) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  ws.close();
  setTimeout(() => process.exit(code), 200);
}

function sendPrompt(index) {
  console.log(`\n--- prompt ${index + 1} ---`);
  ws.send(JSON.stringify({ type: "prompt", text: prompts[index] }));
}

ws.on("open", () => {
  console.log("connected");
});

ws.on("message", (raw) => {
  const message = JSON.parse(raw.toString());
  switch (message.type) {
    case "hello":
      sendPrompt(0);
      break;
    case "approval_request":
      console.log(`\n[approval] ${message.tool}: ${JSON.stringify(message.detail)}`);
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
      break;
    case "done":
      if (step < prompts.length - 1) {
        step += 1;
        sendPrompt(step);
      } else {
        console.log("\n--- smoke test complete ---");
        finish(0);
      }
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
