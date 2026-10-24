import { serve } from '@hono/node-server';
import { createDispatcher } from '@understandity/dispatcher';
import { createApp } from './app.js';
import { REPO_ROOT, loadCourse, loadEnginesConfig, loadFeatures } from './config.js';
import { KeyStore } from './keys.js';
import { DialogLog } from './dialog-log.js';
import { resolve } from 'node:path';
import { EngineHub } from './engines.js';
import { PROVIDERS } from './providers.js';
import { warmup } from './warmup.js';

// Loopback only: the demo runs offline and nothing should be reachable from the network.
const HOST = '127.0.0.1';
const PORT = Number(process.env.UNDERSTANDITY_PORT ?? 8787);

// Keys first: saved keys are exported into this process before any engine is asked for one.
const keys = new KeyStore(process.env.UNDERSTANDITY_KEYS_FILE ?? resolve(REPO_ROOT, 'data/keys.local.json'));
const hub = new EngineHub(loadEnginesConfig(), PROVIDERS, createDispatcher(), (name) => keys.isSet(name));
const app = createApp({ hub, course: loadCourse(), allowDrafts: process.env.UNDERSTANDITY_ALLOW_DRAFTS === '1',
  keys,
  adultCheck: loadFeatures().adultCheck,
  dialogLog: new DialogLog(process.env.UNDERSTANDITY_LOG_DIR ?? resolve(REPO_ROOT, 'data/logs'), process.env.UNDERSTANDITY_DIALOG_LOG !== '0'),
});

serve({ fetch: app.fetch, hostname: HOST, port: PORT }, (info) => {
  console.log(`understandity server on http://${HOST}:${info.port} · profile=${hub.getSettings().profile}`);
  if (process.env.UNDERSTANDITY_WARMUP === '1') void warmup(hub);
});
