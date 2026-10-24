"""Fixture tests: no real registry, inbox, model, repo config or npm installation."""
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import shlex
import shutil
import time
import uuid
import socket
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import unittest
from unittest.mock import patch
import wave

spec = importlib.util.spec_from_file_location('demo', Path(__file__).with_name('demo.py'))
demo = importlib.util.module_from_spec(spec)
spec.loader.exec_module(demo)


def fixture_config():
    def provider(model, **kw):
        return {'enabled': True, 'locality': 'local', 'models': [model], 'options': {}, **kw}
    providers = {
        'text': {'ollama': provider('gemma-fixture', endpoint='http://127.0.0.1:11434', options={'minVersion': '0.40.8'})},
        'stt': {'gemma-audio': provider('gemma-fixture', endpoint='http://127.0.0.1:11434', options={'ffmpeg': 'ffmpeg'}),
                'whisper-cpp': provider('whisper-fixture', options={'binary': 'whisper-cli', 'modelFile': '/missing-fixture'})},
        'tts': {'mlx-qwen3': provider('fixture/voice', voices=['Fixture'], endpoint='http://127.0.0.1:8790', options={'languages': ['ru']})},
        'image': {'fake': provider('fixture-svg')},
    }
    providers['text']['cloud'] = provider('cloud-fixture', enabled=False, locality='cloud', endpoint='https://example.invalid')
    engines = {m: {'provider': p, 'model': providers[m][p]['models'][0]} for m, p in {'text': 'ollama', 'stt': 'whisper-cpp', 'tts': 'mlx-qwen3', 'image': 'fake'}.items()}
    engines['tts']['voice'] = 'Fixture'
    return {'version': 1, 'providers': providers, 'defaults': {'profile': 'offline', 'language': 'ru', 'world': 'fantasy', 'engines': engines}}


def fixture_wav():
    raw = io.BytesIO()
    with wave.open(raw, 'wb') as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(24000)
        wav.writeframes(b'\x01\x00' * 2400)
    return raw.getvalue()


class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.config = fixture_config()
        self.policy = demo.read_json(Path(__file__).with_name('demo.json'))

    def test_offline_canonical_models_without_mutating_config(self):
        original = copy.deepcopy(self.config)
        plan = demo.make_plan(self.config, self.policy)
        self.assertEqual(plan['profile'], 'offline')
        self.assertEqual(plan['engines']['text']['model'], 'gemma-fixture')
        self.assertEqual(plan['engines']['stt']['model'], 'whisper-fixture')
        self.assertEqual(plan['engines']['tts']['voice'], 'Fixture')
        self.assertEqual(self.config, original)

    def test_enabled_cloud_is_rejected_even_when_unselected(self):
        self.config['providers']['text']['cloud']['enabled'] = True
        with self.assertRaisesRegex(demo.DemoError, 'Enabled cloud'):
            demo.make_plan(self.config, self.policy)

    def test_external_endpoint_cannot_claim_locality(self):
        self.config['providers']['stt']['gemma-audio']['endpoint'] = 'http://example.invalid:11434'
        with self.assertRaisesRegex(demo.DemoError, 'External endpoint'):
            demo.make_plan(self.config, self.policy)

    def test_no_fake_fallback_when_real_provider_not_merged(self):
        self.config['providers']['tts']['mlx-qwen3']['enabled'] = False
        with self.assertRaisesRegex(demo.DemoError, 'not enabled'):
            demo.make_plan(self.config, self.policy)

    def test_selected_provider_cannot_require_credentials(self):
        self.config['providers']['text']['ollama']['secretEnv'] = 'FAKE_TEST_KEY'
        with self.assertRaisesRegex(demo.DemoError, 'requires a secret'):
            demo.make_plan(self.config, self.policy)

    def test_default_online_rejected_before_any_server_starts(self):
        self.config['defaults']['profile'] = 'online'
        with self.assertRaisesRegex(demo.DemoError, 'defaults must already'):
            demo.make_plan(self.config, self.policy)

    def test_transcript_must_preserve_negation(self):
        demo.verify_transcript({'text': 'Важна не масса, а плотность!'}, self.policy)
        with self.assertRaises(demo.DemoError):
            demo.verify_transcript({'text': 'Важна масса, а плотность.'}, self.policy)

    def test_wav_must_be_real_nonempty_audio(self):
        self.assertEqual(demo.verify_wav(fixture_wav()), 0.1)
        with self.assertRaises(demo.DemoError):
            demo.verify_wav(b'<html>unavailable</html>')

    def test_env_is_exact_allowlist_and_enforces_offline(self):
        with patch.dict(os.environ, {'FAKE_TEST_SECRET': 'synthetic', 'NODE_OPTIONS': '--fake', 'HTTPS_PROXY': 'http://invalid'}):
            env = demo.clean_env(Path('/tmp/fixture-only'), self.policy)
            self.assertNotIn('FAKE_TEST_SECRET', env)
            self.assertNotIn('NODE_OPTIONS', env)
            self.assertNotIn('HTTPS_PROXY', env)
            self.assertEqual(env['HF_HUB_OFFLINE'], '1')
            self.assertEqual(env['UNDERSTANDITY_ALLOW_DRAFTS'], '0')

    def test_url_policy_rejects_credentials_and_external_hosts(self):
        for url in ('http://127.0.0.1:123', 'http://localhost:123', 'http://[::1]:123'):
            self.assertTrue(demo.local_url(url))
        for url in ('https://example.invalid', 'http://127.0.0.1.example.invalid', 'http://user:pass@localhost'):
            self.assertFalse(demo.local_url(url))

    def test_runtime_checks_reject_cloud_and_missing_models(self):
        plan = demo.make_plan(self.config, self.policy)
        providers = [{'modality': modality, 'provider': sel['provider'], 'enabled': True, 'locality': 'local', 'offlineSafe': True,
                      'health': {'state': 'ok'}, 'models': [{'id': sel['model'], 'installed': True}]} for modality, sel in plan['engines'].items()]
        value = {'settings': plan, 'providers': providers}
        demo.verify_engines(value, plan)
        value['providers'][0]['models'][0]['installed'] = False
        with self.assertRaisesRegex(demo.DemoError, 'not installed'):
            demo.verify_engines(value, plan)
        value['providers'][0]['models'][0]['installed'] = True
        value['providers'][0]['locality'] = 'cloud'
        with self.assertRaisesRegex(demo.DemoError, 'enabled cloud'):
            demo.verify_engines(value, plan)

    def test_http_redirect_is_never_followed(self):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(302)
                self.send_header('Location', 'http://example.invalid/should-not-be-contacted')
                self.end_headers()
            def log_message(self, *_args):
                pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        try:
            with self.assertRaisesRegex(demo.DemoError, 'redirect refused'):
                demo.request(f'http://127.0.0.1:{server.server_port}/')
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        # Test caller sets TMPDIR to the task's own directory.
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        (self.repo / 'config').mkdir()
        (self.repo / 'config/engines.json').write_text(json.dumps(fixture_config()))
        (self.repo / 'package-lock.json').write_text('{}')
        self.policy = demo.read_json(Path(__file__).with_name('demo.json'))
        self.instance = demo.Demo(self.repo, self.policy)

    def tearDown(self):
        self.tmp.cleanup()

    def test_npm_offline_has_no_implicit_online_retry(self):
        seen = []
        def failed(args, **_kwargs):
            seen.append(args)
            raise subprocess.CalledProcessError(1, ['fixture-npm'])
        with patch.object(self.instance, 'command', side_effect=failed):
            with self.assertRaises(subprocess.CalledProcessError):
                self.instance.install_node()
        self.assertEqual(len(seen), 1)
        self.assertIn('--offline', seen[0])
        self.assertNotIn('--prefer-offline', seen[0])

    def test_dependency_sync_race_is_detected(self):
        def change_lock(_args, **_kwargs):
            (self.repo / 'package-lock.json').write_text('{"changed": true}')
        with patch.object(self.instance, 'command', side_effect=change_lock):
            with self.assertRaisesRegex(demo.DemoError, 'manifests changed'):
                self.instance.install_node()
        self.assertFalse((self.instance.runtime / 'dependencies.json').exists())

    def test_resident_model_is_never_unloaded_by_preflight(self):
        calls = []
        def existing(url, **kwargs):
            calls.append((url, sorted(kwargs)))
            return {'models': [{'name': 'someone-elses-model'}]}
        with patch.object(demo, 'request', side_effect=existing):
            with self.assertRaisesRegex(demo.DemoError, 'resident model'):
                self.instance.ensure_empty_ollama()
        self.assertEqual(len(calls), 1)
        self.assertTrue(calls[0][0].endswith('/api/ps'))

    def test_foreign_tmux_session_is_never_stopped(self):
        calls = []
        def owner(args, **_kwargs):
            calls.append(args)
            return subprocess.CompletedProcess(args, 0, stdout='/someone/else\n')
        with patch.object(self.instance, 'tmux_exists', return_value=True), patch.object(self.instance, 'command', side_effect=owner):
            with self.assertRaisesRegex(demo.DemoError, 'different launcher'):
                self.instance.stop()
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][1], 'show-options')

    def test_warmup_serializes_gemma_voice_and_stt(self):
        self.instance.plan = demo.make_plan(self.instance.config, self.policy)
        calls = []
        def local_http(url, method='GET', data=None, **kwargs):
            calls.append(url.rsplit('/', 1)[-1])
            if url.endswith('/api/ps'):
                return {'models': []}
            if url.endswith('/api/chat'):
                self.assertEqual(data['keep_alive'], 0)
                return {'message': {'content': 'OK'}}
            if url.endswith('/tts'):
                return fixture_wav()
            if '/stt?' in url:
                self.assertEqual(kwargs['mime'], 'audio/wav')
                return {'text': 'Важна не масса, а плотность.', 'model': 'whisper-fixture'}
            self.fail('Unexpected request: ' + url)
        with patch.object(demo, 'request', side_effect=local_http):
            result = self.instance.warmup()
        self.assertTrue(result['syntheticSpeechRoundTrip'])
        self.assertEqual(calls, ['chat', 'ps', 'ps', 'tts', 'ps', 'tts', 'stt?lang=ru'])

    @unittest.skipUnless(shutil.which('tmux'), 'tmux is required for the process ownership check')
    def test_real_tmux_session_stops_without_leaving_a_process(self):
        self.policy['session'] = 'test-understandity-' + uuid.uuid4().hex[:12]
        instance = demo.Demo(self.repo, self.policy)
        instance.runtime.mkdir(parents=True)
        command = shlex.join([sys.executable, '-c', 'import time; time.sleep(30)'])
        pane = instance.command(['tmux', 'new-session', '-d', '-P', '-F', '#{pane_id}', '-s', instance.session, command], capture_output=True, text=True).stdout.strip()
        instance.command(['tmux', 'set-option', '-t', instance.session, '@understandity-repo', str(instance.repo)])
        instance.command(['tmux', 'set-option', '-t', instance.session, '@understandity-pane', pane])
        try:
            time.sleep(0.1)
            self.assertTrue(instance.tmux_exists())
            instance.stop()
            self.assertFalse(instance.tmux_exists())
        finally:
            if instance.tmux_exists():
                instance.command(['tmux', 'kill-session', '-t', '=' + instance.session])

    def test_stale_ready_file_cannot_pass_a_new_start(self):
        self.instance.runtime.mkdir(parents=True)
        demo.write_json(self.instance.status, {'runId': 'old-run', 'state': 'ready'})
        with patch.object(self.instance, 'preflight'), patch.object(self.instance, 'install_node'), patch.object(self.instance, 'command', return_value=subprocess.CompletedProcess(['fixture'], 0, stdout='%123')), patch.object(self.instance, 'tmux_exists', side_effect=[False, False, False]):
            with self.assertRaisesRegex(demo.DemoError, 'exited before readiness'):
                self.instance.start()

    def test_failure_reaps_only_owned_children_and_records_exit(self):
        # Real child process; no model/daemon. Failure exercises the production cleanup path.
        owned = []
        def start_child(_name, _args, cwd=None):
            child = self.original_spawn('fixture', [sys.executable, '-c', 'import time; time.sleep(30)'])
            owned.append(child)
            return child
        self.original_spawn = self.instance.spawn
        original_handlers = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)}
        try:
            with patch.object(self.instance, 'preflight', return_value={}), patch.object(self.instance, 'spawn', side_effect=start_child), patch.object(self.instance, 'wait_url', side_effect=demo.DemoError('fixture readiness failure')):
                result = self.instance.supervise('fixture-run')
            self.assertEqual(result, 1)
            self.assertTrue(owned and all(child.poll() is not None for child in owned))
            status = demo.read_json(self.instance.status)
            self.assertEqual(status['state'], 'failed')
            self.assertEqual(status['exitCode'], 1)
        finally:
            for sig, handler in original_handlers.items():
                signal.signal(sig, handler)


if __name__ == '__main__':
    unittest.main()
