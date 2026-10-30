import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const READ_ONLY = new Set(["read", "ls", "find", "grep", "tool_search"]);
const url = process.env.AUDIO_BOT_APPROVAL_URL;
const token = process.env.AUDIO_BOT_APPROVAL_TOKEN;
const runId = process.env.AUDIO_BOT_RUN_ID;
const timeoutMs = Number(process.env.AUDIO_BOT_APPROVAL_TIMEOUT_MS || 120000);

export default function (pi: ExtensionAPI) {
  if (!url || !token || !runId) return;

  pi.on("tool_call", async (event) => {
    if (READ_ONLY.has(event.toolName)) return;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-audio-bot-token": token
        },
        body: JSON.stringify({
          runId,
          tool: event.toolName,
          toolCallId: event.toolCallId,
          args: event.input
        }),
        signal: AbortSignal.timeout(timeoutMs)
      });

      if (!response.ok) {
        return {
          block: true,
          reason: `Approval service returned HTTP ${response.status}`
        };
      }

      const decision = (await response.json()) as { allow?: boolean; reason?: string };
      if (!decision.allow) {
        return { block: true, reason: decision.reason || "Denied by the user" };
      }
      return;
    } catch (error) {
      return {
        block: true,
        reason: `Approval service unreachable: ${
          error instanceof Error ? error.message : String(error)
        }`
      };
    }
  });
}
