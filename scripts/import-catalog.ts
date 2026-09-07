import { mkdtemp, rm, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { catalogStatements } from './catalog/sql';
import { readCanonicalFile,inspectBundle,bundleStatements } from './catalog/bundle';
import {readEnvironment} from './env';
import {importD1Statements} from './d1-query';

export async function importMain(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { file: { type: 'string' }, bundle:{type:'string'}, database: { type: 'string', default: 'plan-shepherd-catalog' },
    remote: { type: 'boolean',default: false }, 'validate-only': { type: 'boolean', default: false }, 'output-sql': { type: 'string' } }, strict: true });
  if (!!values.file===!!values.bundle) throw new Error('Usage: npm run catalog:import -- (--file public-catalog.json | --bundle partitions.json) [--validate-only | --output-sql file.sql] [--database name] [--remote]');
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(values.database!)) throw new Error('Invalid D1 database name');
  const catalog=values.file?await readCanonicalFile(resolve(values.file)):undefined;
  const bundle=values.bundle?await inspectBundle(resolve(values.bundle)):undefined;
  const releaseId=catalog?.release.id??bundle!.manifest.release.id;
  const planCount=catalog?.plans.length??bundle!.counts.plans,rateCount=catalog?.premiumRates.length??bundle!.counts.rates;
  // Production catalogs have explicit rights/provenance attestations; there is no demo/synthetic fallback path.
  process.stdout.write(`Validated public reference release ${releaseId}: ${planCount} plans, ${rateCount} profile-specific rates.\n`);
  if (values['validate-only']) return;
  const temporary = await mkdtemp(join(tmpdir(),'plan-shepherd-catalog-'));
  try {
    const sqlPath = values['output-sql'] ? resolve(values['output-sql']) : join(temporary,'catalog.sql');
    const out = await open(sqlPath,'wx',0o600);
    try { for await (const statement of catalog?catalogStatements(catalog):bundleStatements(bundle!)) {
      if (Buffer.byteLength(statement) > 95_000) throw new Error('Catalog row exceeds D1 SQL statement limit; split large public components.');
      await out.write(`${statement}\n`);
    } } finally { await out.close(); }
    if (values['output-sql']) { process.stdout.write(`Reviewable SQL written to ${sqlPath}. No database was changed.\n`); return; }
    if(values.remote){
      if(values.database!=='plan-shepherd-catalog')throw new Error('Remote import uses CATALOG_DATABASE_ID from the production environment; --database is only supported for local imports.');
      const env=await readEnvironment();
      await importD1Statements(env,catalog?catalogStatements(catalog):bundleStatements(bundle!));
    }else{
      const wrangler = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js',import.meta.url));
      const execution = spawnSync(process.execPath,[wrangler,'d1','execute',values.database!,'--local','--file',sqlPath,'--yes'], { stdio: 'inherit', shell: false });
      if (execution.error || execution.status !== 0) throw new Error('D1 import failed. The previous published catalog remains available; staging rows may require operator cleanup.');
    }
    process.stdout.write(`Published release ${releaseId}.\n`);
  } finally { await rm(temporary,{recursive: true,force: true}); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) importMain(process.argv.slice(2)).catch(error => {
  // Input errors can include public file details, but never print full input documents or environment variables.
  process.stderr.write(`${error instanceof Error ? error.message : 'Catalog import failed'}\n`); process.exitCode=1;
});
