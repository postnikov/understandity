import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { ImageRequestSchema, type AdapterFactory, type ImageJob, type ProviderModule } from '@understandity/contracts';
import { activity, runtime } from '../../stt-whisper-cpp/src/runtime.js';

export const createComfyImage: AdapterFactory<'image'> = (config, { providerId }) => {
  const r = runtime(config, 'image', providerId), work = activity();
  const managed = r.str('apiMode', 'managed') === 'managed';
  const tenant = createHash('sha256').update(r.str('tenant', 'understandity')).digest('hex');
  const scope = createHash('sha256').update(r.str('scope', 'learning-illustrations')).digest('hex');
  const jobs = new Map<string, ImageJob>();
  let pending: string | undefined;
  const jobPath = (id: string, suffix = '') => `/overcortex/v1/jobs/${encodeURIComponent(id)}${suffix}?tenant=${tenant}`;
  async function ready(signal?: AbortSignal) {
    if (managed) return r.json('/overcortex/v1/health', undefined, signal);
    await r.json('/system_stats', undefined, signal);
    return { ready: true, busy: false, paused: false, memory_ok: true };
  }
  async function admission(signal?: AbortSignal) {
    // Never unload models belonging to another application, or bypass its guard.
    const endpoint = r.str('ollamaEndpoint');
    if (!endpoint) throw r.error('unavailable', 'Ollama resource guard endpoint is not configured');
    const ollama = runtime({ ...config, endpoint, secretEnv: null }, 'image', providerId);
    const loaded = await ollama.json('/api/ps', undefined, signal);
    if (!Array.isArray(loaded.models)) throw r.error('unavailable', 'invalid Ollama resource state');
    if (loaded.models.length) throw r.error('busy', 'unload Ollama before image generation');
    const status = await ready(signal);
    if (!status.ready) throw r.error('model_missing', 'ComfyUI model set is unavailable');
    if (status.busy || status.paused || !status.memory_ok) throw r.error('busy', 'ComfyUI admission guard refused generation');
    const queue = await r.json('/queue', undefined, signal);
    if (queue.queue_running?.length || queue.queue_pending?.length) throw r.error('busy', 'ComfyUI queue is occupied');
  }
  async function poll(id: string, signal?: AbortSignal): Promise<{ done: boolean; failed: boolean; file?: any }> {
    if (managed) {
      const result = await r.json(jobPath(id), undefined, signal);
      if (!['accepted', 'cancelling', 'completed', 'cancelled', 'failed', 'interrupted', 'expired'].includes(result.status)) throw r.error('internal', 'invalid ComfyUI job status');
      return { done: !['accepted', 'cancelling'].includes(result.status), failed: !['accepted', 'cancelling', 'completed'].includes(result.status) };
    }
    const history = (await r.json(`/history/${encodeURIComponent(id)}`, undefined, signal))[id];
    if (!history) return { done: false, failed: false };
    const file = Object.values(history.outputs ?? {}).flatMap((o: any) => o.images ?? [])[0];
    return { done: !!history.status?.completed || history.status?.status_str === 'error', failed: history.status?.status_str === 'error', file };
  }
  function remember(job: ImageJob) {
    jobs.set(job.jobId, job);
    if (jobs.size > r.num('maxCachedJobs', 16)) jobs.delete(jobs.keys().next().value!);
    return job;
  }
  return {
    modality: 'image', provider: providerId, locality: 'local', heavy: true,
    async health(opts) {
      try { const s = await ready(opts?.signal); return { state: s.ready && !s.paused ? (s.busy || !s.memory_ok ? 'degraded' : 'ok') : 'down', checkedAt: new Date().toISOString() }; }
      catch { return { state: 'down', detail: 'ComfyUI unavailable or runtime token missing', checkedAt: new Date().toISOString() }; }
    },
    async listModels(opts) {
      if (managed) { const s = await ready(opts?.signal); return config.models.map(id => ({ id, installed: !!s.ready })); }
      const info = await r.json('/object_info', undefined, opts?.signal);
      const names: string[] = info.UNETLoader?.input?.required?.unet_name?.[0] ?? [];
      const clips: string[] = info.CLIPLoader?.input?.required?.clip_name?.[0] ?? [];
      const vaes: string[] = info.VAELoader?.input?.required?.vae_name?.[0] ?? [];
      return config.models.map(id => ({ id, installed: names.includes(r.str('modelFile')) && clips.includes(r.str('textEncoder')) && vaes.includes(r.str('vae')) }));
    },
    // Holds the dispatcher slot through queueing, polling and download.
    capabilities: () => ({ async: false, maxWidth: r.num('maxWidth', 2048), maxHeight: r.num('maxHeight', 1344), outputFormat: 'png' }),
    async generate(input, opts) {
      const parsed = ImageRequestSchema.safeParse(input);
      if (!parsed.success) throw r.error('bad_input', 'invalid image request');
      const req = parsed.data; r.checkModel(req.model);
      if (req.width > r.num('maxWidth', 2048) || req.height > r.num('maxHeight', 1344) || req.width % 16 || req.height % 16) throw r.error('bad_input', 'unsupported image dimensions');
      if (req.seed !== undefined && (req.seed < 0 || req.seed > 4294967295)) throw r.error('bad_input', 'seed must be uint32');
      const prompt = `${req.topic}. Visual style: ${req.style}. Illustration only, no lettering, captions or watermarks.`;
      if (prompt.length > 4000) throw r.error('bad_input', 'image prompt is too long');
      return work.run(async signal => {
        if (pending) throw r.error('busy', 'previous image job needs unload before reuse');
        await admission(signal);
        let id: string;
        if (managed) {
          const presets = config.options.presets as Record<string, number[]> | undefined;
          const preset = Object.entries(presets ?? {}).find(([, size]) => size[0] === req.width && size[1] === req.height)?.[0];
          if (!preset || (req.steps !== undefined && req.steps !== r.num('steps', 9))) throw r.error('unsupported', 'managed ComfyUI uses configured dimensions and fixed steps');
          id = randomUUID(); pending = id;
          // Keep this ID even if the response is lost: never resubmit an uncertain job.
          await r.json('/overcortex/v1/jobs', { id, tenant, scope, prompt, preset, seed: req.seed ?? 0, day_limit: r.num('dayLimit', 20), month_limit: r.num('monthLimit', 100) }, signal);
        } else {
          const workflow = {
            '1': { class_type: 'UNETLoader', inputs: { unet_name: r.str('modelFile'), weight_dtype: 'default' } },
            '2': { class_type: 'CLIPLoader', inputs: { clip_name: r.str('textEncoder'), type: 'lumina2', device: 'default' } },
            '3': { class_type: 'VAELoader', inputs: { vae_name: r.str('vae') } },
            '4': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['2', 0] } },
            '5': { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['4', 0] } },
            '6': { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['1', 0], shift: r.num('shift', 3) } },
            '7': { class_type: 'EmptySD3LatentImage', inputs: { width: req.width, height: req.height, batch_size: 1 } },
            '8': { class_type: 'KSampler', inputs: { model: ['6', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['7', 0], seed: req.seed ?? 0, steps: req.steps ?? r.num('steps', 9), cfg: 1, sampler_name: r.str('sampler', 'res_multistep'), scheduler: r.str('scheduler', 'simple'), denoise: 1 } },
            '9': { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['3', 0] } },
            '10': { class_type: 'SaveImage', inputs: { images: ['9', 0], filename_prefix: 'understandity/' + randomUUID() } },
          };
          // Unknown submission result latches the provider; no automatic retry.
          pending = 'unknown';
          const result = await r.json('/prompt', { prompt: workflow, client_id: randomUUID() }, signal);
          if (typeof result.prompt_id !== 'string') throw r.error('internal', 'ComfyUI returned no job id');
          id = result.prompt_id; pending = id;
        }
        remember({ jobId: id, state: 'running', file: null, mimeType: null, error: null, progress: null });
        const deadline = Date.now() + r.num('jobTimeoutMs', 110_000);
        try {
          while (Date.now() < deadline) {
            r.checkAbort(signal);
            const status = await poll(id, signal);
            if (status.done) {
              pending = undefined;
              if (status.failed) throw r.error('unavailable', 'ComfyUI generation failed');
              let path = jobPath(id, '/image');
              if (!managed) {
                if (!status.file || typeof status.file.filename !== 'string') throw r.error('internal', 'ComfyUI returned no image');
                path = '/view?' + new URLSearchParams({ filename: status.file.filename, subfolder: status.file.subfolder ?? '', type: 'output' });
              }
              const { bytes } = await r.request(path, {}, signal);
              if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw r.error('internal', 'ComfyUI returned invalid PNG');
              return remember({ jobId: id, state: 'done', file: 'data:image/png;base64,' + bytes.toString('base64'), mimeType: 'image/png', error: null, progress: 1 });
            }
            await delay(r.num('pollMs', 500), undefined, { signal }).catch(() => r.checkAbort(signal));
          }
          throw r.error('timeout', 'ComfyUI generation timed out');
        } catch (err) {
          remember({ jobId: id, state: 'failed', file: null, mimeType: null, error: 'generation did not complete', progress: null });
          throw err;
        }
      }, opts?.signal);
    },
    async getJob(jobId) { return jobs.get(jobId) ?? { jobId, state: 'failed', file: null, mimeType: null, error: 'unknown job', progress: null }; },
    async unload() {
      await work.drain();
      if (pending === 'unknown') throw r.error('busy', 'submission result unknown; inspect ComfyUI before switching models');
      if (pending) {
        const id = pending;
        if (managed) await r.json(jobPath(id, '/cancel'), {});
        const deadline = Date.now() + r.num('cleanupTimeoutMs', 30_000);
        while (!(await poll(id)).done) {
          if (Date.now() > deadline) throw r.error('busy', 'ComfyUI has not stopped; next heavy engine is blocked');
          await delay(r.num('pollMs', 500));
        }
        pending = undefined;
      }
      const queue = await r.json('/queue');
      if (queue.queue_running?.length || queue.queue_pending?.length) throw r.error('busy', 'ComfyUI is occupied; cannot free shared models');
      await r.request('/free', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ unload_models: true, free_memory: true }) });
      // /free merely schedules work. MPS /system_stats reports SYSTEM RAM,
      // not process allocations. On macOS verify the listener's physical footprint.
      const deadline = Date.now() + r.num('cleanupTimeoutMs', 30_000);
      while (true) {
        let released: boolean;
        if (r.str('memoryProbe', 'torch-allocator') === 'macos-footprint') {
          const port = new URL(config.endpoint!).port;
          let sample;
          try { sample = JSON.parse(await r.command(r.str('memoryProbePython', 'python3'), [fileURLToPath(new URL('./memory_probe.py', import.meta.url)), port, r.str('lsof', '/usr/sbin/lsof')])); }
          catch { throw r.error('unavailable', 'cannot verify ComfyUI process footprint'); }
          if (!Number.isFinite(sample.footprintBytes) || sample.footprintBytes <= 0) throw r.error('unavailable', 'invalid ComfyUI process footprint');
          released = sample.footprintBytes <= r.num('unloadedFootprintBytes', 2147483648);
        } else {
          const devices = (await r.json('/system_stats')).devices;
          if (!Array.isArray(devices) || !devices.length || devices.some((d: any) => d.type === 'mps' || d.type === 'cpu' || !Number.isFinite(d.torch_vram_total) || !Number.isFinite(d.torch_vram_free))) throw r.error('unavailable', 'cannot verify allocator memory; configure macos-footprint on MPS');
          released = devices.every((d: any) => d.torch_vram_total - d.torch_vram_free <= r.num('unloadedTorchBytes', 268435456));
        }
        if (released) break;
        if (Date.now() >= deadline) throw r.error('busy', 'ComfyUI tensors remain loaded; next heavy engine is blocked');
        await delay(r.num('pollMs', 500));
      }
    },
  };
};
export const imageComfy: ProviderModule<'image'> = { modality: 'image', providerId: 'comfyui', create: createComfyImage };
