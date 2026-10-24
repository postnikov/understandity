#!/usr/bin/env python3
"""Loopback-only Qwen TTS. Each synthesis owns a disposable MLX process."""
from __future__ import annotations

import argparse
import json
import os
import signal
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
import wave


class Rejected(Exception):
    def __init__(self, code, message, status=400):
        self.code, self.message, self.status = code, message, status


class Engine:
    def __init__(self, config):
        self.config = config
        self.options = config['options']
        self.model = config['models'][0]
        self.running = threading.Lock()
        self.process_lock = threading.Lock()
        self.process = None
        self.epoch = 0

    def snapshot(self):
        cache = Path(self.options['cacheDir']).expanduser()
        path = cache / ('models--' + self.model.replace('/', '--')) / 'snapshots' / self.options['revision']
        weights = list(path.glob('*.safetensors'))
        if not (path / 'config.json').is_file() or not weights or any(not p.is_file() or p.stat().st_size == 0 for p in weights):
            raise Rejected('model_missing', 'pinned local model snapshot is missing', 424)
        if not (path / 'speech_tokenizer' / 'config.json').is_file():
            raise Rejected('model_missing', 'local speech tokenizer is missing', 424)
        return path

    def health(self):
        try:
            self.snapshot()
            status = 'loading' if self.running.locked() else 'ok'
        except Rejected:
            status = 'down'
        return {'status': status, 'model': self.model, 'loaded': self.process is not None,
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
        if 'instruct' in data and (not isinstance(data['instruct'], str) or len(data['instruct']) > 1000):
            raise Rejected('bad_input', 'invalid instruction')

    def synthesize(self, data):
        self.validate(data)
        snapshot = self.snapshot()
        with self.process_lock:
            if not self.running.acquire(blocking=False):
                raise Rejected('busy', 'synthesis already running', 409)
            epoch = self.epoch
        try:
            with tempfile.TemporaryDirectory(prefix='understandity-mlx-') as directory:
                output = Path(directory) / 'speech.wav'
                payload = {'request': data, 'snapshot': str(snapshot), 'output': str(output), 'options': self.options}
                env = dict(os.environ, HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1', TOKENIZERS_PARALLELISM='false')
                with self.process_lock:
                    if epoch != self.epoch:
                        raise Rejected('busy', 'synthesis was unloaded', 409)
                    process = subprocess.Popen([sys.executable, str(Path(__file__).with_name('worker.py'))], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
                    self.process = process
                try:
                    process.communicate(json.dumps(payload).encode(), timeout=self.options['timeoutMs'] / 1000)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.communicate()
                    raise Rejected('internal', 'synthesis timed out', 500)
                finally:
                    with self.process_lock:
                        if self.process is process:
                            self.process = None
                if process.returncode != 0 or not output.is_file():
                    raise Rejected('internal', 'local synthesis failed', 500)
                with wave.open(str(output)) as audio:
                    if audio.getframerate() != self.options['sampleRateHz'] or audio.getnchannels() != 1 or audio.getsampwidth() != 2 or audio.getnframes() == 0:
                        raise Rejected('internal', 'invalid synthesized WAV', 500)
                    duration = audio.getnframes() / audio.getframerate()
                return output.read_bytes(), duration
        finally:
            self.running.release()

    def unload(self):
        # Hold the barrier until Metal-owning process is reaped, including timeout/cancel.
        with self.process_lock:
            self.epoch += 1
            if self.process is not None:
                if self.process.poll() is None:
                    self.process.kill()
                self.process.wait()
                self.process = None
        # Pending pre-spawn work observes the epoch and cannot start after this barrier.
        with self.running:
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
                self.respond(200, audio, 'audio/wav', {'X-Duration-Sec': duration, 'X-Model': engine.model, 'X-Voice': data['voice']})
            except Rejected as exc:
                self.respond(exc.status, json.dumps({'error': exc.code, 'message': exc.message}).encode())
            except (ValueError, TypeError):
                self.respond(400, b'{"error":"bad_input","message":"invalid JSON request"}')
            except Exception:
                self.respond(500, b'{"error":"internal","message":"sidecar operation failed"}')
    return Handler


def main():
    if sys.version_info[:2] != (3, 11):
        raise SystemExit('Use the project Python 3.11 environment')
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', type=Path, default=Path(__file__).resolve().parents[2] / 'config' / 'engines.json')
    parser.add_argument('--port', type=int)
    args = parser.parse_args()
    config = json.loads(args.config.read_text())['providers']['tts']['mlx-qwen3']
    engine = Engine(config)
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
