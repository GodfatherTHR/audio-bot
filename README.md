# Voice → pi

A push-to-talk website for the pi coding agent. English speech is transcribed locally by LFM3-Audio-2B running on llama.cpp. Bengali speech is transcribed locally by sherpa-onnx, translated to English by BanglaT5, and polished by `beam:cloud` before pi runs the request. pi works inside `workspace/` and streams its progress back to the browser.

```
Browser mic
   │  WebM/Opus
   ▼
Node server ──► ffmpeg ──► 16 kHz WAV
   │                         │
   │              ┌──────────┴──────────┐
   │              ▼                     ▼
   │        English ASR           Bengali ASR
   │        LFM3-Audio            sherpa-onnx
   │              │                     │
   │              │                     ▼
   │              │              BanglaT5 bn→en
   │              │                     │
   │              │                     ▼
   │              │              cloud prompt polish
   │              └──────────┬──────────┘
   │                         ▼
   └──────────────► pi --mode json (beam:cloud)
                             │
                    tools + approvals
                             ▼
                     streamed to browser
```

The interface has an **English / বাংলা** switch. Bengali prompts show the original Bengali in the chat bubble above the English instruction that pi actually receives.

## Quick start

```bash
./scripts/setup.sh
./scripts/start.sh
```

Open http://127.0.0.1:3333, hold **Space** (or press and hold the mic), speak, and release. You can also type directly in the message box next to the agent activity. Recordings are capped at 60 seconds.

Use the **English / বাংলা** switch above the talk button. Bengali speech is transcribed and translated locally before the polished English prompt is sent to pi. You can also type Bengali directly; it is detected automatically.

The agent activity renders as a chat: your prompt appears as a bubble, pi's reply streams in with Markdown formatting, and each tool call appears as a collapsible card showing its arguments and output.

The first local transcription includes model warm-up and is slower. A seven-second English clip takes roughly 15 seconds after warm-up; Bengali ASR is much faster, while translation and cloud polish add a few seconds. pi adds its own cloud latency.

See [setup.md](./setup.md) for a complete AI-agent-oriented setup, verification, and troubleshooting guide.

## Requirements

- Node.js 22+
- ffmpeg
- pi installed and configured with the `beam:cloud` model
- The provided `LFM3-Audio-2B-Q4_K_M.gguf` in the project root
- The `mmproj-LFM3-Audio-2B-Q8_0.gguf` audio projector (downloaded by setup)
- llama.cpp b11960 or newer (the setup script downloads the CPU build into `runtime/`)

Bengali support additionally uses:

- Python 3.10–3.12 with a local `.venv`
- sherpa-onnx v2.0.1 in `runtime/sherpa/`
- the Bengali streaming zipformer model in `models/bengali-asr/`
- a CTranslate2 int8 conversion of `csebuetnlp/banglat5_nmt_bn_en` in `runtime/banglat5-nmt-bn-en-int8/`
- `ctranslate2==4.6.0`, `transformers==4.46.3`, `sentencepiece`, `protobuf`, and CPU torch in `.venv`

`scripts/start.sh` starts the translator on `127.0.0.1:8098` when the stack is present and reuses it when it is already healthy. If the stack is missing, the app still starts in English-only mode.

`pi` is invoked as a subprocess. Its `~/.pi/agent/models.json` already points the `ollama` provider at `http://127.0.0.1:11434/v1` and exposes `beam:cloud`.

## How it works

1. The browser records with `MediaRecorder` and sends the blob over a WebSocket, along with the selected language.
2. The server converts it to 16 kHz mono WAV with ffmpeg.
3. English audio goes to the local llama.cpp OpenAI-compatible endpoint with the system prompt `Perform ASR in English.` and the audio as an `input_audio` content part.
4. Bengali audio goes to the sherpa-onnx streaming zipformer model in `models/bengali-asr/`. The transcript is translated by the local BanglaT5 service on port 8098, then optionally rewritten by `beam:cloud` into one clear English instruction.
5. The resulting English prompt is sent to pi using `pi --print --mode json --session-id <id>`. All prompts share one session until you press **New session**, and the session ID survives app restarts.
6. pi streams text deltas and tool events, which are rendered live in the chat. Tool calls that need review are paused for an Allow/Deny decision in the browser.
7. A pi extension forwards tool-call approvals to the local server; the server shows them in the UI.
8. The **Workspace** button opens `/workspace`, a file browser and editor for the same directory. Text files can be viewed and saved in the browser; binary and large files can be downloaded. The tree refreshes on demand and links to a file can be shared with `?path=`.

## Bengali setup

The app is already wired for the installed Bengali assets:

- `runtime/sherpa/` — sherpa-onnx v2.0.1 shared Linux x64 build
- `models/bengali-asr/` — `sherpa-onnx-streaming-zipformer-bn-vosk-2026-02-09`
- `runtime/banglat5-nmt-bn-en-int8/` — CTranslate2 int8 conversion of `csebuetnlp/banglat5_nmt_bn_en`
- `.venv/` — CPU Python runtime for the translation service

To recreate them:

```bash
# sherpa-onnx runtime
mkdir -p runtime
curl -L --fail --retry 3 \
  -o /tmp/sherpa.tar.bz2 \
  https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.1/sherpa-onnx-v2.0.1-linux-x64-shared.tar.bz2
rm -rf runtime/sherpa && mkdir -p runtime/sherpa
tar -xjf /tmp/sherpa.tar.bz2 -C runtime/sherpa --strip-components=1

# Bengali streaming ASR model
curl -L --fail --retry 3 \
  -o /tmp/bengali-asr.tar.bz2 \
  https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-bn-vosk-2026-02-09.tar.bz2
tar -xjf /tmp/bengali-asr.tar.bz2 -C models
mv models/sherpa-onnx-streaming-zipformer-bn-vosk-2026-02-09 models/bengali-asr

# Python translation environment
python3 -m pip install --user --break-system-packages virtualenv
python3 -m virtualenv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu
.venv/bin/pip install ctranslate2==4.6.0 transformers==4.46.3 sentencepiece protobuf

# BanglaT5 → CTranslate2 int8
.venv/bin/ct2-transformers-converter \
  --model csebuetnlp/banglat5_nmt_bn_en \
  --output_dir runtime/banglat5-nmt-bn-en-int8 \
  --quantization int8_float32 \
  --copy_files spiece.model \
  --force
```

The exact versions matter: `transformers` 5.x fails on this checkpoint’s tokenizer and CTranslate2 4.8.x rejects its T5 `dtype` argument. If `python3 -m venv` is unavailable, the `virtualenv` line above is the workaround used on this machine.

## Workspace page

The **Workspace** button in the header opens a two-pane browser at `/workspace`:

- the file tree covers the whole workspace (up to 4,000 entries, depth 12) and skips `.git`
- text files open in the editor; **Save** writes them back and records a `workspace_save` audit event
- edits are limited to existing regular files of 1 MB or less
- binary files and large files are download-only, and symlinks are listed but not followed
- `?path=some/file.md` opens that file directly

## Safety model

pi has no built-in filesystem sandbox. This app adds:

- a dedicated `workspace/` working directory
- approval prompts for `bash` and for writes/edits outside the workspace
- automatic approval for writes/edits **inside** the workspace
- a hard blocklist for privileged or destructive commands (`sudo`, `mkfs`, `rm -rf /`, `git push`, piping downloads into a shell, and similar)
- a timestamped audit log at `data/audit.log`
- a workspace editor that only updates existing regular files, rejects symlinks and path escapes, and caps saves at 1 MB
- no bundled shell or file server beyond the local app

Approval is not a sandbox. A command you approve runs with your user permissions. Do not expose this app to a network you do not trust.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3333` | Web app port |
| `HOST` | `127.0.0.1` | Web app bind address |
| `LLAMA_URL` | `http://127.0.0.1:8099` | llama.cpp server |
| `LLAMA_PORT` | `8099` | Port used by `scripts/start.sh` |
| `LLAMA_THREADS` | `4` | CPU threads for llama.cpp |
| `WORKSPACE` | `./workspace` | pi working directory |
| `PI_PROVIDER` | `ollama` | pi provider |
| `PI_MODEL` | `beam:cloud` | pi model |
| `PI_THINKING` | `low` | pi thinking level |
| `PI_TOOLS` | `read,ls,find,grep,write,edit,bash` | pi tool allowlist |
| `ASR_SYSTEM_PROMPT` | `Perform ASR in English.` | LFM3 transcription prompt |
| `BENGALI_ENABLED` | `1` | Enable Bengali UI and services (`0` disables) |
| `BENGALI_PORT` | `8098` | Local BanglaT5 service port used by `start.sh` |
| `BENGALI_TRANSLATOR_URL` | `http://127.0.0.1:8098` | Translation service endpoint |
| `BENGALI_MODEL_DIR` | `./runtime/banglat5-nmt-bn-en-int8` | CT2 translation model |
| `BENGALI_POLISH` | `1` | Use `beam:cloud` to rewrite the English prompt |
| `BENGALI_POLISH_MODEL` | `beam:cloud` | Polish model |
| `BENGALI_ASR_TIMEOUT_MS` | `180000` | Bengali ASR timeout |
| `BENGALI_THREADS` | `4` | CPU threads for sherpa and BanglaT5 |

English ASR still uses LFM3, which supports Arabic, Danish, German, Greek, English, Finnish, French, Hebrew, Italian, Japanese, Korean, Dutch, Polish, Portuguese, Spanish, Swedish, Turkish, and Chinese. Bengali is handled by the separate sherpa/BanglaT5 path.

## Troubleshooting

- **Health dot is red or amber:** open the tooltip. Check `data/llama-server.log` and run `curl http://127.0.0.1:8099/health`.
- **Microphone does not start:** the browser requires a secure context. Use `http://127.0.0.1:3333` or `http://localhost:3333`; plain HTTP over a LAN IP will not expose `getUserMedia`.
- **`pi` exits with an auth/model error:** run `pi --model beam:cloud --no-tools --print "Reply OK"` in a terminal and verify the Ollama cloud session.
- **Port 8099 is busy:** set `LLAMA_PORT` when starting, or stop the other llama.cpp process.
- **Bengali prompt says the translator is unavailable:** check `curl http://127.0.0.1:8098/health` and `data/bengali-translator.log`. Start it with `scripts/start.sh` or manually with `.venv/bin/python scripts/bengali_service.py --port 8098`.
- **Bengali ASR returns no text:** confirm the model files exist in `models/bengali-asr/` and the WAV is 16 kHz mono. The bundled `test_wavs/1.wav` is 22.05 kHz and is not directly usable; `0.wav` is 16 kHz.
- **Slow transcription:** this is a 2B audio model on a 2012-era mobile CPU. Keep recordings short and unused apps closed.

## Chat history and responsive UI

- Chat history is saved in browser `localStorage` under `audio-bot-chat-v1`, keyed by the current session ID.
- Navigating to `/workspace` and back restores the rendered conversation, transcript, and scroll position.
- Starting a new session clears the saved snapshot.
- On desktop, the agent activity panel has a fixed height and scrolls internally; the page itself should not grow.
- On mobile, the chat height is viewport-based, topbar metadata is compacted, and the composer textarea uses 16px text to avoid browser zoom.

## Verification

Run before claiming a change is complete:

```bash
npm run check
curl -s http://127.0.0.1:3333/api/health
curl -s http://127.0.0.1:3333/api/state
npm run smoke
```

For Bengali changes also run:

```bash
npm run smoke:audio -- path/to/bengali.wav bn
```

## Scripts

- `scripts/setup.sh` — checks prerequisites, downloads the projector and llama.cpp runtime, installs Node packages
- `scripts/start.sh` — starts llama.cpp and the Bengali translator if needed, then the web app
- `scripts/stop.sh` — stops the llama.cpp and Bengali translator processes started by `start.sh`
- `npm run check` — syntax-checks the server and browser code
- `npm run smoke` — sends a text prompt through the live app; pass extra prompts as arguments
- `npm run smoke:audio -- path/to/file.wav [bn]` — sends a WAV/WebM/OGG file through the live ASR and agent pipeline; pass `bn` for Bengali
