import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readEnvironment } from './env';
import { prepareEnvironment } from './prepare-env';

const env = await readEnvironment();
const origin = new URL(env.APP_ORIGIN || 'http://127.0.0.1:5173');
if (origin.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
  || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
  throw new Error('Local development requires an HTTP loopback APP_ORIGIN, including the registered callback port.');
}
await prepareEnvironment(env);
const child = spawn(process.execPath, [fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--host', origin.hostname === '[::1]' ? '::1' : origin.hostname, '--port', origin.port || '80', '--strictPort'], {
  stdio: 'inherit', shell: false,
  env: { ...process.env, WRANGLER_LOG_PATH: '.cache/wrangler', WRANGLER_SEND_METRICS: 'false' },
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
child.on('error', () => { process.stderr.write('The development server could not start.\n'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 0; });
