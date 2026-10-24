#!/usr/bin/env python3
"""Offline demo launcher. Writes only inside the ignored sidecar .venv."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import time
from urllib.parse import urlparse
from urllib.request import Request, build_opener, ProxyHandler, HTTPRedirectHandler
import uuid
import wave

HERE = Path(__file__).resolve().parent
MODALITIES = ('text', 'stt', 'tts', 'image')


class DemoError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise DemoError(message)


def read_json(path):
    return json.loads(Path(path).read_text())


def write_json(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    temporary.replace(path)


def local_url(value):
    parsed = urlparse(value)
    return (parsed.scheme == 'http' and parsed.hostname in ('127.0.0.1', 'localhost', '::1')
            and not parsed.username and not parsed.password)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        raise DemoError('HTTP redirect refused in the offline demo')


def request(url, method='GET', data=None, mime='application/json', timeout=10, binary=False):
    require(local_url(url), 'Non-loopback HTTP endpoint refused')
    if isinstance(data, dict):
        data = json.dumps(data).encode()
    req = Request(url, data=data, method=method, headers={'Content-Type': mime})
    # Ignore inherited corporate/cloud proxies; a redirect must never leave loopback.
    with build_opener(ProxyHandler({}), NoRedirect()).open(req, timeout=timeout) as response:
        raw = response.read()
    return raw if binary else (json.loads(raw) if raw else None)


def clean_env(runtime, policy):
    # An exact allowlist: no API keys, NODE_OPTIONS, proxies, .env, or Python hooks.
    env = {key: os.environ[key] for key in ('HOME', 'USER', 'LOGNAME', 'PATH', 'LANG') if key in os.environ}
    env.update({
        'TMPDIR': str(runtime), 'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONNOUSERSITE': '1',
        'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1', 'HF_HUB_DISABLE_TELEMETRY': '1',
        'TOKENIZERS_PARALLELISM': 'false', 'NO_PROXY': '127.0.0.1,localhost,::1',
        'UNDERSTANDITY_PORT': str(policy['serverPort']), 'UNDERSTANDITY_WEB_PORT': str(policy['webPort']),
        'UNDERSTANDITY_ALLOW_DRAFTS': '0', 'VITE_ALLOW_DRAFTS': '0',
    })
    return env


def make_plan(config, policy):
    require(config['defaults']['profile'] == 'offline', 'App defaults must already be offline; ask HQ to fix config')
    for modality in MODALITIES:
        for name, provider in config['providers'][modality].items():
            if provider.get('enabled', True):
                require(provider['locality'] == 'local', f'Enabled cloud provider: {modality}/{name}')
                endpoint = provider.get('endpoint')
                require(not endpoint or local_url(endpoint), f'External endpoint: {modality}/{name}')
    engines = {}
    for modality, name in policy['providers'].items():
        provider = config['providers'][modality].get(name)
        require(provider and provider.get('enabled', True), f'{modality}/{name} is not enabled; main may not be merged')
        require(not provider.get('secretEnv'), f'{modality}/{name} requires a secret; offline demo cannot use it')
        selected = config['defaults']['engines'][modality]
        require(selected['provider'] == name, f'{modality}: canonical demo defaults have changed; review scripts/demo/demo.json')
        require(selected['model'] in provider['models'], f'{modality}: default model is not configured')
        engines[modality] = {**selected, 'voice': selected.get('voice')}
    # Voice by language: the routes must be exactly the ones this launcher was reviewed for.
    routes = config['providers']['tts'][engines['tts']['provider']]['options'].get('routes') or {}
    require({lang: r.get('provider') for lang, r in routes.items()} == policy['voiceRoutes'],
            'Voice routes differ from scripts/demo/demo.json; review the demo policy')
    for lang, route in routes.items():
        target = config['providers']['tts'].get(route['provider'])
        require(target and target.get('enabled', True), f'tts route {lang} → {route["provider"]} is not enabled')
        require(not target.get('secretEnv'), f'tts route {lang} → {route["provider"]} requires a secret')
        require(route['model'] in target['models'], f'tts route {lang}: model is not configured')
        require(route.get('voice') in target.get('voices', []), f'tts route {lang}: voice is not configured')
        require(lang in target['options'].get('languages', []), f'tts route {lang}: language is unsupported by {route["provider"]}')
    for item in policy['warmup']:
        require(item['language'] in routes, f'Warmup language has no voice route: {item["language"]}')
    return {**config['defaults'], 'profile': 'offline', 'engines': engines}


def verify_settings(value, plan):
    require(value == plan, 'Running settings differ from the requested Offline profile')


def verify_engines(value, plan):
    verify_settings(value['settings'], plan)
    for provider in value['providers']:
        if provider['enabled']:
            require(provider['locality'] == 'local' and provider['offlineSafe'], 'Runtime exposes an enabled cloud/external provider')
    for modality, selection in plan['engines'].items():
        provider = next((p for p in value['providers'] if p['modality'] == modality and p['provider'] == selection['provider']), None)
        require(provider and provider['health'] and provider['health']['state'] == 'ok', f'{modality}: selected provider is not healthy')
        require(any(m['id'] == selection['model'] and m['installed'] for m in provider['models']), f'{modality}: model is not installed')


def verify_wav(raw):
    try:
        with wave.open(io.BytesIO(raw)) as audio:
            require(audio.getnchannels() == 1 and audio.getsampwidth() == 2 and audio.getnframes() > 0, 'Invalid or empty PCM voice output')
            return round(audio.getnframes() / audio.getframerate(), 3)
    except (wave.Error, EOFError) as error:
        raise DemoError('Invalid WAV voice output') from error


def verify_transcript(value, item):
    words = set(re.findall(r'\w+', value.get('text', '').lower()))
    require(set(item['requiredWords']) <= words, 'Synthetic speech was not transcribed completely (including negation)')


class Demo:
    def __init__(self, repo, policy):
        self.repo = repo.resolve()
        self.policy = policy
        self.venv = self.repo / 'sidecars/tts-mlx/.venv'
        self.runtime = self.venv / 'demo-runtime'
        self.status = self.runtime / 'status.json'
        self.session = policy['session']
        self.api = f"http://127.0.0.1:{policy['serverPort']}/api"
        self.web = f"http://127.0.0.1:{policy['webPort']}"
        self.config = read_json(self.repo / 'config/engines.json')
        self.children = []
        self.logs = []
        self.owns_gemma = False

    def command(self, args, **kwargs):
        return subprocess.run(args, cwd=self.repo, env=clean_env(self.runtime, self.policy), check=True, **kwargs)

    def tmux_exists(self):
        return subprocess.run(['tmux', 'has-session', '-t', '=' + self.session], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0

    def verify_owner(self):
        owner = self.command(['tmux', 'show-options', '-t', self.session, '-v', '@understandity-repo'], capture_output=True, text=True).stdout.strip()
        require(owner == str(self.repo), 'tmux session belongs to a different launcher/repository')

    def dependency_fingerprint(self):
        inputs = [self.repo / 'package.json', self.repo / 'package-lock.json']
        for group in ('apps', 'engines', 'packages'):
            inputs.extend(sorted(self.repo.glob(group + '/*/package.json')))
        digest = hashlib.sha256()
        for path in inputs:
            if path.is_file():
                digest.update(str(path.relative_to(self.repo)).encode() + b'\0' + path.read_bytes())
        return digest.hexdigest()

    def install_node(self, online=False):
        require((self.repo / 'package-lock.json').is_file(), 'package-lock.json is missing')
        self.runtime.mkdir(parents=True, exist_ok=True)
        # No audit/fund calls. Online mode is an explicit preparation step, never a fallback.
        args = ['npm', 'ci', '--prefer-offline' if online else '--offline', '--no-audit', '--no-fund']
        fingerprint = self.dependency_fingerprint()
        log_name = 'npm-ci-prepare.log' if online else 'npm-ci.log'
        with (self.runtime / log_name).open('w') as log:
            self.command(args, stdout=log, stderr=subprocess.STDOUT)
        require(self.dependency_fingerprint() == fingerprint, 'Synced dependency manifests changed during npm ci; repeat preparation on stable main')
        write_json(self.runtime / 'dependencies.json', {'fingerprint': fingerprint, 'offlineInstallVerified': not online})
        print('npm ci: OK (' + ('preparation' if online else 'offline cache only') + ')', flush=True)

    def preflight(self):
        self.plan = make_plan(self.config, self.policy)
        for tool in ('node', 'npm', 'tmux', self.policy['python']):
            require(shutil.which(tool), f'Missing executable: {tool}')
        version = self.command(['node', '--version'], capture_output=True, text=True).stdout.strip()
        require(int(version.lstrip('v').split('.')[0]) >= self.policy['nodeMinMajor'], 'Node is too old')
        require((self.repo / 'sidecars/tts-mlx/server.py').is_file(), 'MLX sidecar is not merged')
        require((self.venv / 'bin/python').is_file(), 'Prepare the Python 3.11 MLX sidecar .venv first')
        code = ('import sys,importlib.metadata as m; '
                'assert sys.version_info[:2] == (3,11); '
                f'assert m.version("mlx-audio") == {self.policy["mlxAudioVersion"]!r}; '
                'import importlib.util as u; '
                + ''.join(f'assert u.find_spec({name!r}), {name!r}; ' for name in self.policy['venvModules']))
        self.command([str(self.venv / 'bin/python'), '-c', code], capture_output=True)
        stt = self.config['providers']['stt']['gemma-audio']
        whisper = self.config['providers']['stt']['whisper-cpp']['options']
        for tool in (stt['options']['ffmpeg'], whisper['binary']):
            require(shutil.which(tool), f'Missing executable: {tool}')
        require(Path(whisper['modelFile']).expanduser().is_file(), 'Whisper fallback weights are missing')
        tts = self.config['providers']['tts']['mlx-qwen3']
        snapshot = Path(tts['options']['cacheDir']).expanduser() / ('models--' + tts['models'][0].replace('/', '--')) / 'snapshots' / tts['options']['revision']
        for relative in ('config.json', 'speech_tokenizer/config.json'):
            require((snapshot / relative).is_file(), f'Incomplete pinned MLX snapshot: {relative}')
        for folder in (snapshot, snapshot / 'speech_tokenizer'):
            weights = list(folder.glob('*.safetensors'))
            require(weights and all(p.is_file() and p.stat().st_size > 0 for p in weights), 'Missing MLX/tokenizer weights or dangling symlinks')
        kokoro = self.config['providers']['tts']['kokoro']
        k_snapshot = Path(kokoro['options']['cacheDir']).expanduser() / ('models--' + kokoro['models'][0].replace('/', '--')) / 'snapshots' / kokoro['options']['revision']
        for relative in ['config.json', 'kokoro-v1_0.safetensors'] + [f'voices/{v}.safetensors' for v in kokoro['voices']]:
            path = k_snapshot / relative
            require(path.is_file() and path.stat().st_size > 0, f'Incomplete pinned Kokoro snapshot: {relative}')
        ollama = self.config['providers']['text']['ollama']
        actual = request(ollama['endpoint'] + '/api/version')['version']
        parts = lambda s: tuple(int(v) for v in s.split('.')[:3])
        require(parts(actual) >= parts(ollama['options']['minVersion']), 'Ollama is too old for audio')
        tags = request(ollama['endpoint'] + '/api/tags')['models']
        require(any(m.get('name') == self.plan['engines']['text']['model'] for m in tags), 'Gemma model is missing from Ollama')
        self.ensure_empty_ollama()
        ports = [self.policy['serverPort'], self.policy['webPort'], urlparse(tts['endpoint']).port, urlparse(kokoro['endpoint']).port]
        require(len(set(ports)) == len(ports), 'Demo listener ports overlap')
        for port in ports:
            with socket.socket() as sock:
                # TIME_WAIT left by an open browser tab reconnecting is not an owner; a real listener still fails.
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                try:
                    sock.bind(('127.0.0.1', port))
                except OSError as error:
                    raise DemoError(f'Port {port} is occupied; no existing process was stopped') from error
        return {'node': version, 'ollama': actual, 'profile': self.plan, 'snapshot': str(snapshot)}

    def ensure_empty_ollama(self):
        loaded = request(self.config['providers']['text']['ollama']['endpoint'] + '/api/ps')
        require(loaded.get('models') == [], 'Ollama already has a resident model; release it before demo warmup')

    def spawn(self, name, args, cwd=None):
        log = (self.runtime / (name + '.log')).open('w')
        self.logs.append(log)
        process = subprocess.Popen(args, cwd=cwd or self.repo, env=clean_env(self.runtime, self.policy), stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        self.children.append(process)
        return process

    def wait_url(self, url):
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            require(all(p.poll() is None for p in self.children), 'A demo process exited; inspect demo-runtime logs')
            try:
                return request(url, timeout=2)
            except (OSError, ValueError):
                time.sleep(0.25)
        raise DemoError('Local server did not become ready: ' + url)

    def check(self):
        require((request(self.web + '/api/health', timeout=30)).get('ok'), 'App health is not OK through the web proxy')
        verify_engines(request(self.api + '/engines', timeout=30), self.plan)
        html = request(self.web, binary=True).decode()
        require('<html' in html.lower(), 'Web entry did not return HTML')
        require(not re.search(r'(?:src|href)=[\"\']https?://', html), 'Web entry references an external asset')
        return {'web': self.web, 'offlineProfile': True, 'enabledCloudProviders': 0}

    def warmup(self):
        result = {}
        ollama = self.config['providers']['text']['ollama']
        model = self.plan['engines']['text']['model']
        start = time.monotonic()
        self.owns_gemma = True
        answer = request(ollama['endpoint'] + '/api/chat', 'POST', {
            'model': model, 'stream': False, 'think': False, 'keep_alive': 0,
            'messages': [{'role': 'user', 'content': 'Reply with the word OK.'}], 'options': {'num_predict': 8},
        }, timeout=self.policy['requestTimeoutSec'])
        require(answer.get('message', {}).get('content', '').strip(), 'Gemma warmup returned no text')
        self.ensure_empty_ollama()
        result['gemmaSec'] = round(time.monotonic() - start, 3)
        # Each voice route in policy order (English/Kokoro first): two syntheses, then a Whisper round trip.
        for item in self.policy['warmup']:
            lang = item['language']
            speech = {'text': item['text'], 'language': lang}
            for number in (1, 2):
                self.ensure_empty_ollama()
                start = time.monotonic()
                raw = request(self.api + '/tts', 'POST', speech, binary=True, timeout=self.policy['requestTimeoutSec'])
                result[f'tts_{lang}_{number}Sec'] = round(time.monotonic() - start, 3)
                result[f'audio_{lang}_DurationSec'] = verify_wav(raw)
            start = time.monotonic()
            transcript = request(self.api + '/stt?lang=' + lang, 'POST', raw, mime='audio/wav', timeout=self.policy['requestTimeoutSec'])
            verify_transcript(transcript, item)
            require(transcript.get('model') == self.plan['engines']['stt']['model'], 'STT response did not come from the configured model')
            result[f'stt_{lang}_Sec'] = round(time.monotonic() - start, 3)
        result['syntheticSpeechRoundTrip'] = True
        return result

    def supervise(self, run_id):
        self.runtime.mkdir(parents=True, exist_ok=True)
        code = 1
        state = {'runId': run_id, 'state': 'starting', 'pid': os.getpid()}
        write_json(self.status, state)
        def stop(_signum, _frame):
            raise KeyboardInterrupt
        for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(sig, stop)
        try:
            # A new process performs the same admission checks immediately before starting children.
            inventory = self.preflight()
            tts = self.config['providers']['tts']['mlx-qwen3']
            self.spawn('tts', [str(self.venv / 'bin/python'), str(self.repo / 'sidecars/tts-mlx/server.py')])
            require(self.wait_url(tts['endpoint'] + '/health')['status'] == 'ok', 'Pinned MLX snapshot is unavailable')
            kokoro = self.config['providers']['tts']['kokoro']
            self.spawn('tts-kokoro', [str(self.venv / 'bin/python'), str(self.repo / 'sidecars/tts-mlx/kokoro_server.py')])
            require(self.wait_url(kokoro['endpoint'] + '/health')['status'] == 'ok', 'Pinned Kokoro snapshot or its English G2P model is unavailable')
            self.spawn('server', [str(self.repo / 'node_modules/.bin/tsx'), 'apps/server/src/main.ts'])
            self.wait_url(self.api + '/settings')
            applied = request(self.api + '/settings', 'PUT', self.plan)
            require(applied.get('ok'), 'Offline provider selection rejected; main may not be merged')
            verify_settings(applied['settings'], self.plan)
            timings = self.warmup()
            self.spawn('web', [str(self.repo / 'node_modules/.bin/vite'), '--host', '127.0.0.1', '--port', str(self.policy['webPort']), '--strictPort'], self.repo / 'apps/web')
            self.wait_url(self.web + '/api/settings')
            checks = self.check()
            state.update(state='ready', inventory=inventory, timings=timings, checks=checks,
                         checkedAt=datetime.now(timezone.utc).isoformat(), networkPhysicallyDisabled=False)
            write_json(self.status, state)
            print('DEMO READY ' + self.web, flush=True)
            while True:
                require(all(p.poll() is None for p in self.children), 'A running demo process exited')
                time.sleep(0.5)
        except KeyboardInterrupt:
            code = 0
            state['state'] = 'stopped'
        except Exception as error:
            # Do not persist arbitrary subprocess env/argv or HTTP response contents.
            state.update(state='failed', error=str(error))
            print('DEMO FAILED: ' + str(error), flush=True)
        finally:
            # Reap only process groups created by this invocation, never a port owner or unrelated model.
            for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
                signal.signal(sig, signal.SIG_IGN)
            for process in reversed(self.children):
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGTERM)
            for process in reversed(self.children):
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
            if self.owns_gemma:
                try:
                    request(self.config['providers']['text']['ollama']['endpoint'] + '/api/generate', 'POST',
                            {'model': self.plan['engines']['text']['model'], 'stream': False, 'keep_alive': 0}, timeout=30)
                except Exception:
                    state['cleanupWarning'] = 'Could not confirm release of the demo Gemma model'
            for log in self.logs:
                log.close()
            state['exitCode'] = code
            write_json(self.status, state)
            print('EXIT=' + str(code), flush=True)
        return code

    def start(self):
        self.runtime.mkdir(parents=True, exist_ok=True)
        with (self.runtime / 'start.lock').open('w') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise DemoError('Another demo start is in progress') from error
            require(not self.tmux_exists(), 'Demo session already exists; use check or stop')
            self.preflight()
            self.install_node()
            run_id = uuid.uuid4().hex
            env_args = [f'{key}={value}' for key, value in clean_env(self.runtime, self.policy).items()]
            command = shlex.join(['env', '-i', *env_args, self.policy['python'], '-B', str(HERE / 'demo.py'), 'supervise', '--repo', str(self.repo), '--run-id', run_id])
            pane = self.command(['tmux', 'new-session', '-d', '-P', '-F', '#{pane_id}', '-s', self.session, command], capture_output=True, text=True).stdout.strip()
            require(re.fullmatch(r'%[0-9]+', pane), 'tmux did not return an owned pane ID')
            # set/show-options do not accept the =exact-session syntax in tmux 3.7b.
            self.command(['tmux', 'set-option', '-t', self.session, '@understandity-repo', str(self.repo)])
            self.command(['tmux', 'set-option', '-t', self.session, '@understandity-pane', pane])
            deadline = time.monotonic() + self.policy['startupTimeoutSec']
            try:
                while time.monotonic() < deadline:
                    state = read_json(self.status) if self.status.exists() else {}
                    if state.get('runId') == run_id:
                        if state.get('state') == 'ready':
                            print('DEMO READY ' + self.web, flush=True)
                            print(json.dumps(state['timings'], ensure_ascii=False), flush=True)
                            return state
                        require(state.get('state') != 'failed', state.get('error', 'Demo startup failed'))
                    require(self.tmux_exists(), 'Demo supervisor exited before readiness; inspect status.json')
                    time.sleep(0.5)
                raise DemoError('Demo startup timed out')
            except BaseException:
                self.stop()
                raise

    def stop(self):
        if self.tmux_exists():
            self.verify_owner()
            pane = self.command(['tmux', 'show-options', '-t', self.session, '-v', '@understandity-pane'], capture_output=True, text=True).stdout.strip()
            require(re.fullmatch(r'%[0-9]+', pane), 'Owned tmux pane is missing')
            self.command(['tmux', 'send-keys', '-t', pane, 'C-c'])
            deadline = time.monotonic() + 60
            while self.tmux_exists() and time.monotonic() < deadline:
                time.sleep(0.25)
            require(not self.tmux_exists(), 'Supervisor has not finished cleanup; inspect its tmux session')
        print('Demo session stopped', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('prepare', 'preflight', 'start', 'check', 'smoke', 'stop', 'supervise'), nargs='?', default='start')
    parser.add_argument('--repo', type=Path, default=HERE.parents[1])
    parser.add_argument('--run-id', default='')
    args = parser.parse_args()
    policy = read_json(HERE / 'demo.json')
    demo = Demo(args.repo, policy)
    if args.action == 'supervise':
        require(args.run_id, 'Missing run ID')
        # The tmux pane is for operation only; durable supervisor output goes to the ignored runtime.
        with (demo.runtime / 'supervisor.log').open('w', buffering=1) as log:
            sys.stdout = log
            sys.stderr = log
            return demo.supervise(args.run_id)
    if args.action == 'prepare':
        require(not demo.tmux_exists(), 'Stop the demo before reinstalling dependencies')
        demo.install_node(online=True)
        demo.install_node()
    elif args.action == 'preflight':
        print(json.dumps(demo.preflight(), ensure_ascii=False, indent=2))
    elif args.action == 'stop':
        demo.stop()
    elif args.action == 'check':
        require(demo.tmux_exists(), 'Demo is not running')
        demo.verify_owner()
        demo.plan = make_plan(demo.config, policy)
        print(json.dumps(demo.check(), ensure_ascii=False))
    elif args.action == 'smoke':
        demo.start()
        try:
            print('LOCAL SMOKE PASS (physical network disconnect not tested)', flush=True)
        finally:
            demo.stop()
    else:
        demo.start()
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (DemoError, OSError, ValueError, subprocess.CalledProcessError) as error:
        print('DEMO FAILED: ' + str(error), file=sys.stderr)
        sys.exit(1)
