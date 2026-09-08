import { readEnvironment } from './env';
import { runWrangler, withProductionConfig } from './deployment';
const env = await readEnvironment();
await withProductionConfig(env, async (config, _secrets, emptyEnv) => runWrangler(['d1', 'migrations', 'apply', 'plan-shepherd-catalog', '--remote', '--config', config, '--env-file', emptyEnv], env));
