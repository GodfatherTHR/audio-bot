# Setup Guide: Voice → pi

This guide is written for an AI coding agent or a human reproducing the project from source. Run commands from the repository root unless a path is explicit.

## 1. Repository contents

- `server/` — Express/WebSocket server, llama.cpp ASR client, pi subprocess runner, Bengali pipeline.
- `public/` — browser UI, chat renderer, workspace editor.
- `scripts/` — setup, start/stop, smoke tests, Bengali service.
- `workspace/` — pi's working directory. User files live here and are intentionally not committed.
- `data/` — sessions, audit log, generated audio. Never commit.
- `runtime/`, `models/`, `.venv/`, `*.gguf` — large generated/downloaded assets. Never commit.

## 2. Prerequisites

- Linux x86_64 for the documented runtime downloads. Other platforms need equivalent llama.cpp and sherpa-onnx builds.
- Node.js 22+ and npm.
- ffmpeg.
- `pi` installed and authenticated for `beam:cloud`.
- curl.
- Python 3.10–3.12 for Bengali support.
- The provided `LFM3-Audio-2B-Q4_K_M.gguf` in the project root.
- Enough disk space: roughly 1.5 GB for `.venv`, 400 MB for llama.cpp, 100 MB for Bengali assets, plus model files.

Check prerequisites:

```bash
node --version
npm --version
ffmpeg -version | head -1
pi --version
curl --version | head -1
python3 --version
```

## 3. Install

```bash
./scripts/setup.sh
```

What it does:

1. Verifies `node`, `npm`, `ffmpeg`, `pi`, and `curl`.
2. Requires `LFM3-Audio-2B-Q4_K_M.gguf` to already be in the project root.
3. Downloads `mmproj-LFM3-Audio-2B-Q8_0.gguf` if missing.
4. Downloads llama.cpp `b11960` CPU build into `runtime/llama/` if missing.
5. Runs `npm install`.
6. Creates `data/audio`, `data/pi-sessions`, and `workspace`.

If `pi` is installed under a nonstandard path, ensure it is on `PATH` before running setup.

## 4. Bengali setup

English-only mode works after section 3. For Bengali, install these assets exactly:

```bash
mkdir -p runtime models
curl -L --fail --retry 3 \
  -o /tmp/sherpa.tar.bz2 \
  https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.1/sherpa-onnx-v2.0.1-linux-x64-shared.tar.bz2
rm -rf runtime/sherpa && mkdir -p runtime/sherpa
tar -xjf /tmp/sherpa.tar.bz2 -C runtime/sherpa --strip-components=1

curl -L --fail --retry 3 \
  -o /tmp/bengali-asr.tar.bz2 \
  https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-bn-vosk-2026-02-09.tar.bz2
tar -xjf /tmp/bengali-asr.tar.bz2 -C models
mv models/sherpa-onnx-streaming-zipformer-bn-vosk-2026-02-09 models/bengali-asr

python3 -m pip install --user --break-system-packages virtualenv
python3 -m virtualenv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu
.venv/bin/pip install ctranslate2==4.6.0 transformers==4.46.3 sentencepiece protobuf

.venv/bin/ct2-transformers-converter \
  --model csebuetnlp/banglat5_nmt_bn_en \
  --output_dir runtime/banglat5-nmt-bn-en-int8 \
  --quantization int8_float32 \
  --copy_files spiece.model \
  --force
```

Version constraints that matter:

- `transformers` 5.x breaks this checkpoint's tokenizer.
- CTranslate2 4.8.x rejects the T5 `dtype` argument used by this conversion.
- Use `virtualenv` if `python3 -m venv` is unavailable, as on this machine.

Expected resulting paths:

- `runtime/sherpa/lib/libsherpa-onnx-c-api.so`
- `models/bengali-asr/tokens.txt`
- `runtime/banglat5-nmt-bn-en-int8/model.bin`
- `.venv/bin/python`

## 5. Run

```bash
./scripts/start.sh
```

Open `http://127.0.0.1:3333`.

`start.sh` starts:

1. llama.cpp on `127.0.0.1:8099` if not already healthy.
2. Bengali translator on `127.0.0.1:8098` if the Python/model stack exists and is not already healthy.
3. The Node app on `PORT` (default `3333`).

Stop everything:

```bash
./scripts/stop.sh
```

## 6. Environment variables

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

## 7. Verification

Syntax:

```bash
npm run check
```

Health:

```bash
curl -s http://127.0.0.1:3333/api/health
curl -s http://127.0.0.1:3333/api/state
```

Expected health fields:

- `ok: true`
- `llama.ok: true`
- `pi.ok: true`
- `ollama.ok: true`
- `bengali.enabled: true` when Bengali is installed
- `bengali.asr: true`
- `bengali.translator.ok: true`

Text smoke test:

```bash
npm run smoke
npm run smoke -- "Reply with exactly: smoke ok"
```

Audio smoke test:

```bash
npm run smoke:audio -- path/to/file.wav
npm run smoke:audio -- path/to/file.wav bn
```

The `bn` argument exercises sherpa ASR, BanglaT5 translation, and cloud polish.

Browser checks:

1. Open `http://127.0.0.1:3333` or `http://localhost:3333`. Plain LAN HTTP will not expose `getUserMedia`.
2. Hold Space or the mic, speak, release.
3. Confirm the transcript and agent activity update.
4. Type a prompt and submit.
5. Open `/workspace`, edit a file, save, and return to `/`.
6. Confirm prior chat history is restored and the page itself does not scroll when the conversation grows.
7. Test at 390x844 and confirm the composer remains usable.

## 8. UI behavior

- The chat panel is a fixed-height region on desktop. Long conversations scroll inside `#chatScroll`, not the whole page.
- On mobile, the chat height is viewport-based and the textarea uses 16px font to avoid iOS zoom.
- Chat history is saved in browser `localStorage` keyed by session ID and restored after navigating to/from `/workspace`.
- Starting a new session clears the saved snapshot.
- An interrupted tool card is marked `interrupted` if the browser leaves mid-run.

## 9. Agent operating notes

- Do not commit generated assets: `.venv/`, `runtime/`, `models/`, `data/`, `node_modules/`, `*.gguf`, or anything under `workspace/` except `workspace/README.md`.
- Do not commit secrets, tokens, `.env` files, or logs.
- Preserve user files in `workspace/`; the app and repository intentionally ignore them.
- Check `/api/state` before restarting the app. If `busy` is true, wait or abort the active run first.
- Restart with `systemctl --user restart audio-bot` only if that transient service exists; otherwise stop/start manually.
- After code changes, run `npm run check`, health checks, and at least one smoke test before claiming completion.

## 10. Troubleshooting

- Red/amber health dot: inspect the tooltip, `data/llama-server.log`, and `curl http://127.0.0.1:8099/health`.
- Microphone unavailable: use localhost/127.0.0.1; browsers require a secure context.
- `pi` auth/model errors: run `pi --model beam:cloud --no-tools --print "Reply OK"`.
- Port 8099 busy: set `LLAMA_PORT` or stop the other process.
- Bengali translator unavailable: check `curl http://127.0.0.1:8098/health` and `data/bengali-translator.log`; start manually with `.venv/bin/python scripts/bengali_service.py --port 8098`.
- Bengali ASR returns no text: confirm model files exist and WAV is 16 kHz mono.
- Slow transcription: this is a 2B audio model on an old mobile CPU; keep recordings short.
- Chat history missing after an update: clear `localStorage` key `audio-bot-chat-v1` and reload.

## 11. Optional systemd user service

The current machine runs the app as a transient systemd user service. To recreate a persistent service, create `~/.config/systemd/user/audio-bot.service` with an `ExecStart` pointing to `/home/<user>/audio-bot/scripts/start.sh`, then run:

```bash
systemctl --user daemon-reload
systemctl --user enable --now audio-bot
```

Do not hard-code secrets or tokens in the service file.
EOF
echo done