import { constants } from 'node:fs';
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { z } from 'zod';
import { connectorEnvironmentKeys, validateConnectorRegistry, withConnectorRegistry } from '../src/server/connector-registry';
import { connectorConfig, connectorRedirectUri, safeHttpsUrl } from '../src/server/config';
import { AppError } from '../src/server/http';
import { readEnvironment } from './env';
import { readDeploymentSettings } from './deploy-settings';
import { connectorCredentialPath, loadConnectorCredentials, parseConnectorCredentials, saveConnectorCredentials,
  selectConnectorCredentials, upsertConnectorCredential, type ConnectorCredentials, type ConnectorCredentialFiles, type ConnectorTarget } from './connector-credentials';

const registryPath = fileURLToPath(new URL('../config/connectors.json', import.meta.url));
const targets: ConnectorTarget[] = ['development', 'preview', 'production'];
const rawRegistrySchema = z.array(z.record(z.string(), z.unknown()));
type RawConnection = z.infer<typeof rawRegistrySchema>[number];
class ConnectorSetupError extends Error {}
export type ConnectionPrompt = {
  ask(label: string, defaultValue?: string): Promise<string>;
  secret(label: string): Promise<string>;
  print(message: string): void;
};

function registryInput(input: unknown): RawConnection[] {
  validateConnectorRegistry(input);
  return rawRegistrySchema.parse(input);
}

async function readRegistry(path = registryPath): Promise<RawConnection[]> {
  let input: unknown;
  try { input = JSON.parse(await readFile(path, 'utf8')); }
  catch { throw new ConnectorSetupError('Cannot read connectors.json. Check its path and JSON syntax.'); }
  return registryInput(input);
}

/** Collect all manual input through one interface; never print credential values. */
export async function setupConnection(input: {
  registry: unknown[]; credentials: ConnectorCredentials; identifier?: string; targets: ConnectorTarget[];
}, prompt: ConnectionPrompt): Promise<{ registry: unknown[]; credentials: ConnectorCredentials; connectionId: string }> {
  const registry = registryInput(input.registry);
  let credentials = parseConnectorCredentials(input.credentials);
  if (!input.targets.length || new Set(input.targets).size !== input.targets.length || input.targets.some(target => !targets.includes(target))) {
    throw new ConnectorSetupError('Choose development, preview, production, or a comma-separated combination.');
  }
  const compiled = validateConnectorRegistry(registry);
  const existingIndex = input.identifier ? compiled.findIndex(entry => entry.id === input.identifier?.toLowerCase() || entry.key === input.identifier) : -1;
  const existing = compiled[existingIndex];
  if (input.identifier && !existing) throw new ConnectorSetupError('That connection is not registered. Use list to find its key or UUID.');
  const original = registry[existingIndex];
  const entry: RawConnection = original && existing ? { ...original, id: existing.id } : { id: randomUUID() };
  const ask = async (label: string, fallback = '') => {
    const value = (await prompt.ask(label, fallback)).trim();
    return value === '-' ? '' : value || fallback;
  };
  entry.organizationId = await ask('Organization ID', existing?.organizationId);
  entry.name = await ask('Display name', existing?.name);
  entry.kind = await ask('Organization role: provider or payer', existing?.kind ?? 'provider');
  entry.apiType = await ask('API type: patient_access, payer_to_payer, or provider_directory', existing?.apiType ?? 'patient_access');
  if (existing && (entry.organizationId !== existing.organizationId || entry.apiType !== existing.apiType)) {
    throw new ConnectorSetupError('Use add for a different organization or API so it receives its own connection UUID.');
  }
  const derivedKey = `${entry.organizationId}-${String(entry.apiType).replaceAll('_', '-')}`;
  if (existing?.key !== undefined && original?.key !== undefined || compiled.some(other => other.id !== entry.id && other.key === derivedKey)) {
    entry.key = await ask('Unique routing key', existing?.key ?? derivedKey);
  } else delete entry.key;
  entry.fhirBaseUrl = await ask('FHIR base URL', existing?.fhirBaseUrl);
  safeHttpsUrl(String(entry.fhirBaseUrl));
  entry.scopes = await ask('Approved scopes, separated by spaces', existing?.scopes ?? (entry.apiType === 'patient_access' ? 'launch/patient patient/*.read' : ''));
  entry.grantedScopeFormat = await ask('Returned scope format: smart, resource_operations, or read_search', existing?.grantedScopeFormat ?? 'smart');
  entry.tokenAuthMethod = await ask('Token authentication: none, client_secret_basic, or client_secret_post', existing?.tokenAuthMethod ?? (existing?.clientSecretEnv ? existing.clientSecretAuthMethod : 'none'));
  delete entry.clientSecretAuthMethod;
  const endpoints = await ask('Authorization endpoints: discover or manual', existing?.authorizationUrl ? 'manual' : 'discover');
  if (!['discover', 'manual'].includes(endpoints)) throw new ConnectorSetupError('Choose discover or manual for authorization endpoints.');
  if (endpoints === 'manual') {
    entry.authorizationUrl = await ask('Authorization URL', existing?.authorizationUrl);
    entry.tokenUrl = await ask('Token URL', existing?.tokenUrl);
  } else { delete entry.authorizationUrl; delete entry.tokenUrl; }
  entry.responseMode = await ask('Callback response mode: query or form_post', existing?.responseMode ?? 'query');
  const enabled = await ask('Enable this connection: true or false', existing ? String(existing.enabled) : 'false');
  if (!['true', 'false'].includes(enabled)) throw new ConnectorSetupError('Enabled must be true or false.');
  entry.enabled = enabled === 'true';
  const advanced = await ask('Configure callback, resource selection, or test-data settings: yes or no', 'no');
  if (!['yes', 'no'].includes(advanced)) throw new ConnectorSetupError('Choose yes or no for additional connection settings.');
  if (advanced === 'yes') {
    const key = await ask('Routing key override (- for automatic)', typeof entry.key === 'string' ? entry.key : '-');
    if (key && key !== '-') entry.key = key; else delete entry.key;
    const callback = await ask('Callback path or exact URL (- for automatic)', existing?.callbackPath ?? existing?.redirectUri ?? '-');
    delete entry.callbackPath;
    delete entry.redirectUri;
    if (callback && callback !== '-') {
      if (callback.startsWith('/')) entry.callbackPath = callback; else entry.redirectUri = callback;
      if (callback === '/auth/callback') entry.legacyCallbackPath = callback;
    }
    const resourceList = await ask('Import resources, comma separated (- for defaults)', existing?.resources?.join(',') ?? '-');
    if (resourceList && resourceList !== '-') entry.resources = resourceList.split(',').map(value => value.trim()); else delete entry.resources;
    const testEnvironment = await ask('This connection uses test data: true or false', String(existing?.testEnvironment ?? false));
    if (!['true', 'false'].includes(testEnvironment)) throw new ConnectorSetupError('Test-data setting must be true or false.');
    entry.testEnvironment = testEnvironment === 'true';
    const testBases = await ask('Known test FHIR URLs, comma separated (- for none)', existing?.testFhirBaseUrls.join(',') || '-');
    entry.testFhirBaseUrls = testBases && testBases !== '-' ? testBases.split(',').map(value => value.trim()) : [];
    for (const url of entry.testFhirBaseUrls as string[]) safeHttpsUrl(url);
  }

  const defaultBinding = `${entry.organizationId}_${entry.apiType}_CLIENT_ID`.replaceAll('-', '_').toUpperCase();
  const binding = await ask('Client ID binding (use an existing binding to share an app registration)', existing?.clientIdEnv ?? defaultBinding);
  const shared = compiled.filter(other => other.id !== entry.id && other.clientIdEnv === binding);
  if (shared.length) prompt.print(`This client ID is shared with ${shared.map(other => other.name).join(', ')}. A new value updates their selected targets too.`);
  if (binding === defaultBinding) delete entry.clientIdEnv; else entry.clientIdEnv = binding;
  const clientId = await prompt.secret('Client ID (hidden; leave blank to keep saved target values)');
  const literalClientId = typeof entry.clientId === 'string' && entry.clientId.trim() ? entry.clientId : undefined;
  if (literalClientId && input.targets.length < targets.length) {
    if (clientId || binding !== defaultBinding) throw new ConnectorSetupError('This client ID is stored in connection metadata for every target. Select all targets to move it into separate dotenv files.');
    delete entry.clientIdEnv;
  } else {
    // Moving a global literal requires all targets so the other deployments retain their registration.
    if (literalClientId) {
      if (shared.length) throw new ConnectorSetupError('Choose a separate client ID binding before moving a literal into the target dotenv files.');
      credentials = upsertConnectorCredential(credentials, binding, targets, literalClientId);
    }
    delete entry.clientId;
    if (clientId) credentials = upsertConnectorCredential(credentials, binding, input.targets, clientId);
  }
  if (entry.tokenAuthMethod !== 'none') {
    const secretBinding = await ask('Client secret binding', existing?.clientSecretEnv ?? (binding.endsWith('_CLIENT_ID') ? binding.replace(/_CLIENT_ID$/, '_CLIENT_SECRET') : `${binding}_CLIENT_SECRET`));
    entry.clientSecretEnv = secretBinding;
    const sharedSecrets = compiled.filter(other => other.id !== entry.id && other.clientSecretEnv === secretBinding);
    if (sharedSecrets.length) prompt.print(`This secret is shared with ${sharedSecrets.map(other => other.name).join(', ')}. A new value updates their selected targets too.`);
    const secret = await prompt.secret('Client secret (hidden; leave blank to keep saved target values)');
    if (secret) credentials = upsertConnectorCredential(credentials, secretBinding, input.targets, secret);
  } else delete entry.clientSecretEnv;
  const updated = existing ? registry.map((other, index) => index === existingIndex ? entry : other) : [...registry, entry];
  const validated = withConnectorRegistry({}, updated);
  const callbackOrigin = typeof entry.redirectUri === 'string' ? new URL(entry.redirectUri).origin : 'https://app.example.com';
  connectorRedirectUri({ ...validated, APP_ORIGIN: callbackOrigin }, String(entry.id), callbackOrigin);
  // Validate the effective configuration without sign-in, external calls, or credentials in errors.
  for (const target of input.targets) {
    const keys = connectorEnvironmentKeys(validated).runtimeKeys;
    connectorConfig({ ...validated, ...selectConnectorCredentials(credentials, target, keys) }, String(entry.id));
  }
  return { registry: updated, credentials, connectionId: String(entry.id) };
}

/** Validate both stores before writing; restore credentials if the manifest write fails. */
export async function saveConnectorSetup(input: {
  registryPath?: string; credentialFiles?: ConnectorCredentialFiles; targets?: ConnectorTarget[];
  expectedRegistry: unknown[]; registry: unknown[];
  expectedCredentials: ConnectorCredentials; credentials: ConnectorCredentials;
}): Promise<void> {
  const destination = input.registryPath ?? registryPath;
  const registry = registryInput(input.registry);
  registryInput(input.expectedRegistry);
  const credentials = parseConnectorCredentials(input.credentials);
  const expectedCredentials = parseConnectorCredentials(input.expectedCredentials);
  const state = await lstat(destination);
  if (!state.isFile() || state.isSymbolicLink()) throw new ConnectorSetupError('The connector registry must be a regular file.');
  const current = await readRegistry(destination);
  if (JSON.stringify(current) !== JSON.stringify(input.expectedRegistry)) throw new ConnectorSetupError('The connector registry changed. Reload before saving.');
  const temporary = join(dirname(destination), `.connectors-${randomUUID()}.tmp`);
  let restoreCredentials: (() => Promise<void>) | undefined;
  let savedRegistry = false;
  try {
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await file.writeFile(`${JSON.stringify(registry, null, 2)}\n`);
      await file.sync();
    } finally { await file.close(); }
    const allowedBindings = [...new Set([
      ...connectorEnvironmentKeys(withConnectorRegistry({}, input.expectedRegistry)).runtimeKeys,
      ...connectorEnvironmentKeys(withConnectorRegistry({}, registry)).runtimeKeys,
    ])];
    restoreCredentials = await saveConnectorCredentials(credentials, input.credentialFiles, { expected: expectedCredentials, allowedBindings, targets: input.targets });
    const latest = await lstat(destination);
    if (latest.ino !== state.ino || latest.dev !== state.dev || latest.mtimeMs !== state.mtimeMs || latest.ctimeMs !== state.ctimeMs) {
      throw new ConnectorSetupError('The connector registry changed during setup. Reload before saving.');
    }
    await rename(temporary, destination);
    savedRegistry = true;
  } catch {
    if (restoreCredentials && !savedRegistry) {
      try { await restoreCredentials(); }
      catch { throw new ConnectorSetupError('Setup could not finish and credentials changed concurrently. Review saved connection settings before retrying.'); }
    }
    throw new ConnectorSetupError('Setup could not save both connection settings and credentials. Reload before retrying.');
  } finally { await unlink(temporary).catch(() => undefined); }
}

export async function listConnections(selectedTargets: ConnectorTarget[] = targets, secretsFile?: string): Promise<void> {
  const registry = await readRegistry();
  for (const target of selectedTargets) {
    let env: Record<string, unknown>;
    if (target === 'development') env = await readEnvironment(connectorCredentialPath(target), { registry, target, secretsFile });
    else env = (await readDeploymentSettings({ target, secretsFile }, process.env, registry)).env;
    process.stdout.write(`\n${target}\n`);
    for (const definition of validateConnectorRegistry(registry)) {
      const config = connectorConfig(env, definition.id);
      const callback = connectorRedirectUri(env, definition.id, 'http://127.0.0.1:5173');
      process.stdout.write(`${config.name} (${config.key})\n  UUID: ${config.id}\n  API: ${config.apiType}\n  FHIR: ${config.base}\n  Scopes: ${config.scopes}\n  Token authentication: ${config.tokenAuthMethod}\n  Client ID: ${config.clientId ? 'saved' : 'missing'}; secret: ${config.tokenAuthMethod === 'none' ? 'not required' : config.clientSecret ? 'saved' : 'missing'}\n  Callback: ${callback}\n  Status: ${config.enabled ? 'ready for sign-in testing' : config.unavailableReason}\n`);
    }
  }
  process.stdout.write('\nCredential values are hidden. Saved settings do not establish that an external registration or import has been tested.\n');
}

function terminalPrompt(): ConnectionPrompt & { close(): void } {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new ConnectorSetupError('Run connection setup in an interactive terminal.');
  let hidden = false;
  const output = new Writable({ write(chunk, _encoding, done) { if (!hidden) process.stdout.write(chunk); done(); } });
  const reader = createInterface({ input: process.stdin, output, terminal: true, historySize: 0 });
  return {
    ask: (label, fallback) => reader.question(`${label}${fallback ? ` [${fallback}]` : ''}: `),
    secret: async label => {
      process.stdout.write(`${label}: `);
      hidden = true;
      try { return await reader.question(''); }
      finally { hidden = false; process.stdout.write('\n'); }
    },
    print: message => process.stdout.write(`${message}\n`),
    close: () => reader.close(),
  };
}

export async function connectorsCommand(args: string[]): Promise<void> {
  const [command = 'list', ...remaining] = args;
  if (command === '--help' || command === 'help' || remaining.includes('--help')) {
    process.stdout.write('Usage: npm run connectors -- list [--target development|preview|production]\n       npm run connectors -- add\n       npm run connectors -- edit <key-or-uuid>\nOptional: --target development|preview|production; --secrets-file <dotenv-file> requires --target.\nSetup preserves existing settings and saves credentials in .env for development or .env.secrets.<target> for deployment.\n');
    return;
  }
  if (!['list', 'add', 'edit'].includes(command)) throw new ConnectorSetupError('Choose list, add, or edit.');
  let identifier: string | undefined;
  let target: ConnectorTarget | undefined;
  let secretsFile: string | undefined;
  const seen = new Set<string>();
  for (let index = 0; index < remaining.length; index++) {
    const arg = remaining[index];
    if (arg === '--target' || arg === '--secrets-file') {
      if (seen.has(arg)) throw new ConnectorSetupError('Options cannot be repeated.');
      seen.add(arg);
      const value = remaining[++index];
      if (!value || value.startsWith('--')) throw new ConnectorSetupError('The option requires a value.');
      if (arg === '--target') {
        if (!targets.includes(value as ConnectorTarget)) throw new ConnectorSetupError('Unknown connection target.');
        target = value as ConnectorTarget;
      } else secretsFile = value;
    } else if (command === 'edit' && !identifier && !arg.startsWith('--')) identifier = arg;
    else throw new ConnectorSetupError('Unexpected setup argument. Use --help.');
  }
  if (secretsFile && !target) throw new ConnectorSetupError('--secrets-file requires --target so credentials remain scoped to one environment.');
  if (command === 'list') { await listConnections(target ? [target] : targets, secretsFile); return; }
  if (command === 'edit' && !identifier) throw new ConnectorSetupError('Edit requires a connection key or UUID.');
  const registry = await readRegistry();
  const credentialFiles = secretsFile && target ? { [target]: secretsFile } : undefined;
  const prompt = terminalPrompt();
  let selected: ConnectorTarget[] = [];
  try {
    prompt.print('Connection metadata applies to this data source in every deployment. Credential values can differ by target. Leave a credential blank to keep its saved values.');
    selected = target ? [target] : (await prompt.ask('Credential targets, comma separated', 'development') || 'development').split(',').map(value => value.trim()) as ConnectorTarget[];
    const credentials = await loadConnectorCredentials(credentialFiles, connectorEnvironmentKeys(withConnectorRegistry({}, registry)).runtimeKeys, selected);
    const updated = await setupConnection({ registry, credentials, identifier, targets: selected }, prompt);
    await saveConnectorSetup({ registry: updated.registry, credentials: updated.credentials, expectedRegistry: registry, expectedCredentials: credentials, credentialFiles, targets: selected });
    prompt.print(`Saved connection ${updated.connectionId}. Register the callback shown by list, then restart development or deploy and test sign-in.`);
  } finally { prompt.close(); }
  try { await listConnections(selected, secretsFile); }
  catch {
    process.stderr.write('The connection was saved, but its status could not be listed. Check the selected target dotenv file and run npm run connectors -- list.\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  connectorsCommand(process.argv.slice(2)).catch((error: unknown) => {
    const safeMessage = error instanceof ConnectorSetupError || error instanceof AppError ? error.message
      : error instanceof Error && /^(?:Connector credentials|Invalid connector credential|The specified connector credentials|Connection settings and credentials)/.test(error.message) ? error.message
        : 'Connection setup did not complete. Check the registry and private target dotenv files. No credential values were printed.';
    process.stderr.write(`${safeMessage}\n`);
    process.exitCode = 1;
  });
}
