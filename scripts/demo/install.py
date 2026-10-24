#!/usr/bin/env python3
"""Full local install; standard-library planner, pinned voice/model downloads."""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import socket
import subprocess
import sys
import time
from urllib.parse import urlparse

from demo import DemoError, clean_env, local_url, read_json, request, require

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def policy_file(path=HERE / 'install.conf'):
    result = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        key, value = line.split('=', 1)
        parsed = shlex.split(value)
        require(len(parsed) == 1, 'Invalid install policy value: ' + key)
        result[key] = parsed[0]
    return result


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def model_plan(config, policy):
    chosen = config['defaults']['engines']['text']
    require(chosen['provider'] == 'ollama', 'Installer expects a local Ollama text default')
    ollama = config['providers']['text']['ollama']
    require(local_url(ollama['endpoint']), 'Ollama endpoint must be loopback HTTP')
    model = chosen['model']
    require(model in ollama['models'] and re.fullmatch(r'[A-Za-z0-9_./:-]+', model), 'Invalid Ollama model')
    name, tag = model.rsplit(':', 1)
    registry_name = name if '/' in name else 'library/' + name
    hf = []
    for provider in ('kokoro', 'mlx-qwen3'):
        cfg = config['providers']['tts'][provider]
        revision = cfg['options']['revision']
        require(re.fullmatch(r'[0-9a-f]{40}', revision), f'{provider}: use a full pinned HF commit')
        repo_id = cfg['models'][0]
        require(re.fullmatch(r'[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+', repo_id), 'Invalid public HF model ID')
        if provider == 'kokoro':
            require(all(re.fullmatch(r'[A-Za-z0-9_]+', v) for v in cfg['voices']), 'Invalid Kokoro voice name')
            files = ['config.json', 'kokoro-v1_0.safetensors', *[f'voices/{v}.safetensors' for v in cfg['voices']]]
        else:
            # Include text tokenizer and speech tokenizer. No unrelated model/download fallback.
            files = ['config.json', 'generation_config.json', 'model.safetensors', 'model.safetensors.index.json',
                     'preprocessor_config.json', 'tokenizer_config.json', 'vocab.json', 'merges.txt',
                     'speech_tokenizer/config.json', 'speech_tokenizer/configuration.json',
                     'speech_tokenizer/model.safetensors', 'speech_tokenizer/preprocessor_config.json']
        cache = Path(cfg['options']['cacheDir']).expanduser()
        snapshot = cache / ('models--' + repo_id.replace('/', '--')) / 'snapshots' / revision
        hf.append({'provider': provider, 'repo': repo_id, 'revision': revision, 'cache': str(cache),
                   'snapshot': str(snapshot), 'files': files})
    whisper = {'path': str(Path(config['providers']['stt']['whisper-cpp']['options']['modelFile']).expanduser()),
               'sha256': policy['WHISPER_SHA256'], 'bytes': int(policy['WHISPER_BYTES']),
               'url': 'https://huggingface.co/' + policy['WHISPER_REPO'] + '/resolve/' + policy['WHISPER_REVISION'] + '/' + policy['WHISPER_FILE']}
    require(re.fullmatch(r'[0-9a-f]{64}', whisper['sha256']), 'Whisper SHA256 is required')
    require(re.fullmatch(r'[0-9a-f]{40}', policy['WHISPER_REVISION']), 'Whisper revision must be pinned')
    return {'ollama': {'model': model, 'endpoint': ollama['endpoint'], 'minVersion': ollama['options']['minVersion'],
                        'manifest': 'https://registry.ollama.ai/v2/' + registry_name + '/manifests/' + tag},
            'whisper': whisper, 'hf': hf}


def cached(job):
    root = Path(job['snapshot'])
    return all((root / name).is_file() and (root / name).stat().st_size > 0 for name in job['files'])


def download_whisper(job, run):
    target = Path(job['path'])
    valid = lambda p: p.stat().st_size == job['bytes'] and sha256(p) == job['sha256']
    if target.exists():
        require(valid(target), 'Existing Whisper file failed checksum; preserve/rename it and rerun: ' + str(target))
        print('CACHED: Whisper (SHA256 verified)', flush=True)
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(target.name + '.understandity.part')
    # A completed partial can result from interruption just before the atomic rename.
    if not partial.exists() or partial.stat().st_size != job['bytes']:
        run(['curl', '--fail', '--location', '--proto', '=https', '--proto-redir', '=https',
             '--connect-timeout', '20', '--continue-at', '-', '--output', str(partial), job['url']])
    require(valid(partial), 'Whisper download checksum mismatch; partial file preserved: ' + str(partial))
    require(not target.exists(), 'Whisper target appeared during download; no file overwritten')
    partial.replace(target)
    print('INSTALLED: Whisper (SHA256 verified)', flush=True)


def download_hf(job):
    if cached(job):
        print('CACHED: ' + job['repo'], flush=True)
        return
    # Executed only by this file's private fetch action inside the freshly synced voice venv.
    from huggingface_hub import snapshot_download
    snapshot_download(repo_id=job['repo'], revision=job['revision'], cache_dir=job['cache'],
                      allow_patterns=job['files'], token=False, max_workers=2)
    require(cached(job), 'Incomplete pinned HF snapshot: ' + job['repo'])


def ollama_status(plan):
    try:
        return request(plan['endpoint'] + '/api/version', timeout=3)
    except OSError:
        return None


def ensure_ollama(plan, runtime, session, run):
    status = ollama_status(plan)
    if status is None:
        url = urlparse(plan['endpoint'])
        with socket.socket() as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind(('127.0.0.1', url.port or 80))
            except OSError as error:
                raise DemoError('Configured Ollama port is occupied by an unrecognized service; nothing stopped') from error
        exists = subprocess.run(['tmux', 'has-session', '-t', '=' + session], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        require(exists.returncode != 0, 'Ollama session already exists but is not healthy; inspect it before retrying')
        # No launchd or login item. The local daemon outlives the installer for the demo command.
        env = {k: os.environ[k] for k in ('HOME', 'PATH', 'USER', 'LOGNAME', 'LANG') if k in os.environ}
        env['OLLAMA_HOST'] = plan['endpoint']
        command = shlex.join(['env', '-i', *[k + '=' + v for k, v in env.items()], 'ollama', 'serve'])
        command += ' > ' + shlex.quote(str(runtime / 'ollama.log')) + ' 2>&1'
        run(['tmux', 'new-session', '-d', '-s', session, command])
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            status = ollama_status(plan)
            if status is not None:
                break
            time.sleep(0.25)
        require(status is not None, 'Ollama failed to start; inspect ' + str(runtime / 'ollama.log'))
    version = lambda s: tuple(int(n) for n in s.split('.')[:3])
    require(version(status['version']) >= version(plan['minVersion']), 'Existing Ollama server is too old; update/restart it before installing models')


class Installer:
    def __init__(self, root=ROOT):
        self.root = root
        self.policy = policy_file()
        self.config = read_json(root / 'config/engines.json')
        self.plan = model_plan(self.config, self.policy)
        self.venv = root / 'sidecars/tts-mlx/.venv'
        identity = hashlib.sha256(str(root.resolve()).encode()).hexdigest()[:16]
        self.runtime = Path(self.policy['INSTALL_CACHE']).expanduser() / identity

    def run(self, args):
        print('RUN: ' + shlex.join(str(x) for x in args), flush=True)
        env = clean_env(self.runtime, read_json(HERE / 'demo.json'))
        # Installation alone may use public package/model networks. No credentials are forwarded.
        env.pop('HF_HUB_OFFLINE', None)
        env.pop('TRANSFORMERS_OFFLINE', None)
        env.update(UV_PYTHON_DOWNLOADS='never', HF_HUB_DISABLE_IMPLICIT_TOKEN='1', OLLAMA_HOST=self.plan['ollama']['endpoint'])
        subprocess.run([str(x) for x in args], cwd=self.root, env=env, check=True)

    def show_plan(self):
        print('WOULD SYNC: Python 3.11 venv from sidecars/tts-mlx/requirements.lock (MLX, Kokoro G2P, Qwen3-TTS)')
        print('WOULD RUN: npm ci, then a second npm ci --offline to verify the package cache')
        print('OLLAMA: ' + self.plan['ollama']['model'] + ' (skip pull if already installed)')
        print('PUBLIC MANIFEST: ' + self.plan['ollama']['manifest'])
        whisper = self.plan['whisper']
        print('WHISPER: ' + whisper['url'])
        print('DESTINATION: ' + whisper['path'] + ' (SHA256 ' + whisper['sha256'] + ')')
        for job in self.plan['hf']:
            print(('CACHED: ' if cached(job) else 'WOULD DOWNLOAD: ') + job['repo'] + '@' + job['revision'])
            print('  ' + str(len(job['files'])) + ' pinned files → ' + job['snapshot'])
        print('WOULD START IF NEEDED: local Ollama in tmux; no login service, no inference')
        print('WOULD VERIFY: local preflight (not a live voice or microphone test)')

    def install(self):
        self.runtime.mkdir(parents=True, exist_ok=True)
        with (self.runtime / 'install.lock').open('a') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise DemoError('Another installer is running for this folder') from error
            # Never rebuild packages underneath a live demo or occupy somebody else's port.
            for port in [read_json(HERE / 'demo.json')['serverPort'], read_json(HERE / 'demo.json')['webPort'],
                         *[urlparse(self.config['providers']['tts'][p]['endpoint']).port for p in ('kokoro', 'mlx-qwen3')]]:
                with socket.socket() as sock:
                    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                    try:
                        sock.bind(('127.0.0.1', port))
                    except OSError as error:
                        raise DemoError('Stop the running demo before installing (port ' + str(port) + ')') from error
            python = self.venv / 'bin/python'
            if not python.exists():
                self.run(['uv', 'venv', '--python', shutil.which('python3.11'), str(self.venv)])
            self.run([python, '-c', 'import sys; assert sys.version_info[:2] == (3, 11), "Expected Python 3.11 venv"'])
            self.run(['uv', 'pip', 'sync', '--python', python, self.root / 'sidecars/tts-mlx/requirements.lock'])
            self.run(['uv', 'pip', 'check', '--python', python])
            self.run(['bash', self.root / 'scripts/demo/start.sh', 'prepare'])
            ensure_ollama(self.plan['ollama'], self.runtime, self.policy['OLLAMA_SESSION'], self.run)
            tags = request(self.plan['ollama']['endpoint'] + '/api/tags')['models']
            if any(m.get('name') == self.plan['ollama']['model'] for m in tags):
                print('CACHED: ' + self.plan['ollama']['model'], flush=True)
            else:
                self.run(['ollama', 'pull', self.plan['ollama']['model']])
            download_whisper(self.plan['whisper'], self.run)
            for job in self.plan['hf']:
                if cached(job):
                    print('CACHED: ' + job['repo'], flush=True)
                else:
                    self.run([python, '-B', HERE / 'install.py', 'fetch-hf', '--provider', job['provider'], '--repo', self.root])
            self.run(['bash', self.root / 'scripts/demo/start.sh', 'preflight'])
            print('INSTALL COMPLETE — local dependencies and weights verified; no inference performed.')
            print('Start: bash ' + shlex.quote(str(self.root / 'scripts/demo/start.sh')))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('dry-run', 'install', 'fetch-hf', 'daemon'))
    parser.add_argument('--provider', choices=('kokoro', 'mlx-qwen3'))
    parser.add_argument('--repo', type=Path, default=ROOT)
    args = parser.parse_args()
    instance = Installer(args.repo.resolve())
    if args.action == 'daemon':
        instance.runtime.mkdir(parents=True, exist_ok=True)
        ensure_ollama(instance.plan['ollama'], instance.runtime, instance.policy['OLLAMA_SESSION'], instance.run)
        return
    if args.action == 'fetch-hf':
        require(args.provider, 'Missing HF provider')
        download_hf(next(j for j in instance.plan['hf'] if j['provider'] == args.provider))
        return
    instance.show_plan()
    if args.action == 'dry-run':
        print('DRY RUN COMPLETE — no files, dependencies, services or models changed.')
    else:
        instance.install()


if __name__ == '__main__':
    try:
        main()
    except (DemoError, OSError, ValueError, subprocess.CalledProcessError) as error:
        print('INSTALL FAILED: ' + str(error), file=sys.stderr)
        sys.exit(1)
