import type { Modality, ProviderModule } from '@understandity/contracts';
import { textFake } from '@understandity/engine-text-fake';
import { textGeminiApi } from '@understandity/engine-text-gemini-api';
import { textOllama } from '@understandity/engine-text-ollama';
import { textAnthropic } from '../../../engines/text-anthropic/src/index.js';
import { sttFake } from '@understandity/engine-stt-fake';
import { ttsFake } from '@understandity/engine-tts-fake';
import { ttsElevenLabs } from '@understandity/engine-tts-elevenlabs';
import { imageFake } from '@understandity/engine-image-fake';

import { sttGemma } from '../../../engines/stt-gemma-audio/src/index.js';
import { sttWhisper } from '../../../engines/stt-whisper-cpp/src/index.js';
import { sttElevenLabs } from '../../../engines/stt-elevenlabs/src/index.js';
import { ttsSay } from '../../../engines/tts-macos-say/src/index.js';
import { ttsMlx } from '../../../engines/tts-mlx-qwen3/src/index.js';
import { ttsKokoro } from '../../../engines/tts-kokoro/src/index.js';
import { imageComfy } from '../../../engines/image-comfyui/src/index.js';

/**
 * Wiring of engine packages. A new provider = its own `engines/<modality>-<provider>` package
 * + ONE line here + its entry in `config/engines.json`. Nothing else in the server changes.
 */
export const PROVIDERS: ProviderModule<Modality>[] = [
  textFake,
  textGeminiApi,
  textOllama,
  textAnthropic,
  sttFake,
  sttGemma,
  sttWhisper,
  sttElevenLabs,
  ttsFake,
  ttsSay,
  ttsMlx,
  ttsKokoro,
  ttsElevenLabs,
  imageFake,
  imageComfy,
] as ProviderModule<Modality>[];
