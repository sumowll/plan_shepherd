import { chmod, writeFile } from 'node:fs/promises';
import { readEnvironment, RUNTIME_KEYS } from './env';
const env = await readEnvironment();
const keys = RUNTIME_KEYS.filter(key => !!env[key]);
if (!keys.length) throw new Error('Create .env from .env.example first.');
await writeFile('.dev.vars', keys.map(key => `${key}=${JSON.stringify(env[key])}`).join('\n') + '\n', { mode: 0o600 });
await chmod('.dev.vars', 0o600);
process.stdout.write(`Prepared .dev.vars with ${keys.length} settings. Values were not printed. This file is for local development only.\n`);
