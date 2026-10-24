"""Installer fixtures: no real packages, models, keys, services, or user caches."""
import contextlib
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import install
from demo import DemoError


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.policy = install.policy_file()
        self.policy['INSTALL_CACHE'] = str(self.root / 'install-cache')
        self.config = json.loads((install.ROOT / 'config/engines.json').read_text())
        for key in ('kokoro', 'mlx-qwen3'):
            self.config['providers']['tts'][key]['options']['cacheDir'] = str(self.root / 'hf')
        self.config['providers']['stt']['whisper-cpp']['options']['modelFile'] = str(self.root / 'whisper.bin')
        self.payload = b'fixture model contents, not a real model'
        self.policy['WHISPER_BYTES'] = str(len(self.payload))
        self.policy['WHISPER_SHA256'] = hashlib.sha256(self.payload).hexdigest()
        (self.root / 'config').mkdir()
        (self.root / 'config/engines.json').write_text(json.dumps(self.config))

    def tearDown(self):
        self.tmp.cleanup()

    def plan(self):
        return install.model_plan(self.config, self.policy)

    def test_public_download_plan_follows_app_config_and_pins_all_hf(self):
        plan = self.plan()
        self.assertEqual(plan['ollama']['model'], self.config['defaults']['engines']['text']['model'])
        self.assertTrue(plan['ollama']['manifest'].startswith('https://registry.ollama.ai/v2/library/'))
        for job in plan['hf']:
            self.assertEqual(len(job['revision']), 40)
        qwen = next(j for j in plan['hf'] if j['provider'] == 'mlx-qwen3')
        self.assertIn('speech_tokenizer/model.safetensors', qwen['files'])
        kokoro = next(j for j in plan['hf'] if j['provider'] == 'kokoro')
        self.assertIn('voices/af_heart.safetensors', kokoro['files'])
        self.assertFalse(any(f.endswith('.pt') for f in kokoro['files']))

    def test_unpinned_branch_refuses_before_downloading(self):
        self.config['providers']['tts']['kokoro']['options']['revision'] = 'main'
        with self.assertRaisesRegex(DemoError, 'full pinned'):
            self.plan()

    def test_remote_ollama_refused(self):
        self.config['providers']['text']['ollama']['endpoint'] = 'https://cloud.example.invalid'
        with self.assertRaisesRegex(DemoError, 'loopback'):
            self.plan()

    def test_whisper_atomic_download_and_idempotent_verified_skip(self):
        job = self.plan()['whisper']
        calls = []
        def fetch(args):
            calls.append(args)
            Path(args[args.index('--output') + 1]).write_bytes(self.payload)
        install.download_whisper(job, fetch)
        install.download_whisper(job, fetch)
        self.assertEqual(len(calls), 1)
        self.assertIn('--continue-at', calls[0])
        self.assertEqual(Path(job['path']).read_bytes(), self.payload)
        self.assertFalse(Path(job['path'] + '.understandity.part').exists())

    def test_corrupt_existing_whisper_is_preserved(self):
        job = self.plan()['whisper']
        target = Path(job['path'])
        target.write_bytes(b'user existing data')
        def forbidden(_args):
            self.fail('Existing file must not trigger a replacement download')
        with self.assertRaisesRegex(DemoError, 'Existing Whisper'):
            install.download_whisper(job, forbidden)
        self.assertEqual(target.read_bytes(), b'user existing data')

    def test_bad_download_never_becomes_final_whisper(self):
        job = self.plan()['whisper']
        def fetch(args):
            Path(args[args.index('--output') + 1]).write_bytes(b'wrong contents')
        with self.assertRaisesRegex(DemoError, 'checksum mismatch'):
            install.download_whisper(job, fetch)
        self.assertFalse(Path(job['path']).exists())

    def test_completed_partial_resumes_at_atomic_rename(self):
        job = self.plan()['whisper']
        Path(job['path'] + '.understandity.part').write_bytes(self.payload)
        def forbidden(_args):
            self.fail('Complete partial should not download again')
        install.download_whisper(job, forbidden)
        self.assertEqual(Path(job['path']).read_bytes(), self.payload)

    def test_hf_cache_requires_all_tokenizers_and_voices(self):
        job = self.plan()['hf'][0]
        snapshot = Path(job['snapshot'])
        for name in job['files']:
            file = snapshot / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(b'fixture')
        self.assertTrue(install.cached(job))
        missing = snapshot / job['files'][-1]
        missing.unlink()
        missing.symlink_to(self.root / 'absent')
        self.assertFalse(install.cached(job))

    def test_cached_hf_does_not_import_downloader(self):
        job = self.plan()['hf'][0]
        with patch.object(install, 'cached', return_value=True):
            install.download_hf(job)

    def test_dry_run_prints_plan_without_writing_or_starting(self):
        with patch.object(install, 'policy_file', return_value=self.policy):
            instance = install.Installer(self.root)
        before = sorted(str(p.relative_to(self.root)) for p in self.root.rglob('*'))
        with patch.object(install, 'request', side_effect=AssertionError('network forbidden')), patch.object(install.subprocess, 'run', side_effect=AssertionError('process forbidden')):
            with contextlib.redirect_stdout(io.StringIO()) as output:
                instance.show_plan()
        self.assertIn('WOULD DOWNLOAD:', output.getvalue())
        self.assertFalse(instance.runtime.exists())
        self.assertEqual(before, sorted(str(p.relative_to(self.root)) for p in self.root.rglob('*')))

    def test_python_lock_includes_kokoro_english_g2p_without_torch(self):
        text = (install.ROOT / 'sidecars/tts-mlx/requirements.lock').read_text()
        self.assertIn('mlx-audio==0.5.4', text)
        self.assertIn('misaki==', text)
        self.assertIn('en-core-web-sm @ ', text)
        self.assertIn('espeakng-loader==', text)
        self.assertNotIn('\ntorch==', text)

    def test_linux_is_rejected_before_bootstrap(self):
        fake = self.root / 'bin'
        fake.mkdir()
        uname = fake / 'uname'
        uname.write_text('#!/bin/sh\necho Linux\n')
        uname.chmod(0o755)
        env = {'PATH': str(fake) + ':/usr/bin:/bin', 'HOME': str(self.root)}
        result = subprocess.run(['/bin/bash', str(install.ROOT / 'scripts/install.sh'), '--dry-run'], env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn('Not supported yet', result.stderr)
        self.assertNotIn('WOULD INSTALL', result.stdout)


if __name__ == '__main__':
    unittest.main()
