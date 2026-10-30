import { spawn } from "node:child_process";
import { config } from "./config.js";

function messageText(message) {
  if (!message || message.role !== "assistant") return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function resultText(result) {
  if (!result) return "";
  if (typeof result === "string") return result;
  if (typeof result.output === "string") return result.output;
  if (Array.isArray(result.content)) {
    return result.content
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("");
  }
  return "";
}

function truncate(value, limit = 4000) {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n... (${value.length - limit} chars truncated)`;
}

export function startAgent({ prompt, sessionId, runId, approvalUrl, approvalToken, onEvent }) {
  const args = [
    "--provider",
    config.pi.provider,
    "--model",
    config.pi.model,
    "--print",
    "--mode",
    "json",
    "--session-id",
    sessionId,
    "--session-dir",
    config.sessionDir,
    "--thinking",
    config.pi.thinking,
    "--no-extensions",
    "-e",
    config.approvalExtension,
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-mcp",
    "--no-approve",
    "--tools",
    config.pi.tools,
    "--",
    prompt
  ];

  const child = spawn("pi", args, {
    cwd: config.workspace,
    env: {
      ...process.env,
      AUDIO_BOT_APPROVAL_URL: approvalUrl,
      AUDIO_BOT_APPROVAL_TOKEN: approvalToken,
      AUDIO_BOT_RUN_ID: runId,
      AUDIO_BOT_APPROVAL_TIMEOUT_MS: String(config.pi.approvalTimeoutMs)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdoutBuffer = "";
  let stderrBuffer = "";
  let settled = false;
  let aborted = false;
  let finalText = "";
  let resolvePromise;
  let rejectPromise;

  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  const emit = (event) => {
    try {
      onEvent(event);
    } catch (error) {
      console.error("event handler failed", error);
    }
  };

  const settle = (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(killTimer);
    if (error) {
      rejectPromise(error);
      return;
    }
    resolvePromise({ text: finalText, aborted });
  };

  const handleRecord = (record) => {
    switch (record.type) {
      case "message_update": {
        const update = record.assistantMessageEvent;
        if (update?.type === "text_delta" && update.delta) {
          emit({ type: "agent_delta", text: update.delta });
        }
        if (update?.type === "thinking_start") {
          emit({ type: "agent_status", status: "thinking" });
        }
        return;
      }
      case "message_end": {
        const text = messageText(record.message);
        if (text) finalText = text;
        return;
      }
      case "tool_execution_start": {
        emit({
          type: "tool_start",
          toolCallId: record.toolCallId,
          tool: record.toolName,
          args: record.args
        });
        return;
      }
      case "tool_execution_update": {
        const text = resultText(record.partialResult);
        if (text) {
          emit({
            type: "tool_output",
            toolCallId: record.toolCallId,
            text: truncate(text)
          });
        }
        return;
      }
      case "tool_execution_end": {
        emit({
          type: "tool_end",
          toolCallId: record.toolCallId,
          tool: record.toolName,
          isError: Boolean(record.isError),
          text: truncate(resultText(record.result))
        });
        return;
      }
      case "auto_retry_start": {
        emit({
          type: "agent_status",
          status: "retrying",
          detail: `Retrying (${record.attempt}/${record.maxAttempts})`
        });
        return;
      }
      case "compaction_start": {
        emit({ type: "agent_status", status: "compacting" });
        return;
      }
      case "agent_settled": {
        settle();
        return;
      }
      default:
        return;
    }
  };

  const handleLine = (line) => {
    if (!line.trim()) return;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return;
    }
    handleRecord(record);
  };

  child.stdout?.on("data", (chunk) => {
    stdoutBuffer += chunk.toString("utf8");
    let newline = stdoutBuffer.indexOf("\n");
    while (newline !== -1) {
      const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      handleLine(line);
      newline = stdoutBuffer.indexOf("\n");
    }
  });

  child.stderr?.on("data", (chunk) => {
    stderrBuffer += chunk.toString("utf8");
    if (stderrBuffer.length > 20000) stderrBuffer = stderrBuffer.slice(-20000);
  });

  child.on("error", (error) => {
    settle(new Error(`Could not start pi: ${error.message}`));
  });

  child.on("close", (code, signal) => {
    if (!settled) {
      const detail = stderrBuffer.trim();
      settle(
        new Error(
          `pi exited before finishing (code ${code}${signal ? `, signal ${signal}` : ""}).${
            detail ? `\n${detail.slice(-2000)}` : ""
          }`
        )
      );
    }
  });

  const killTimer = setTimeout(() => {
    if (settled) return;
    aborted = true;
    child.kill("SIGTERM");
    setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
    }, 5000);
    settle(new Error("Agent run timed out and was stopped."));
  }, config.pi.runTimeoutMs);

  return {
    promise,
    abort() {
      if (settled) return;
      aborted = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 3000);
      settle(new Error("Agent run stopped by user."));
    }
  };
}
