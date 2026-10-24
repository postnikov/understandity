import { serve } from '@hono/node-server';
import { createDispatcher } from '@understandity/dispatcher';
import { createApp } from './app.js';
import { loadCourse, loadEnginesConfig } from './config.js';
import { EngineHub } from './engines.js';
import { PROVIDERS } from './providers.js';

// Loopback only: the demo runs offline and nothing should be reachable from the network.
const HOST = '127.0.0.1';
const PORT = Number(process.env.UNDERSTANDITY_PORT ?? 8787);

const hub = new EngineHub(loadEnginesConfig(), PROVIDERS, createDispatcher());
const app = createApp({ hub, course: loadCourse(), allowDrafts: process.env.UNDERSTANDITY_ALLOW_DRAFTS === '1' });

serve({ fetch: app.fetch, hostname: HOST, port: PORT }, (info) => {
  console.log(`understandity server on http://${HOST}:${info.port} · profile=${hub.getSettings().profile}`);
});
