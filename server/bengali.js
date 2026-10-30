import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config } from "./config.js";

const BENGALI_PATTERN = /[\u0980-\u09FF]/;

export function isBengali(text) {
  return BENGALI_PATTERN.test(String(text || ""));
}

function cleanTranscript(text) {
  return text.replace(/\s+/g, " ").trim();
}

function mergeSegments(segments) {
  let merged = "";
  for (const segment of segments) {
    if (!segment) continue;
    if (!merged) {
      merged = segment;
    } else if (segment.startsWith(merged)) {
      merged = segment;
    } else if (!merged.endsWith(segment)) {
      merged = `${merged} ${segment}`;
    }
  }
  return cleanTranscript(merged);
}

async function assertFile(file, label) {
  try {
    await fs.access(file);
  } catch {
    throw new Error(
      `${label} is missing. See the Bengali setup section in README.md.`
    );
  }
}

export async function transcribeBengali(wavPath) {
  const { sherpaBin, sherpaLib, sherpaModelDir, sherpaTimeoutMs, threads } = config.bengali;
  const encoder = path.join(sherpaModelDir, "encoder.onnx");
  const decoder = path.join(sherpaModelDir, "decoder.onnx");
  const joiner = path.join(sherpaModelDir, "joiner.onnx");
  const tokens = path.join(sherpaModelDir, "tokens.txt");

  await Promise.all([
    assertFile(sherpaBin, "The sherpa-onnx runtime"),
    assertFile(encoder, "The Bengali ASR encoder"),
    assertFile(decoder, "The Bengali ASR decoder"),
    assertFile(joiner, "The Bengali ASR joiner"),
    assertFile(tokens, "The Bengali ASR tokens")
  ]);

  const args = [
    `--tokens=${tokens}`,
    `--encoder=${encoder}`,
    `--decoder=${decoder}`,
    `--joiner=${joiner}`,
    "--provider=cpu",
    `--num-threads=${threads}`,
    "--decoding-method=greedy_search",
    wavPath
  ];

  return await new Promise((resolve, reject) => {
    const child = spawn(sherpaBin, args, {
      env: {
        ...process.env,
        LD_LIBRARY_PATH: [sherpaLib, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":")
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill("SIGKILL");
      reject(new Error("Bengali speech recognition timed out."));
    }, sherpaTimeoutMs);

    const append = (current, chunk) => {
      const next = current + chunk.toString("utf8");
      return next.length > 4_000_000 ? next.slice(-4_000_000) : next;
    };

    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(new Error(`Could not start Bengali speech recognition: ${error.message}`));
    });
    child.on("close", () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);

      const segments = [];
      const collect = (output) => {
        for (const line of output.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("{")) continue;
          try {
            const record = JSON.parse(trimmed);
            if (typeof record.text === "string" && record.text.trim()) {
              segments.push(record.text.trim());
            }
          } catch {
            // The CLI also prints non-JSON diagnostics between records.
          }
        }
      };
      collect(stdout);
      collect(stderr);

      const transcript = mergeSegments(segments);
      if (!transcript) {
        const detail = stderr
          .split(/\r?\n/)
          .filter((line) => line.trim() && !line.trim().startsWith("{"))
          .slice(-3)
          .join(" ")
          .slice(0, 500);
        reject(
          new Error(
            detail
              ? `Bengali speech recognition returned no text: ${detail}`
              : "Bengali speech recognition returned no text."
          )
        );
        return;
      }
      resolve(transcript);
    });
  });
}

export async function translateBengali(text) {
  let response;
  try {
    response = await fetch(`${config.bengali.translatorUrl}/translate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(config.bengali.translatorTimeoutMs)
    });
  } catch (error) {
    throw new Error(
      `The Bengali translator is unreachable at ${config.bengali.translatorUrl}. Start it with scripts/start.sh. (${error.message})`
    );
  }

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Bengali translator returned HTTP ${response.status}: ${detail.slice(0, 300)}`);
  }

  const data = await response.json();
  if (!data?.ok || typeof data.english !== "string" || !data.english.trim()) {
    throw new Error(data?.error || "The Bengali translator returned an empty translation.");
  }

  return {
    english: data.english.trim(),
    ms: Number(data.ms) || null
  };
}

let providerCache = { value: null, checkedAt: 0 };

async function getPolishProvider() {
  if (Date.now() - providerCache.checkedAt < 30000 && providerCache.value) {
    return providerCache.value;
  }

  const configPath = process.env.PI_MODELS_FILE || path.join(os.homedir(), ".pi", "agent", "models.json");
  const raw = JSON.parse(await fs.readFile(configPath, "utf8"));
  const provider = raw?.providers?.[config.pi.provider];
  if (!provider?.baseUrl) throw new Error(`No ${config.pi.provider} provider configuration found.`);

  const value = {
    baseUrl: String(provider.baseUrl).replace(/\/$/, ""),
    apiKey: provider.apiKey ? String(provider.apiKey) : "",
    model: config.bengali.polish.model
  };
  providerCache = { value, checkedAt: Date.now() };
  return value;
}

function fallbackPrompt(english) {
  return [
    "The user's request was spoken in Bengali and translated to English as:",
    `"${english}"`,
    "",
    "Carry out this request in the workspace. If something essential is ambiguous, ask one concise clarifying question before making changes. When you finish, summarize the result."
  ].join("\n");
}

function cleanPolished(text) {
  let value = String(text || "").trim();
  value = value.replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/i, "").trim();
  value = value.replace(/^(rewritten|polished|english)\s+(instruction|prompt)\s*:\s*/i, "").trim();
  value = value.replace(/^["'`]+|["'`]+$/g, "").trim();
  if (value.length > 4000) value = `${value.slice(0, 4000)}…`;
  return value;
}

export async function polishEnglishPrompt({ bengali, english }) {
  if (!config.bengali.polish.enabled) {
    return { text: fallbackPrompt(english), model: null, polished: false };
  }

  try {
    const provider = await getPolishProvider();
    const response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {})
      },
      body: JSON.stringify({
        model: provider.model,
        temperature: 0.2,
        max_tokens: 320,
        messages: [
          {
            role: "system",
            content:
              "You rewrite translated user requests into one clear, specific English instruction for a coding agent. Preserve names, file paths, numbers, and constraints exactly. Do not add requirements. Do not answer the request. Output only the rewritten instruction."
          },
          {
            role: "user",
            content: `Bengali original:\n${bengali}\n\nLiteral English translation:\n${english}`
          }
        ]
      }),
      signal: AbortSignal.timeout(config.bengali.polish.timeoutMs)
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Polish returned HTTP ${response.status}: ${detail.slice(0, 200)}`);
    }

    const data = await response.json();
    const polished = cleanPolished(data?.choices?.[0]?.message?.content);
    if (!polished) throw new Error("Polish returned an empty instruction.");

    return { text: polished, model: provider.model, polished: true };
  } catch (error) {
    return {
      text: fallbackPrompt(english),
      model: null,
      polished: false,
      error: error.message
    };
  }
}

export async function translatorHealth() {
  try {
    const response = await fetch(`${config.bengali.translatorUrl}/health`, {
      signal: AbortSignal.timeout(2500)
    });
    if (!response.ok) return { ok: false, url: config.bengali.translatorUrl };
    const data = await response.json();
    return { ok: true, url: config.bengali.translatorUrl, model: data.model, compute: data.compute };
  } catch (error) {
    return { ok: false, url: config.bengali.translatorUrl, error: error.message };
  }
}

export async function bengaliHealth() {
  const { sherpaBin, sherpaModelDir, enabled } = config.bengali;
  const required = [
    sherpaBin,
    path.join(sherpaModelDir, "encoder.onnx"),
    path.join(sherpaModelDir, "decoder.onnx"),
    path.join(sherpaModelDir, "joiner.onnx"),
    path.join(sherpaModelDir, "tokens.txt")
  ];

  const [asr, translator] = await Promise.all([
    (async () => {
      for (const file of required) {
        try {
          await fs.access(file);
        } catch {
          return false;
        }
      }
      return true;
    })(),
    translatorHealth()
  ]);

  return { enabled, asr, translator };
}
