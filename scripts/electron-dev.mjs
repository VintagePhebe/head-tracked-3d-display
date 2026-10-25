// Starts the Vite dev server and launches Electron pointed at it.
import { spawn } from 'node:child_process';
import { createServer } from 'vite';

const server = await createServer();
await server.listen();
const address = server.resolvedUrls?.local[0] ?? 'http://localhost:5173';
console.log('[electron:dev] Vite server listening at', address);

const child = spawn(process.execPath, ['scripts/launch-electron.mjs'], {
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: address },
});

child.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
