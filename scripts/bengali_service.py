#!/usr/bin/env python3
"""Local Bengali-to-English translation service for Voice -> pi.

Loads the BanglaT5 Bengali-English NMT checkpoint once and exposes a tiny
JSON API on localhost. Used by the Node server for Bengali prompts.
"""

import argparse
import json
import os
import signal
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import ctranslate2
import sentencepiece as spm
from normalizer import normalize


class BanglaTranslator:
    def __init__(self, model_dir: str, threads: int) -> None:
        tokenizer_path = os.path.join(model_dir, "spiece.model")
        if not os.path.isfile(tokenizer_path):
            raise FileNotFoundError(f"Missing tokenizer: {tokenizer_path}")

        self.model_dir = model_dir
        self.sp = spm.SentencePieceProcessor(model_file=tokenizer_path)
        self.translator = ctranslate2.Translator(
            model_dir,
            device="cpu",
            inter_threads=1,
            intra_threads=max(1, threads),
        )
        self.lock = threading.Lock()
        self.compute_type = self.translator.compute_type

    def translate(self, text: str) -> str:
        tokens = self.sp.encode(normalize(text), out_type=str)
        if not tokens:
            raise ValueError("The Bengali text was empty after normalization.")

        with self.lock:
            result = self.translator.translate_batch(
                [tokens + ["</s>"]],
                target_prefix=[["<pad>"]],
                max_decoding_length=256,
                beam_size=4,
            )

        hypothesis = result[0].hypotheses[0]
        hypothesis = [
            token
            for token in hypothesis
            if token not in ("<pad>", "</s>", "<unk>")
        ]
        english = self.sp.decode(hypothesis).strip()
        if not english:
            raise ValueError("The translation was empty.")
        return english.strip().strip('"').strip()


class ApiHandler(BaseHTTPRequestHandler):
    translator: BanglaTranslator = None  # type: ignore[assignment]

    def log_message(self, fmt: str, *args) -> None:
        if args and str(args[1]).startswith(("4", "5")):
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path == "/health":
            self.send_json(
                200,
                {
                    "ok": True,
                    "model": "csebuetnlp/banglat5_nmt_bn_en",
                    "compute": self.translator.compute_type,
                },
            )
            return
        self.send_json(404, {"ok": False, "error": "Not found"})

    def do_POST(self) -> None:
        if self.path != "/translate":
            self.send_json(404, {"ok": False, "error": "Not found"})
            return

        try:
            length = int(self.headers.get("content-length", "0"))
            if length <= 0 or length > 64 * 1024:
                raise ValueError("Invalid request size.")
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            text = str(payload.get("text", "")).strip()
            if not text:
                raise ValueError("Missing Bengali text.")
            if len(text) > 4000:
                raise ValueError("Text is too long (max 4000 characters).")

            started = time.time()
            english = self.translator.translate(text)
            self.send_json(
                200,
                {
                    "ok": True,
                    "english": english,
                    "ms": round((time.time() - started) * 1000),
                },
            )
        except ValueError as error:
            self.send_json(400, {"ok": False, "error": str(error)})
        except Exception as error:  # noqa: BLE001
            self.send_json(500, {"ok": False, "error": str(error)})


def main() -> int:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=os.environ.get("BENGALI_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("BENGALI_PORT", "8098")))
    parser.add_argument(
        "--model-dir",
        default=os.environ.get(
            "BENGALI_MODEL_DIR",
            os.path.join(root, "runtime", "banglat5-nmt-bn-en-int8"),
        ),
    )
    parser.add_argument("--threads", type=int, default=int(os.environ.get("BENGALI_THREADS", "4")))
    args = parser.parse_args()

    print(f"Loading BanglaT5 from {args.model_dir} ...", flush=True)
    translator = BanglaTranslator(args.model_dir, args.threads)
    ApiHandler.translator = translator
    server = ThreadingHTTPServer((args.host, args.port), ApiHandler)
    print(
        f"Bengali translator ready on http://{args.host}:{args.port} "
        f"({translator.compute_type})",
        flush=True,
    )

    def stop(_signum, _frame):
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        server.serve_forever()
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
