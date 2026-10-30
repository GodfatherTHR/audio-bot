#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ -f data/llama-server.pid ]]; then
  pid="$(cat data/llama-server.pid)"
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid"
    echo "Stopped ASR server ($pid)."
  fi
  rm -f data/llama-server.pid
fi

if [[ -f data/bengali-translator.pid ]]; then
  pid="$(cat data/bengali-translator.pid)"
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid"
    echo "Stopped Bengali translator ($pid)."
  fi
  rm -f data/bengali-translator.pid
fi

echo "Stop the Node process with Ctrl-C in its terminal."
