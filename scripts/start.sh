#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LLAMA_HOST="${LLAMA_HOST:-127.0.0.1}"
LLAMA_PORT="${LLAMA_PORT:-8099}"
LLAMA_THREADS="${LLAMA_THREADS:-4}"
LLAMA_CTX="${LLAMA_CTX:-8192}"

BENGALI_ENABLED="${BENGALI_ENABLED:-1}"
BENGALI_HOST="${BENGALI_HOST:-127.0.0.1}"
BENGALI_PORT="${BENGALI_PORT:-8098}"
BENGALI_MODEL_DIR="${BENGALI_MODEL_DIR:-runtime/banglat5-nmt-bn-en-int8}"
BENGALI_URL="http://${BENGALI_HOST}:${BENGALI_PORT}"

mkdir -p data/audio data/pi-sessions workspace

for file in LFM3-Audio-2B-Q4_K_M.gguf mmproj-LFM3-Audio-2B-Q8_0.gguf runtime/llama/llama-server; do
  if [[ ! -e "$file" ]]; then
    echo "Missing $file"
    echo "Run ./scripts/setup.sh first."
    exit 1
  fi
done

if ! curl -sf "http://${LLAMA_HOST}:${LLAMA_PORT}/health" >/dev/null 2>&1; then
  echo "Starting local ASR server on ${LLAMA_HOST}:${LLAMA_PORT}..."
  setsid runtime/llama/llama-server \
    -m LFM3-Audio-2B-Q4_K_M.gguf \
    -mm mmproj-LFM3-Audio-2B-Q8_0.gguf \
    --host "$LLAMA_HOST" \
    --port "$LLAMA_PORT" \
    -t "$LLAMA_THREADS" \
    -c "$LLAMA_CTX" \
    --no-ui \
    > data/llama-server.log 2>&1 < /dev/null &
  echo $! > data/llama-server.pid

  ready=0
  for _ in $(seq 1 180); do
    if curl -sf "http://${LLAMA_HOST}:${LLAMA_PORT}/health" >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 1
  done

  if [[ "$ready" -ne 1 ]]; then
    echo "ASR server did not become healthy. Recent log:"
    tail -30 data/llama-server.log || true
    exit 1
  fi
  echo "ASR server ready."
else
  echo "Reusing ASR server on ${LLAMA_HOST}:${LLAMA_PORT}."
fi

if [[ "$BENGALI_ENABLED" != "0" ]]; then
  if curl -sf "${BENGALI_URL}/health" >/dev/null 2>&1; then
    echo "Reusing Bengali translator on ${BENGALI_URL}."
  elif [[ -x .venv/bin/python && -d "$BENGALI_MODEL_DIR" ]]; then
    echo "Starting Bengali translator on ${BENGALI_URL}..."
    setsid .venv/bin/python scripts/bengali_service.py \
      --host "$BENGALI_HOST" \
      --port "$BENGALI_PORT" \
      --model-dir "$BENGALI_MODEL_DIR" \
      > data/bengali-translator.log 2>&1 < /dev/null &
    echo $! > data/bengali-translator.pid

    ready=0
    for _ in $(seq 1 120); do
      if curl -sf "${BENGALI_URL}/health" >/dev/null 2>&1; then
        ready=1
        break
      fi
      sleep 1
    done

    if [[ "$ready" -ne 1 ]]; then
      echo "Bengali translator did not become healthy. Recent log:"
      tail -30 data/bengali-translator.log || true
      echo "Continuing without Bengali support."
      rm -f data/bengali-translator.pid
    else
      echo "Bengali translator ready."
    fi
  else
    echo "Bengali stack is not installed; continuing with English only."
    echo "See README.md for Bengali setup steps."
  fi
fi

export LLAMA_URL="${LLAMA_URL:-http://${LLAMA_HOST}:${LLAMA_PORT}}"
export BENGALI_TRANSLATOR_URL="${BENGALI_TRANSLATOR_URL:-$BENGALI_URL}"
exec node server/index.js
