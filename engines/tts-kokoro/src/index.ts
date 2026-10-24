import type { AdapterFactory, ProviderModule } from '@understandity/contracts';
import { createMlxTts } from '../../tts-mlx-qwen3/src/index.js';

/**
 * Kokoro-82M through `sidecars/tts-mlx/kokoro_server.py`. Same HTTP contract as the Qwen sidecar, so the
 * client is the same; the difference is residency. The model is tiny and stays loaded in its sidecar,
 * so it is not a heavy engine: speaking does not evict Gemma, and a reply is voiced in ~0.1 s warm.
 */
export const createKokoroTts: AdapterFactory<'tts'> = (config, ctx) => {
  const base = createMlxTts(config, ctx);
  return {
    ...base,
    heavy: false,
    async unload() {
      // Not called by the dispatcher (light engine); kept for an explicit stop.
      await base.unload?.(config.models[0]!);
    },
  };
};

export const ttsKokoro: ProviderModule<'tts'> = { modality: 'tts', providerId: 'kokoro', create: createKokoroTts };
