#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MODEL="LFM3-Audio-2B-Q4_K_M.gguf"
MMPROJ="mmproj-LFM3-Audio-2B-Q8_0.gguf"
MMPROJ_URL="https://huggingface.co/LiquidAI/LFM3-Audio-2B-GGUF/resolve/main/mmproj-LFM3-Audio-2B-Q8_0.gguf"
LLAMA_URL="https://github.com/ggml-org/llama.cpp/releases/download/b11960/llama-b11960-bin-ubuntu-x64.tar.gz"

for command in node npm ffmpeg pi curl; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Missing required command: $command"
    exit 1
  fi
done

if [[ ! -f "$MODEL" ]]; then
  echo "Missing $MODEL"
  echo "Place the provided LFM3-Audio-2B Q4_K_M GGUF in $ROOT."
  exit 1
fi

if [[ ! -f "$MMPROJ" ]]; then
  echo "Downloading the LFM3 audio projector ($MMPROJ)..."
  curl -L --fail --retry 3 -C - -o "$MMPROJ" "$MMPROJ_URL"
fi

if [[ ! -x runtime/llama/llama-server ]]; then
  echo "Downloading llama.cpp b11960 CPU build..."
  mkdir -p runtime
  tmp="$(mktemp -d)"
  curl -L --fail --retry 3 -o "$tmp/llama.tar.gz" "$LLAMA_URL"
  tar -xzf "$tmp/llama.tar.gz" -C "$tmp"
  mkdir -p runtime/llama
  cp -a "$tmp/llama-b11960/." runtime/llama/
  rm -rf "$tmp"
fi

echo "Installing Node dependencies..."
npm install --silent

mkdir -p data/audio data/pi-sessions workspace

echo
echo "Setup complete."
echo "Start the bot with: ./scripts/start.sh"
echo "Then open: http://127.0.0.1:3333"
