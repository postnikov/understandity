"""Disposable inference process. No network/downloads, stdout, or text logs."""
import json
import os
import sys


def main():
    payload = json.load(sys.stdin)
    os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1')
    import mlx.core as mx
    import numpy as np
    import soundfile as sf
    from mlx_audio.tts.utils import load_model

    req, options = payload['request'], payload['options']
    model = load_model(payload['snapshot'])
    mx.random.seed(options['seed'])
    chunks = []
    rate = None
    for result in model.generate(text=req['text'], voice=req['voice'], lang_code=options['languageNames'][req['language']],
                                 instruct=req.get('instruct'), temperature=options['temperature'], top_p=options['topP'],
                                 max_tokens=options['maxTokens'], verbose=False):
        if rate is not None and rate != result.sample_rate:
            raise ValueError('inconsistent sample rate')
        rate = result.sample_rate
        chunks.append(np.asarray(result.audio).reshape(-1))
    if not chunks or rate != options['sampleRateHz']:
        raise ValueError('invalid generated audio')
    sf.write(payload['output'], np.concatenate(chunks), rate, format='WAV', subtype='PCM_16')
    os.chmod(payload['output'], 0o600)


if __name__ == '__main__':
    main()
