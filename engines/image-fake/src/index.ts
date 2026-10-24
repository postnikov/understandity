import { ImageRequestSchema, type AdapterFactory, type ImageJob, type ProviderModule, type ImageAdapter } from '@understandity/contracts';

const PALETTE: Record<string, [string, string]> = {
  fantasy: ['#2d1b4e', '#c9a227'],
  cyberpunk: ['#0b0f2a', '#00e5ff'],
  anime: ['#ffe4ef', '#ff5c8a'],
  sport: ['#0f3d2e', '#f2f2f2'],
};

/** Returns an SVG scheme (two blocks over water) as a data URL, synchronously `done`. */
export const createFakeImage: AdapterFactory<'image'> = (config, { providerId }): ImageAdapter => {
  const jobs = new Map<string, ImageJob>();
  let n = 0;
  return {
    modality: 'image',
    provider: providerId,
    locality: config.locality,
    heavy: false,
    async health() {
      return { state: 'ok', detail: 'fake illustrator, SVG schemes', loadedModel: null, checkedAt: new Date().toISOString() };
    },
    async listModels() {
      return config.models.map((id) => ({ id, label: 'Fake image', installed: true }));
    },
    capabilities() {
      return { async: false, maxWidth: 2048, maxHeight: 2048, outputFormat: 'svg' };
    },
    async generate(input) {
      const req = ImageRequestSchema.parse(input);
      const [bg, fg] = PALETTE[req.style] ?? ['#1e1e2e', '#a6e3a1'];
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 260"><rect width="400" height="260" fill="${bg}"/><rect y="150" width="400" height="110" fill="${fg}" opacity="0.25"/><rect x="70" y="118" width="110" height="50" rx="6" fill="${fg}"/><rect x="250" y="190" width="44" height="44" rx="4" fill="${fg}" opacity="0.8"/></svg>`;
      const job: ImageJob = {
        jobId: `fake-${++n}`,
        state: 'done',
        file: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
        mimeType: 'image/svg+xml',
        error: null,
        progress: 1,
      };
      jobs.set(job.jobId, job);
      return job;
    },
    async getJob(jobId) {
      return jobs.get(jobId) ?? { jobId, state: 'failed', file: null, mimeType: null, error: 'unknown job', progress: null };
    },
  };
};

export const imageFake: ProviderModule<'image'> = { modality: 'image', providerId: 'fake', create: createFakeImage };
