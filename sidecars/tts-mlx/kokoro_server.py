#!/usr/bin/env python3
"""Loopback-only Kokoro-82M TTS for English. Unlike the Qwen sidecar the model stays resident:
82M parameters are cheap to keep, and a fresh process per reply would cost seconds of imports
(mlx, spaCy, misaki) — exactly the delay this voice exists to remove.

Same HTTP contract as server.py: GET /health, POST /synthesize → audio/wav, POST /unload → 204.
Offline: weights, voices and the spaCy model come from local caches; nothing is downloaded."""
from __future__ import annotations

import argparse
import gc
import io
import json
import os
import signal
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1')

from server import Rejected  # same error type and codes as the Qwen sidecar


class Kokoro:
    def __init__(self, config):
        self.config = config
        self.options = config['options']
        self.model_id = config['models'][0]
        self.lock = threading.Lock()
        self.model = None

    def snapshot(self) -> Path:
        cache = Path(self.options['cacheDir']).expanduser()
        path = cache / ('models--' + self.model_id.replace('/', '--')) / 'snapshots' / self.options['revision']
        weights = path / 'kokoro-v1_0.safetensors'
        if not (path / 'config.json').is_file() or not weights.is_file() or weights.stat().st_size == 0:
            raise Rejected('model_missing', 'pinned local Kokoro snapshot is missing', 424)
        missing = [v for v in self.config['voices'] if not (path / 'voices' / f'{v}.safetensors').is_file()]
        if missing:
            raise Rejected('model_missing', 'pinned local Kokoro voice is missing', 424)
        return path

    def health(self):
        try:
            self.snapshot()
            import spacy.util  # noqa: PLC0415 — the G2P needs this model locally, never via spacy download
            status = 'ok' if spacy.util.is_package('en_core_web_sm') else 'down'
            if self.lock.locked() and status == 'ok':
                status = 'loading'
        except Rejected:
            status = 'down'
        return {'status': status, 'model': self.model_id, 'loaded': self.model is not None,
                'voices': self.config['voices'], 'languages': self.options['languages'], 'version': '0.1.0'}

    def validate(self, data):
        if not isinstance(data, dict) or set(data) - {'text', 'language', 'voice', 'instruct', 'sampleRateHz'}:
            raise Rejected('bad_input', 'invalid request fields')
        text = data.get('text')
        if not isinstance(text, str) or not text.strip() or len(text) > 2000:
            raise Rejected('bad_input', 'text must contain 1 to 2000 characters')
        if data.get('language') not in self.options['languages'] or data.get('voice') not in self.config['voices']:
            raise Rejected('unsupported', 'unsupported language or voice', 422)
        if data.get('sampleRateHz', self.options['sampleRateHz']) != self.options['sampleRateHz']:
            raise Rejected('unsupported', 'unsupported sample rate', 422)

    def synthesize(self, data):
        self.validate(data)
        snapshot = self.snapshot()
        if not self.lock.acquire(timeout=self.options['timeoutMs'] / 1000):
            raise Rejected('busy', 'synthesis already running', 409)
        try:
            import numpy as np
            import soundfile as sf
            if self.model is None:
                from mlx_audio.tts.utils import load_model
                self.model = load_model(snapshot, model_type='kokoro')
            voice = data['voice']
            # Voice by file path: the pipeline would otherwise resolve it through the hub by branch name.
            voice_path = str(snapshot / 'voices' / f'{voice}.safetensors')
            lang_code = 'b' if voice.startswith('b') else 'a'
            chunks, rate = [], None
            for result in self.model.generate(text=data['text'], voice=voice_path, lang_code=lang_code,
                                              speed=float(self.options.get('speed', 1.0)), verbose=False):
                if rate is not None and rate != result.sample_rate:
                    raise Rejected('internal', 'inconsistent sample rate', 500)
                rate = result.sample_rate
                chunks.append(np.asarray(result.audio).reshape(-1))
            if not chunks or rate != self.options['sampleRateHz']:
                raise Rejected('internal', 'invalid generated audio', 500)
            audio = np.concatenate(chunks)
            buf = io.BytesIO()
            sf.write(buf, audio, rate, format='WAV', subtype='PCM_16')
            return buf.getvalue(), len(audio) / rate
        finally:
            self.lock.release()

    def unload(self):
        with self.lock:
            self.model = None
            gc.collect()
            try:
                import mlx.core as mx
                mx.clear_cache()
            except Exception:  # noqa: BLE001 — freeing is best effort, the reference is already dropped
                pass


def handler_for(engine):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def respond(self, status, payload=b'', content_type='application/json', headers=None):
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(payload)))
            self.send_header('Cache-Control', 'no-store')
            for key, value in (headers or {}).items():
                self.send_header(key, str(value))
            self.end_headers()
            try:
                self.wfile.write(payload)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def admitted(self):
            host = self.headers.get('Host', '').split(':')[0]
            return host in ('127.0.0.1', 'localhost') and not self.headers.get('Origin')

        def do_GET(self):
            if not self.admitted():
                return self.respond(403, b'{"error":"bad_input","message":"loopback client required"}')
            if self.path != '/health':
                return self.respond(404)
            self.respond(200, json.dumps(engine.health()).encode())

        def do_POST(self):
            try:
                if not self.admitted():
                    raise Rejected('bad_input', 'loopback client required', 403)
                if self.path == '/unload':
                    engine.unload()
                    return self.respond(204)
                if self.path != '/synthesize':
                    return self.respond(404)
                if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
                    raise Rejected('bad_input', 'JSON required', 415)
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= 16384:
                    raise Rejected('bad_input', 'invalid request size', 413)
                self.connection.settimeout(10)
                data = json.loads(self.rfile.read(size))
                audio, duration = engine.synthesize(data)
                self.respond(200, audio, 'audio/wav', {'X-Duration-Sec': duration, 'X-Model': engine.model_id, 'X-Voice': data['voice']})
            except Rejected as exc:
                self.respond(exc.status, json.dumps({'error': exc.code, 'message': exc.message}).encode())
            except (ValueError, TypeError):
                self.respond(400, b'{"error":"bad_input","message":"invalid JSON request"}')
            except Exception:  # noqa: BLE001
                self.respond(500, b'{"error":"internal","message":"sidecar operation failed"}')
    return Handler


def main():
    if sys.version_info[:2] != (3, 11):
        raise SystemExit('Use the project Python 3.11 environment')
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', type=Path, default=Path(__file__).resolve().parents[2] / 'config' / 'engines.json')
    parser.add_argument('--port', type=int)
    args = parser.parse_args()
    config = json.loads(args.config.read_text())['providers']['tts']['kokoro']
    engine = Kokoro(config)
    port = args.port or urlparse(config['endpoint']).port
    server = ThreadingHTTPServer(('127.0.0.1', port), handler_for(engine))

    def stop(_signum, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stop)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        engine.unload()
        server.server_close()


if __name__ == '__main__':
    main()
