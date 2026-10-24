import tempfile
import unittest
from pathlib import Path

from kokoro_server import Kokoro
from server import Rejected

MODEL = 'mlx-community/Kokoro-82M-bf16'
REV = 'a71e4d38b236d968966a2002c4c895dbd12b1c3c'


def config(cache, voices=('af_heart', 'bf_emma')):
    return {'models': [MODEL], 'voices': list(voices), 'endpoint': 'http://127.0.0.1:8791',
            'options': {'revision': REV, 'cacheDir': str(cache), 'languages': ['en'], 'sampleRateHz': 24000, 'timeoutMs': 1000}}


def snapshot(cache, voices=('af_heart', 'bf_emma')):
    path = Path(cache) / ('models--' + MODEL.replace('/', '--')) / 'snapshots' / REV
    (path / 'voices').mkdir(parents=True)
    (path / 'config.json').write_text('{}')
    (path / 'kokoro-v1_0.safetensors').write_bytes(b'x')
    for v in voices:
        (path / 'voices' / f'{v}.safetensors').write_bytes(b'x')
    return path


class KokoroSidecarTest(unittest.TestCase):
    def test_missing_snapshot_is_model_missing_and_health_down(self):
        with tempfile.TemporaryDirectory() as cache:
            engine = Kokoro(config(cache))
            with self.assertRaises(Rejected) as err:
                engine.snapshot()
            self.assertEqual(err.exception.code, 'model_missing')
            self.assertEqual(engine.health()['status'], 'down')

    def test_missing_configured_voice_is_model_missing(self):
        with tempfile.TemporaryDirectory() as cache:
            snapshot(cache, voices=('af_heart',))
            with self.assertRaises(Rejected) as err:
                Kokoro(config(cache)).snapshot()
            self.assertEqual(err.exception.code, 'model_missing')

    def test_only_english_and_configured_voices(self):
        with tempfile.TemporaryDirectory() as cache:
            engine = Kokoro(config(cache))
            for bad in ({'text': 'Привет', 'language': 'ru', 'voice': 'af_heart'},
                        {'text': 'Hi', 'language': 'en', 'voice': 'am_adam'},
                        {'text': ' ', 'language': 'en', 'voice': 'af_heart'},
                        {'text': 'Hi', 'language': 'en', 'voice': 'af_heart', 'extra': 1}):
                with self.assertRaises(Rejected):
                    engine.validate(bad)
            engine.validate({'text': 'Hi', 'language': 'en', 'voice': 'bf_emma'})

    def test_health_reports_contract_fields_without_loading(self):
        with tempfile.TemporaryDirectory() as cache:
            snapshot(cache)
            h = Kokoro(config(cache)).health()
            self.assertEqual(set(h), {'status', 'model', 'loaded', 'voices', 'languages', 'version'})
            self.assertFalse(h['loaded'])


if __name__ == '__main__':
    unittest.main()
