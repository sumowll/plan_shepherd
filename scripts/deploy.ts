import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { readEnvironment } from './env';
import { readinessSchema, verifyProduction } from './verify-production';
import { deploymentEnvironment, projectRoot, runWrangler, withProductionConfig } from './deployment';
import { queryD1 } from './d1-query';
import { catalogReadinessSql, verifyCatalogReadiness } from './catalog-readiness';

async function deploy() {
  const env = await readEnvironment();
  let record: unknown;
  try { record = JSON.parse(await readFile(env.PRODUCTION_READINESS_FILE ?? '', 'utf8')); } catch { record = null; }
  const failures = await verifyProduction(env, record);
  if (failures.length) throw new Error(`Production deployment is not ready:\n${failures.map(x => `- ${x}`).join('\n')}`);
  const readiness = readinessSchema.parse(record);
  verifyCatalogReadiness(await queryD1(env, catalogReadinessSql), readiness);
  for (const args of [['node_modules/typescript/bin/tsc', '--noEmit'], ['node_modules/vitest/vitest.mjs', 'run'], ['node_modules/vite/bin/vite.js', 'build']]) {
    const result = spawnSync(process.execPath, [join(projectRoot, args[0]), ...args.slice(1)], { cwd: projectRoot, env: deploymentEnvironment(env), stdio: 'inherit', shell: false });
    if (result.error || result.status !== 0) throw new Error('Required release validation failed. Nothing was deployed.');
  }
  await withProductionConfig(env, async (configPath, secretsPath) => {
    runWrangler(['deploy', '--config', configPath, '--secrets-file', secretsPath, ...(process.argv.includes('--dry-run') ? ['--dry-run'] : [])], env);
  }, { built: true, approvedReleaseId: readiness.catalogReleaseId });
}
deploy().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : 'Release validation or deployment failed.'}\n`); process.exitCode = 1; });
