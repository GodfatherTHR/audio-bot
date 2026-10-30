import fs from "node:fs/promises";
import { config } from "./config.js";

function cleanTranscript(text) {
  let value = text.trim();
  value = value.replace(/^["'`]+|["'`]+$/g, "").trim();
  value = value.replace(/^(transcript|transcription)\s*:\s*/i, "").trim();
  value = value.replace(/\s+/g, " ");
  return value;
}

export async function transcribe(wavPath) {
  const audio = await fs.readFile(wavPath);

  const payload = {
    model: "lfm3-audio",
    messages: [
      { role: "system", content: config.asr.systemPrompt },
      {
        role: "user",
        content: [
          {
            type: "input_audio",
            input_audio: { data: audio.toString("base64") }
          }
        ]
      }
    ],
    temperature: 0,
    max_tokens: 256
  };

  let response;
  try {
    response = await fetch(`${config.llamaUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(config.asr.timeoutMs)
    });
  } catch (error) {
    throw new Error(
      `Local ASR server is unreachable at ${config.llamaUrl}. Start it with scripts/start.sh. (${error.message})`
    );
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`ASR server returned HTTP ${response.status}: ${body.slice(0, 300)}`);
  }

  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text || !text.trim()) {
    throw new Error("ASR returned an empty transcript");
  }

  return cleanTranscript(text);
}
