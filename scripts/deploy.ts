import { readFile, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { readinessSchema, verifyProduction } from './verify-production';
import { runWrangler, withDeploymentFiles } from './deployment';
import { loadDeploymentSettings, parseDeploymentOptions } from './deploy-settings';
import { buildApplication, runProjectCommand } from './build';
import { queryD1 } from './d1-query';
import { catalogReadinessSql, verifyCatalogReadiness } from './catalog-readiness';

export async function deploy(args: string[]): Promise<void> {
  const options = parseDeploymentOptions(args);
  const { config, secrets, env } = await loadDeploymentSettings(options);
  if (options.target === 'production') {
    let record: unknown;
    try { record = JSON.parse(await readFile(env.PRODUCTION_READINESS_FILE ?? '', 'utf8')); } catch { record = null; }
    const failures = await verifyProduction(env, record);
    if (failures.length) throw new Error(`Production deployment is not ready:\n${failures.map(x => `- ${x}`).join('\n')}`);
    const readiness = readinessSchema.parse(record);
    verifyCatalogReadiness(await queryD1(env, catalogReadinessSql), readiness);
    config.vars.PRODUCTION_RELEASE_APPROVED = 'true';
    config.vars.PRODUCTION_CATALOG_RELEASE_ID = readiness.catalogReleaseId;
  }
  if (options.skipBuild) runProjectCommand(['node_modules/vitest/vitest.mjs', 'run']);
  else await buildApplication(true);
  try {
    if (!(await stat(config.main)).isFile() || !(await stat(config.assets.directory)).isDirectory()) throw new Error();
  } catch { throw new Error('Compiled Worker or client assets are missing. Run npm run build before using --skip-build.'); }
  config.observability = { enabled: false, logs: { enabled: false }, traces: { enabled: false } };
  config.logpush = false;
  config.preview_urls = false;
  process.stdout.write(`${options.dryRun ? 'Validating' : options.uploadOnly ? 'Uploading' : 'Deploying'} ${options.target}: ${config.name}\nVariables: ${Object.keys(config.vars).sort().join(', ')}\nSecrets supplied: ${Object.keys(secrets).sort().join(', ') || '(none; existing remote secrets are preserved)'}\n`);
  await withDeploymentFiles(config, secrets, async (configPath, secretsPath, emptyEnvPath) => {
    runWrangler([
      ...(options.uploadOnly ? ['versions', 'upload'] : ['deploy']),
      '--config', configPath, '--env-file', emptyEnvPath, '--secrets-file', secretsPath,
      ...(options.dryRun ? ['--dry-run'] : []),
    ], env.CLOUDFLARE_API_TOKEN ? { CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN } : {});
  });
  process.stdout.write(options.dryRun ? 'Dry run passed. Nothing was uploaded or deployed.\n'
    : options.uploadOnly ? 'Worker version uploaded; the active deployment was not changed.\n'
      : `Deployment complete: ${config.vars.APP_ORIGIN}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--help')) {
    process.stdout.write('Usage: npm run deploy -- [--target preview|production] [--config path.jsonc] [--secrets-file path] [--dry-run]\nPreview also supports --upload-only and --skip-build (tests still run).\nCredentials come from .env.secrets.<target> or CI; public application settings come from Wrangler.\n');
  } else {
    deploy(process.argv.slice(2)).catch(error => { process.stderr.write(`${error instanceof Error ? error.message : 'Deployment validation failed.'}\n`); process.exitCode = 1; });
  }
}
