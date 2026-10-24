import http.client
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
import wave

from server import Engine, Rejected, ThreadingHTTPServer, handler_for


class SidecarTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='understandity-sidecar-test-')
        self.addCleanup(self.tmp.cleanup)
        self.config = {'models': ['fixture/model'], 'voices': ['voice'], 'options': {
            'cacheDir': self.tmp.name, 'revision': 'fixed-revision', 'languages': ['en'],
            'sampleRateHz': 24000, 'timeoutMs': 1000}}
        self.engine = Engine(self.config)
        self.snapshot = Path(self.tmp.name) / 'models--fixture--model' / 'snapshots' / 'fixed-revision'
        (self.snapshot / 'speech_tokenizer').mkdir(parents=True)
        for filename in ['config.json', 'weights.safetensors', 'speech_tokenizer/config.json']:
            (self.snapshot / filename).write_text('fixture')
        self.request = {'text': 'Density matters.', 'language': 'en', 'voice': 'voice'}

    def test_health_does_not_load_model_and_requires_pinned_snapshot(self):
        self.assertEqual(self.engine.health()['status'], 'ok')
        self.assertFalse(self.engine.health()['loaded'])
        self.config['options']['revision'] = 'not-cached'
        self.assertEqual(self.engine.health()['status'], 'down')
        with self.assertRaises(Rejected) as error:
            self.engine.synthesize(self.request)
        self.assertEqual(error.exception.code, 'model_missing')

    def test_validation_and_busy_admission_before_worker(self):
        for bad in [{'text': ''}, {'text': 'x' * 2001}, {'language': 'ca'}, {'voice': 'missing'}, {'sampleRateHz': 48000}, {'instruct': 123}, {'model': 'remote'}]:
            with self.subTest(bad=list(bad)):
                with self.assertRaises(Rejected):
                    self.engine.validate(dict(self.request, **bad))
        self.engine.running.acquire()
        try:
            with self.assertRaises(Rejected) as error:
                self.engine.synthesize(self.request)
            self.assertEqual(error.exception.code, 'busy')
        finally:
            self.engine.running.release()

    def test_worker_contract_offline_flags_wav_and_cleanup(self):
        paths = []
        offline = []
        class Worker:
            returncode = 0
            def __init__(self, *_args, env=None, **_kwargs):
                # Capture only safe booleans, never inherited env in assertions.
                offline.append(env.get('HF_HUB_OFFLINE') == '1' and env.get('TRANSFORMERS_OFFLINE') == '1')
            def communicate(self, payload, **_kwargs):
                data = json.loads(payload)
                paths.append(data['output'])
                with wave.open(data['output'], 'wb') as wav:
                    wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(24000)
                    wav.writeframes(b'\x00\x01' * 2400)
        with patch('server.subprocess.Popen', new=Worker):
            audio, duration = self.engine.synthesize(self.request)
        self.assertEqual(audio[:4], b'RIFF')
        self.assertAlmostEqual(duration, .1)
        self.assertEqual(offline, [True])
        self.assertFalse(Path(paths[0]).exists())
        self.assertFalse(self.engine.health()['loaded'])

    def test_unload_kills_and_reaps_only_own_worker(self):
        child = subprocess.Popen([sys.executable, '-c', 'import time;time.sleep(60)'])
        self.engine.process = child
        self.engine.unload()
        self.assertIsNotNone(child.poll())
        self.assertIsNone(self.engine.process)
        self.engine.unload()  # idempotent

    def test_http_contract_and_browser_origin_rejected(self):
        server = ThreadingHTTPServer(('127.0.0.1', 0), handler_for(self.engine))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        conn = http.client.HTTPConnection('127.0.0.1', server.server_port)
        self.addCleanup(conn.close)
        conn.request('GET', '/health')
        response = conn.getresponse(); data = json.loads(response.read())
        self.assertEqual(response.status, 200); self.assertFalse(data['loaded'])
        conn.request('POST', '/synthesize', json.dumps(self.request), {'Content-Type': 'application/json', 'Origin': 'https://untrusted.example'})
        response = conn.getresponse(); response.read(); self.assertEqual(response.status, 403)
        conn.request('POST', '/synthesize', '{broken', {'Content-Type': 'application/json'})
        response = conn.getresponse(); response.read(); self.assertEqual(response.status, 400)
        conn.request('POST', '/unload')
        response = conn.getresponse(); response.read(); self.assertEqual(response.status, 204)


if __name__ == '__main__':
    unittest.main()
