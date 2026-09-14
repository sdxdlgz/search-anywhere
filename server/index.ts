import express from 'express';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from './app.js';
import { adminCredential } from './security.js';

if (existsSync('.env')) process.loadEnvFile('.env');
process.umask(0o077);
const directory = resolve(process.env.SA_DATA_DIR || '.data');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const { app, close } = createApp({ directory, adminToken: adminCredential(directory), background: true });
if (process.argv.includes('--production')) {
  app.use(express.static(resolve('dist')));
  app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/index.html')));
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
}
const port = Number(process.env.SA_PORT || 8765), host = process.env.SA_HOST || '127.0.0.1';
const http = app.listen(port, host, () => {
  console.log(`Search Anywhere 已启动：http://${host}:${port}`);
  console.log(`管理员口令：${resolve(directory, 'admin-token.txt')}（或 SA_ADMIN_TOKEN）`);
});
function stop() { http.close(() => { close(); process.exit(0); }); }
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
