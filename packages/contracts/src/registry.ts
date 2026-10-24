import type { AdapterByModality } from './adapters.js';
import type { Modality } from './common.js';
import type { ProviderConfig } from './settings.js';

/** Every `engines/<modality>-<provider>` package exports one factory of this shape. */
export type AdapterFactory<M extends Modality> = (config: ProviderConfig, ctx: { providerId: string }) => AdapterByModality[M];

export interface ProviderModule<M extends Modality> {
  modality: M;
  providerId: string;
  create: AdapterFactory<M>;
}
