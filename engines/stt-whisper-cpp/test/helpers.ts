import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProviderConfigSchema } from '@understandity/contracts';
import { pcmWav } from '../src/runtime.js';

export const config = (options: Record<string, unknown> = {}, fields: Record<string, unknown> = {}) => ProviderConfigSchema.parse({ locality: 'local', models: ['model'], voices: ['voice'], options, ...fields });
export const tone = (seconds = 0.1, amplitude = 1000) => {
  const pcm = Buffer.alloc(Math.round(seconds * 16000) * 2);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(Math.sin(i * 0.1) * amplitude), i * 2);
  return pcmWav(pcm, 16000);
};
export const clip = () => ({ model: 'model', audio: tone(), mimeType: 'audio/wav', language: 'auto' as const });
export const speech = () => ({ model: 'model', text: 'Density matters.', language: 'en', voice: 'voice' });
export function reply(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data));
}
export async function mockHttp(handler: (req: IncomingMessage, res: ServerResponse, body: Buffer) => unknown | Promise<unknown>) {
  const server = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(Buffer.from(part));
    try { await handler(req, res, Buffer.concat(parts)); } catch { res.writeHead(500).end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address() as { port: number };
  return { endpoint: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}
export async function executable(source: string) {
  const dir = await mkdtemp(join(tmpdir(), 'understandity-fixture-'));
  const path = join(dir, 'fake-cli');
  await writeFile(path, '#!/usr/bin/env python3\n' + source, { mode: 0o700 });
  return { dir, path, close: () => rm(dir, { recursive: true, force: true }) };
}
