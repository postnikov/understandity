import { afterEach, expect, it, vi } from 'vitest';
import { createComfyImage } from '../src/index.js';
import { config, executable, mockHttp, reply } from '../../stt-whisper-cpp/test/helpers.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(cleanup.splice(0).map(f => f())); });
const input = { model: 'model', topic: 'A cube floating in water', style: 'fantasy', width: 1024, height: 1024 };
const healthy = { ready: true, busy: false, paused: false, memory_ok: true };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5q0AAAAASUVORK5CYII=', 'base64');
function cfg(endpoint: string, options = {}, fields = {}) {
  return config({ ollamaEndpoint: endpoint, pollMs: 1, cleanupTimeoutMs: 100, presets: { square: [1024, 1024] }, ...options }, { endpoint, ...fields });
}
it('keeps its heavy slot through completion, downloads PNG and verifies free memory', async () => {
  const paths: string[] = []; let id = '', polls = 0, stats = 0, submission: any, leakedToken = false;
  vi.stubEnv('UNDERSTANDITY_TEST_KEY', 'synthetic-fixture');
  const s = await mockHttp((req, res, body) => {
    paths.push(req.url!);
    if (req.url === '/api/ps') { leakedToken = !!req.headers.authorization; reply(res, { models: [] }); }
    else if (req.url === '/queue') reply(res, { queue_running: [], queue_pending: [] });
    else if (req.url === '/overcortex/v1/health') reply(res, healthy);
    else if (req.url === '/overcortex/v1/jobs') { submission = JSON.parse(body.toString()); id = submission.id; reply(res, { id, status: 'accepted' }); }
    else if (req.url?.includes('/image?')) res.writeHead(200).end(png);
    else if (req.url === '/free') res.writeHead(200).end();
    else if (req.url === '/system_stats') reply(res, { devices: [{ torch_vram_total: ++stats === 1 ? 10_000_000_000 : 0, torch_vram_free: 0 }] });
    else reply(res, { id, status: ++polls === 1 ? 'accepted' : 'completed' });
  }); cleanup.push(s.close);
  const a = createComfyImage(cfg(s.endpoint, {}, { secretEnv: 'UNDERSTANDITY_TEST_KEY' }), { providerId: 'comfyui' });
  const job = await a.generate(input);
  expect(job).toMatchObject({ state: 'done', mimeType: 'image/png', progress: 1 });
  expect(job.file?.startsWith('data:image/png;base64,')).toBe(true);
  expect(await a.getJob(job.jobId)).toEqual(job);
  expect(submission).toMatchObject({ preset: 'square', seed: 0, day_limit: 20, month_limit: 100 });
  expect(submission.tenant).toMatch(/^[a-f0-9]{64}$/); expect(leakedToken).toBe(false);
  expect(paths.indexOf('/overcortex/v1/jobs')).toBeGreaterThan(paths.indexOf('/api/ps'));
  await a.unload!('model'); expect(stats).toBe(2); expect(a.heavy).toBe(true);
});
it.each(['ollama', 'memory', 'paused', 'queue'])('does not submit when %s guard refuses', async reason => {
  let submissions = 0;
  const s = await mockHttp((req, r) => {
    if (req.url === '/api/ps') reply(r, { models: reason === 'ollama' ? [{ name: 'someone-elses-model' }] : [] });
    else if (req.url === '/queue') reply(r, { queue_running: reason === 'queue' ? [[1]] : [], queue_pending: [] });
    else if (req.url === '/overcortex/v1/health') reply(r, { ...healthy, memory_ok: reason !== 'memory', paused: reason === 'paused' });
    else { submissions++; reply(r, {}); }
  }); cleanup.push(s.close);
  const a = createComfyImage(cfg(s.endpoint), { providerId: 'comfyui' });
  await expect(a.generate(input)).rejects.toMatchObject({ code: 'busy' }); expect(submissions).toBe(0);
});
it('cancels only its own managed job and waits for terminal status before freeing', async () => {
  const paths: string[] = []; let id = '', cancelled = false;
  const controller = new AbortController();
  const s = await mockHttp((req, r, body) => {
    paths.push(req.url!);
    if (req.url === '/api/ps') reply(r, { models: [] });
    else if (req.url === '/overcortex/v1/health') reply(r, healthy);
    else if (req.url === '/queue') reply(r, { queue_running: [], queue_pending: [] });
    else if (req.url === '/overcortex/v1/jobs') { id = JSON.parse(body.toString()).id; reply(r, { id }); }
    else if (req.url?.includes('/cancel?')) { cancelled = true; reply(r, { id, status: 'cancelled' }); }
    else if (req.url === '/free') r.writeHead(200).end();
    else if (req.url === '/system_stats') reply(r, { devices: [{ torch_vram_total: 0, torch_vram_free: 0 }] });
    else { reply(r, { id, status: cancelled ? 'cancelled' : 'accepted' }); if (!cancelled) controller.abort(); }
  }); cleanup.push(s.close);
  const a = createComfyImage(cfg(s.endpoint), { providerId: 'comfyui' });
  await expect(a.generate(input, { signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' });
  await a.unload!('model');
  expect(paths.some(p => p.startsWith(`/overcortex/v1/jobs/${id}/cancel?`))).toBe(true);
  expect(paths.includes('/interrupt')).toBe(false);
});
it('fails unload closed when memory release cannot be verified', async () => {
  const s = await mockHttp((req, r) => req.url === '/free' ? r.writeHead(200).end() : reply(r, req.url === '/queue' ? { queue_running: [], queue_pending: [] } : {})); cleanup.push(s.close);
  const a = createComfyImage(cfg(s.endpoint), { providerId: 'comfyui' });
  await expect(a.unload!('model')).rejects.toMatchObject({ code: 'unavailable' });
});
it('supports the stock offline ComfyUI protocol without an auth token', async () => {
  let workflow: any;
  const s = await mockHttp((req, r, body) => {
    if (req.url === '/api/ps') reply(r, { models: [] });
    else if (req.url === '/system_stats') reply(r, { devices: [{ torch_vram_total: 0, torch_vram_free: 0 }] });
    else if (req.url === '/queue') reply(r, { queue_running: [], queue_pending: [] });
    else if (req.url === '/prompt') { workflow = JSON.parse(body.toString()).prompt; reply(r, { prompt_id: 'local-job' }); }
    else if (req.url === '/history/local-job') reply(r, { 'local-job': { status: { completed: true }, outputs: { '10': { images: [{ filename: 'cube.png', subfolder: 'understandity' }] } } } });
    else if (req.url?.startsWith('/view?')) r.writeHead(200).end(png);
    else r.writeHead(200).end();
  }); cleanup.push(s.close);
  const a = createComfyImage(cfg(s.endpoint, { apiMode: 'native', modelFile: 'z_image_turbo_bf16.safetensors', textEncoder: 'qwen_3_4b.safetensors', vae: 'ae.safetensors' }), { providerId: 'comfyui' });
  expect((await a.generate(input)).state).toBe('done');
  expect(workflow['1'].inputs.unet_name).toBe('z_image_turbo_bf16.safetensors');
  expect(workflow['5'].class_type).toBe('ConditioningZeroOut');
  await a.unload!('model');
});

it('uses a process footprint probe on macOS rather than treating system RAM as model memory', async () => {
  const probe = await executable('print(\'{"pid":1,"footprintBytes":1000000000}\')\n'); cleanup.push(probe.close);
  const s = await mockHttp((req, r) => req.url === '/free' ? r.writeHead(200).end() : reply(r, req.url === '/queue' ? { queue_running: [], queue_pending: [] } : { devices: [{ type: 'mps', torch_vram_total: 64000000000, torch_vram_free: 32000000000 }] })); cleanup.push(s.close);
  const a = createComfyImage(cfg(s.endpoint, { memoryProbe: 'macos-footprint', memoryProbePython: probe.path }), { providerId: 'comfyui' });
  await a.unload!('model');
  const wrong = createComfyImage(cfg(s.endpoint), { providerId: 'comfyui' });
  await expect(wrong.unload!('model')).rejects.toMatchObject({ code: 'unavailable' });
});
