import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { deploymentEnvironment, projectRoot, runWrangler, withDeploymentFiles } from './deployment';
import { readJsonConfig } from './deploy-settings';

export function runProjectCommand(args: string[], env: Record<string, string> = {}): void {
  const result = spawnSync(process.execPath, [join(projectRoot, args[0]), ...args.slice(1)], {
    cwd: projectRoot, env: deploymentEnvironment(env), stdio: 'inherit', shell: false,
  });
  if (result.error || result.status !== 0) throw new Error('Required build or test validation failed. Nothing was deployed.');
}

/** Compile from public source config, with no adjacent .dev.vars and no app secrets in child env. */
export async function buildApplication(test = false): Promise<void> {
  const schema = z.looseObject({
    main: z.string(), assets: z.looseObject({ directory: z.string() }),
    d1_databases: z.array(z.looseObject({ migrations_dir: z.string().optional() })).optional(),
  });
  const parsed = schema.safeParse(await readJsonConfig(join(projectRoot, 'wrangler.jsonc')));
  if (!parsed.success) throw new Error('The source build configuration is invalid.');
  const config = parsed.data;
  config.main = resolve(projectRoot, config.main);
  config.assets.directory = resolve(projectRoot, config.assets.directory);
  for (const binding of config.d1_databases ?? []) {
    if (binding.migrations_dir) binding.migrations_dir = resolve(projectRoot, binding.migrations_dir);
  }
  delete config.$schema;
  await withDeploymentFiles(config, {}, async (configPath, _secretsPath, emptyEnvPath) => {
    const env = { PLAN_SHEPHERD_BUILD_CONFIG: configPath };
    runWrangler(['types', join(projectRoot, 'worker-configuration.d.ts'), '--config', configPath, '--env-file', emptyEnvPath, '--include-runtime', 'false', '--strict-vars', 'false'], env);
    runProjectCommand(['node_modules/typescript/bin/tsc', '--noEmit'], env);
    if (test) runProjectCommand(['node_modules/vitest/vitest.mjs', 'run'], env);
    runProjectCommand(['node_modules/vite/bin/vite.js', 'build'], env);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildApplication().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : 'Application build failed.'}\n`); process.exitCode = 1; });
}
