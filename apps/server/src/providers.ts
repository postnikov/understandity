import type { Modality, ProviderModule } from '@understandity/contracts';
import { textFake } from '@understandity/engine-text-fake';
import { textGeminiApi } from '@understandity/engine-text-gemini-api';
import { sttFake } from '@understandity/engine-stt-fake';
import { ttsFake } from '@understandity/engine-tts-fake';
import { ttsElevenLabs } from '@understandity/engine-tts-elevenlabs';
import { imageFake } from '@understandity/engine-image-fake';

/**
 * Wiring of engine packages. A new provider = its own `engines/<modality>-<provider>` package
 * + ONE line here + its entry in `config/engines.json`. Nothing else in the server changes.
 */
export const PROVIDERS: ProviderModule<Modality>[] = [
  textFake,
  textGeminiApi,
  sttFake,
  ttsFake,
  ttsElevenLabs,
  imageFake,
] as ProviderModule<Modality>[];
