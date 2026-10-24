import { defineConfig } from 'vite';

// Loopback only, no CDN: everything the page needs is bundled locally so the demo works offline.
export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: Number(process.env.UNDERSTANDITY_WEB_PORT ?? 5173),
    strictPort: true,
    // UNDERSTANDITY_WEB_HMR=0: no live reload. A synced working tree (Syncthing) must not reload the page under a user mid-demo.
    hmr: process.env.UNDERSTANDITY_WEB_HMR === '0' ? false : undefined,
    proxy: Object.fromEntries(['/api', '/media'].map((p) => [p, `http://127.0.0.1:${process.env.UNDERSTANDITY_PORT ?? 8787}`])),
  },
  preview: { host: '127.0.0.1' },
});
