import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConnectorCredentials, parseConnectorCredentials, saveConnectorCredentials, upsertConnectorCredential } from '../../scripts/connector-credentials';
import { connectorsCommand, saveConnectorSetup, setupConnection } from '../../scripts/connectors';
import { withConnectorRegistry } from '../../src/server/connector-registry';
import { connectorConfig, connectorRedirectUri } from '../../src/server/config';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const directories: string[] = [];
const connection = {
  id: '7c3e95c0-a9db-4ec9-b9b4-157a0615e87d', organizationId: 'sample-health', name: 'Sample Health',
  kind: 'provider', apiType: 'patient_access', fhirBaseUrl: 'https://sample.example/fhir',
  scopes: 'launch/patient patient/*.read', tokenAuthMethod: 'none',
};
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'plan-shepherd-setup-'));
  directories.push(directory);
  const registryPath = join(directory, 'connectors.json');
  const credentialFiles = { development: join(directory, '.env'), preview: join(directory, '.env.secrets.preview'), production: join(directory, '.env.secrets.production') };
  const expectedRegistry = [connection];
  const expectedCredentials = parseConnectorCredentials({ SAMPLE_HEALTH_PATIENT_ACCESS_CLIENT_ID: [{ targets: ['preview'], value: 'original-client' }] });
  await writeFile(registryPath, JSON.stringify(expectedRegistry, null, 2));
  await saveConnectorCredentials(expectedCredentials, credentialFiles);
  const registry = [{ ...connection, name: 'Renamed Health' }];
  const credentials = upsertConnectorCredential(expectedCredentials, 'SAMPLE_HEALTH_PATIENT_ACCESS_CLIENT_ID', ['preview'], 'updated-client');
  return { directory, registryPath, credentialFiles, expectedRegistry, expectedCredentials, registry, credentials };
}
afterEach(async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(rename).mockImplementation(actual.rename);
  vi.mocked(rename).mockClear();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('connector setup transaction', () => {
  it('saves the reviewed manifest and private credentials together', async () => {
    const data = await fixture();
    await saveConnectorSetup(data);
    expect(JSON.parse(await readFile(data.registryPath, 'utf8'))).toEqual(data.registry);
    expect(await loadConnectorCredentials(data.credentialFiles)).toEqual(data.credentials);
    expect((await stat(data.credentialFiles.preview)).mode & 0o777).toBe(0o600);
    expect((await readdir(data.directory)).sort()).toEqual(['.env.secrets.preview', 'connectors.json']);
  });

  it('preserves application settings and comments while saving connection changes', async () => {
    const data = await fixture();
    const original = '# Preview registration\nSESSION_SIGNING_KEY=synthetic-app-secret\nSAMPLE_HEALTH_PATIENT_ACCESS_CLIENT_ID=original-client\nRETIRED_PRIVATE_KEY=retired-secret\n';
    await writeFile(data.credentialFiles.preview, original, { mode: 0o600 });
    await saveConnectorSetup(data);
    expect(await readFile(data.credentialFiles.preview, 'utf8')).toBe(original.replace('SAMPLE_HEALTH_PATIENT_ACCESS_CLIENT_ID=original-client', 'SAMPLE_HEALTH_PATIENT_ACCESS_CLIENT_ID="updated-client"'));
  });

  it('requires an explicit target for a custom dotenv file before reading any credentials', async () => {
    await expect(connectorsCommand(['list', '--secrets-file', '/unused/custom.env'])).rejects.toThrow('--secrets-file requires --target');
  });

  it('rejects an explicitly selected missing development dotenv file', async () => {
    const data = await fixture();
    await expect(connectorsCommand(['list', '--target', 'development', '--secrets-file', join(data.directory, 'missing.env')])).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('validates the manifest before either file is changed', async () => {
    const data = await fixture();
    await expect(saveConnectorSetup({ ...data, registry: [{ ...connection, clientSecret: 'synthetic-secret' }] })).rejects.toThrow();
    expect(JSON.parse(await readFile(data.registryPath, 'utf8'))).toEqual(data.expectedRegistry);
    expect(await loadConnectorCredentials(data.credentialFiles)).toEqual(data.expectedCredentials);
  });

  it('validates credentials before either file is changed', async () => {
    const data = await fixture();
    await expect(saveConnectorSetup({ ...data, credentials: { CLIENT_ID: [{ targets: ['preview'], value: '' }] } })).rejects.toThrow();
    expect(JSON.parse(await readFile(data.registryPath, 'utf8'))).toEqual(data.expectedRegistry);
    expect(await loadConnectorCredentials(data.credentialFiles)).toEqual(data.expectedCredentials);
  });

  it('rejects an externally edited manifest without losing the edit or updating credentials', async () => {
    const data = await fixture();
    const concurrent = [{ ...connection, name: 'Concurrent change' }];
    await writeFile(data.registryPath, JSON.stringify(concurrent));
    await expect(saveConnectorSetup(data)).rejects.toThrow();
    expect(JSON.parse(await readFile(data.registryPath, 'utf8'))).toEqual(concurrent);
    expect(await loadConnectorCredentials(data.credentialFiles)).toEqual(data.expectedCredentials);
  });

  it('rejects externally edited credentials without changing the manifest', async () => {
    const data = await fixture();
    const concurrent = upsertConnectorCredential(data.expectedCredentials, 'SAMPLE_HEALTH_PATIENT_ACCESS_CLIENT_ID', ['preview'], 'concurrent-client');
    await saveConnectorCredentials(concurrent, data.credentialFiles);
    await expect(saveConnectorSetup(data)).rejects.toThrow();
    expect(JSON.parse(await readFile(data.registryPath, 'utf8'))).toEqual(data.expectedRegistry);
    expect(await loadConnectorCredentials(data.credentialFiles)).toEqual(concurrent);
  });

  it('checks saved credentials for concurrent changes when editing only connection metadata', async () => {
    const data = await fixture();
    const concurrent = upsertConnectorCredential(data.expectedCredentials, 'SAMPLE_HEALTH_PATIENT_ACCESS_CLIENT_ID', ['preview'], 'concurrent-client');
    await saveConnectorCredentials(concurrent, data.credentialFiles);
    await expect(saveConnectorSetup({ ...data, credentials: data.expectedCredentials, targets: ['preview'] })).rejects.toThrow();
    expect(JSON.parse(await readFile(data.registryPath, 'utf8'))).toEqual(data.expectedRegistry);
    expect(await loadConnectorCredentials(data.credentialFiles)).toEqual(concurrent);
  });

  it('rolls back saved credentials when the manifest commit fails', async () => {
    const data = await fixture();
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (to === data.registryPath) throw new Error('Synthetic manifest write failure');
      return actual.rename(from, to);
    });
    await expect(saveConnectorSetup(data)).rejects.toThrow();
    expect(JSON.parse(await readFile(data.registryPath, 'utf8'))).toEqual(data.expectedRegistry);
    expect(await loadConnectorCredentials(data.credentialFiles)).toEqual(data.expectedCredentials);
    expect((await readdir(data.directory)).sort()).toEqual(['.env.secrets.preview', 'connectors.json']);
  });

  it('detects a manifest edit during credential commit and preserves that edit', async () => {
    const data = await fixture();
    const concurrent = [{ ...connection, name: 'Concurrent edit during save' }];
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let edited = false;
    vi.mocked(rename).mockImplementation(async (from, to) => {
      await actual.rename(from, to);
      if (to === data.credentialFiles.preview && !edited) {
        edited = true;
        await writeFile(data.registryPath, JSON.stringify(concurrent));
      }
    });
    await expect(saveConnectorSetup(data)).rejects.toThrow();
    expect(JSON.parse(await readFile(data.registryPath, 'utf8'))).toEqual(concurrent);
    expect(await loadConnectorCredentials(data.credentialFiles)).toEqual(data.expectedCredentials);
  });

  it('preserves a concurrent credential edit when rollback would overwrite it', async () => {
    const data = await fixture();
    const concurrent = upsertConnectorCredential(data.credentials, 'SAMPLE_HEALTH_PATIENT_ACCESS_CLIENT_ID', ['preview'], 'concurrent-client');
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (to === data.registryPath) {
        await writeFile(data.credentialFiles.preview, 'SAMPLE_HEALTH_PATIENT_ACCESS_CLIENT_ID=concurrent-client\n', { mode: 0o600 });
        throw new Error('Synthetic manifest write failure');
      }
      return actual.rename(from, to);
    });
    await expect(saveConnectorSetup(data)).rejects.toThrow();
    expect(JSON.parse(await readFile(data.registryPath, 'utf8'))).toEqual(data.expectedRegistry);
    expect(await loadConnectorCredentials(data.credentialFiles)).toEqual(concurrent);
  });
});

function injectedPrompt(answers: Record<string, string> = {}, hiddenAnswers: Record<string, string> = {}) {
  return {
    ask: vi.fn(async (label: string, _fallback?: string) => Object.entries(answers).find(([prefix]) => label.startsWith(prefix))?.[1] ?? ''),
    secret: vi.fn(async (label: string) => Object.entries(hiddenAnswers).find(([prefix]) => label.startsWith(prefix))?.[1] ?? ''),
    print: vi.fn<(message: string) => void>(),
  };
}

describe('connector setup input', () => {
  it('keeps a literal client ID unchanged during a scoped metadata edit', async () => {
    const literal = { ...connection, clientId: 'global-client' };
    const result = await setupConnection({ registry: [literal], credentials: {}, identifier: connection.id, targets: ['preview'] }, injectedPrompt({ 'Display name': 'Updated name' }));
    expect(result.registry[0]).toMatchObject({ clientId: 'global-client', name: 'Updated name' });
    expect(result.credentials).toEqual({});
    await expect(setupConnection({ registry: [literal], credentials: {}, identifier: connection.id, targets: ['preview'] }, injectedPrompt({}, { 'Client ID': 'new-client' })))
      .rejects.toThrow('Select all targets');
  });

  it('preserves a literal registration for every target when explicitly moving it to dotenv files', async () => {
    const literal = { ...connection, clientId: 'global-client' };
    const result = await setupConnection({ registry: [literal], credentials: {}, identifier: connection.id, targets: ['development', 'preview', 'production'] }, injectedPrompt());
    expect(result.registry[0]).not.toHaveProperty('clientId');
    expect(result.credentials).toEqual({ SAMPLE_HEALTH_PATIENT_ACCESS_CLIENT_ID: [{ targets: ['development', 'preview', 'production'], value: 'global-client' }] });
  });

  it('collects a new registration once, generates identity, and saves credentials only for selected targets', async () => {
    const prompt = injectedPrompt({
      'Organization ID': 'new-health', 'Display name': 'New Health', 'FHIR base URL': 'https://new.example/fhir',
      'Approved scopes': 'launch/patient patient/*.read', 'Token authentication': 'client_secret_basic',
    }, { 'Client ID': 'synthetic-new-client', 'Client secret': 'synthetic-new-secret' });
    const registry: unknown[] = [];
    const credentials = {};
    const result = await setupConnection({ registry, credentials, targets: ['development', 'preview'] }, prompt);
    expect(result.connectionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(result.registry).toEqual([{
      id: result.connectionId, organizationId: 'new-health', name: 'New Health', kind: 'provider', apiType: 'patient_access',
      fhirBaseUrl: 'https://new.example/fhir', scopes: 'launch/patient patient/*.read', grantedScopeFormat: 'smart',
      tokenAuthMethod: 'client_secret_basic', responseMode: 'query', enabled: false,
      clientSecretEnv: 'NEW_HEALTH_PATIENT_ACCESS_CLIENT_SECRET',
    }]);
    expect(result.credentials).toEqual({
      NEW_HEALTH_PATIENT_ACCESS_CLIENT_ID: [{ targets: ['development', 'preview'], value: 'synthetic-new-client' }],
      NEW_HEALTH_PATIENT_ACCESS_CLIENT_SECRET: [{ targets: ['development', 'preview'], value: 'synthetic-new-secret' }],
    });
    expect(prompt.secret).toHaveBeenCalledTimes(2);
    expect(prompt.ask.mock.calls.flat()).not.toContain('synthetic-new-client');
    expect(prompt.ask.mock.calls.flat()).not.toContain('synthetic-new-secret');
    expect(prompt.print.mock.calls.flat().join(' ')).not.toMatch(/synthetic-new-(?:client|secret)/);
    expect(registry).toEqual([]);
    expect(credentials).toEqual({});
  });

  it('edits by derived key while preserving UUID and blank credentials for every target', async () => {
    const credentials = parseConnectorCredentials({
      SAMPLE_HEALTH_PATIENT_ACCESS_CLIENT_ID: [{ targets: ['development', 'preview'], value: 'non-production' }, { targets: ['production'], value: 'production' }],
      RETIRED_CLIENT_ID: [{ targets: ['production'], value: 'retired' }],
    });
    const prompt = injectedPrompt({ 'Display name': 'Renamed Health' });
    const result = await setupConnection({ registry: [connection], credentials, identifier: 'sample-health-patient-access', targets: ['preview'] }, prompt);
    expect(result.connectionId).toBe(connection.id);
    expect(result.registry).toHaveLength(1);
    expect(result.registry[0]).toMatchObject({ id: connection.id, organizationId: connection.organizationId, name: 'Renamed Health' });
    expect(result.credentials).toEqual(credentials);
    expect(prompt.secret).toHaveBeenCalledTimes(1);
  });

  it('updates only selected credential targets while keeping other registrations and target values', async () => {
    const credentials = parseConnectorCredentials({
      SAMPLE_HEALTH_PATIENT_ACCESS_CLIENT_ID: [{ targets: ['development', 'preview'], value: 'old-client' }, { targets: ['production'], value: 'production-client' }],
      SAMPLE_SECRET: [{ targets: ['development', 'preview', 'production'], value: 'existing-secret' }],
    });
    const prompt = injectedPrompt({}, { 'Client ID': 'updated-preview-client', 'Client secret': 'updated-preview-secret' });
    const confidential = { ...connection, tokenAuthMethod: 'client_secret_post', clientSecretEnv: 'SAMPLE_SECRET' };
    const result = await setupConnection({ registry: [confidential], credentials, identifier: connection.id, targets: ['preview'] }, prompt);
    expect(result.credentials).toEqual({
      SAMPLE_HEALTH_PATIENT_ACCESS_CLIENT_ID: [{ targets: ['development'], value: 'old-client' }, { targets: ['production'], value: 'production-client' }, { targets: ['preview'], value: 'updated-preview-client' }],
      SAMPLE_SECRET: [{ targets: ['development', 'production'], value: 'existing-secret' }, { targets: ['preview'], value: 'updated-preview-secret' }],
    });
    expect(result.registry[0]).toMatchObject({ id: connection.id, tokenAuthMethod: 'client_secret_post', clientSecretEnv: 'SAMPLE_SECRET' });
    expect(prompt.print.mock.calls.flat().join(' ')).not.toMatch(/updated-preview/);
  });

  it('reuses a shared client registration with a notice and no duplicated credential value', async () => {
    const epic = { ...connection, organizationId: 'existing-epic-health', name: 'Existing Epic Health', clientIdEnv: 'EPIC_CLIENT_ID' };
    const credentials = parseConnectorCredentials({ EPIC_CLIENT_ID: [{ targets: ['development', 'preview', 'production'], value: 'shared-epic-client' }] });
    const prompt = injectedPrompt({
      'Organization ID': 'new-epic-health', 'Display name': 'New Epic Health', 'FHIR base URL': 'https://epic.example/fhir',
      'Client ID binding': 'EPIC_CLIENT_ID', 'Returned scope format': 'resource_operations',
    });
    const result = await setupConnection({ registry: [epic], credentials, targets: ['preview'] }, prompt);
    expect(result.registry).toHaveLength(2);
    expect(result.registry[0]).toEqual(epic);
    expect(result.registry[1]).toMatchObject({ organizationId: 'new-epic-health', clientIdEnv: 'EPIC_CLIENT_ID', grantedScopeFormat: 'resource_operations' });
    expect(result.credentials).toEqual(credentials);
    expect(prompt.print).toHaveBeenCalledWith(expect.stringContaining('shared with Existing Epic Health'));
    expect(prompt.print.mock.calls.flat().join(' ')).not.toContain('shared-epic-client');
    expect(prompt.secret).toHaveBeenCalledTimes(1);
  });

  it('accepts explicit OAuth endpoints and removes them when discovery is selected on edit', async () => {
    const prompt = injectedPrompt({
      'Organization ID': 'manual-payer', 'Display name': 'Manual Payer', 'Organization role': 'payer',
      'FHIR base URL': 'https://manual.example/fhir', 'Authorization endpoints': 'manual',
      'Authorization URL': 'https://manual.example/authorize', 'Token URL': 'https://manual.example/token',
      'Approved scopes': 'openid fhirUser patient/*.read', 'Returned scope format': 'read_search', 'Callback response mode': 'form_post',
    }, { 'Client ID': 'manual-client' });
    const initial = await setupConnection({ registry: [], credentials: {}, targets: ['preview'] }, prompt);
    expect(initial.registry[0]).toMatchObject({
      kind: 'payer', scopes: 'openid fhirUser patient/*.read', grantedScopeFormat: 'read_search', tokenAuthMethod: 'none',
      authorizationUrl: 'https://manual.example/authorize', tokenUrl: 'https://manual.example/token', responseMode: 'form_post',
    });
    const edited = await setupConnection({ ...initial, identifier: initial.connectionId, targets: ['preview'] }, injectedPrompt({ 'Authorization endpoints': 'discover' }));
    expect(edited.registry[0]).not.toHaveProperty('authorizationUrl');
    expect(edited.registry[0]).not.toHaveProperty('tokenUrl');
    expect(edited.credentials).toEqual(initial.credentials);
  });

  it('keeps identity permanent and asks for a unique key for a second registration of the same API', async () => {
    const prompt = injectedPrompt({
      'Organization ID': 'sample-health', 'Display name': 'Second registration', 'FHIR base URL': 'https://second.example/fhir',
      'Unique routing key': 'sample-health-second-patient-access', 'Client ID binding': 'SAMPLE_SECOND_CLIENT_ID',
    }, { 'Client ID': 'second-client' });
    const result = await setupConnection({ registry: [connection], credentials: {}, targets: ['development'] }, prompt);
    expect(result.connectionId).not.toBe(connection.id);
    expect(result.registry[0]).toEqual(connection);
    expect(result.registry[1]).toMatchObject({ key: 'sample-health-second-patient-access', clientIdEnv: 'SAMPLE_SECOND_CLIENT_ID' });
    expect(prompt.ask).toHaveBeenCalledWith('Unique routing key', 'sample-health-patient-access');
  });

  it('rejects unknown edit identities and invalid target selection before prompting', async () => {
    const prompt = injectedPrompt();
    await expect(setupConnection({ registry: [connection], credentials: {}, identifier: 'not-registered', targets: ['preview'] }, prompt)).rejects.toThrow('not registered');
    await expect(setupConnection({ registry: [connection], credentials: {}, targets: [] }, prompt)).rejects.toThrow('Choose development');
    await expect(setupConnection({ registry: [connection], credentials: {}, targets: ['preview', 'preview'] }, prompt)).rejects.toThrow('Choose development');
    expect(prompt.ask).not.toHaveBeenCalled();
    expect(prompt.secret).not.toHaveBeenCalled();
  });

  it('rejects malformed hidden credentials without putting their values into output', async () => {
    const prompt = injectedPrompt({}, { 'Client ID': 'synthetic-secret\nnot-allowed' });
    await expect(setupConnection({ registry: [connection], credentials: {}, identifier: connection.id, targets: ['preview'] }, prompt)).rejects.toThrow(/^Invalid connector credential update/);
    expect(prompt.print.mock.calls.flat().join(' ')).not.toContain('synthetic-secret');
  });

  it.each([connection.id.toUpperCase(), 'sample-health-patient-access'])('edits an uppercase stored UUID through %s and preserves its canonical identity', async identifier => {
    const uppercase = { ...connection, id: connection.id.toUpperCase() };
    const result = await setupConnection({ registry: [uppercase], credentials: {}, identifier, targets: ['preview'] }, injectedPrompt({ 'Display name': 'Canonical identity' }));
    expect(result.connectionId).toBe(connection.id);
    expect(result.registry).toHaveLength(1);
    expect(result.registry[0]).toMatchObject({ id: connection.id, name: 'Canonical identity' });
    expect(uppercase.id).toBe(connection.id.toUpperCase());
  });

  it.each<Record<string, string>>([
    { 'Organization ID': 'different-health' },
    { 'API type': 'payer_to_payer' },
  ])('requires a new identity when editing organization or API (%#)', async answers => {
    const prompt = injectedPrompt(answers);
    await expect(setupConnection({ registry: [connection], credentials: {}, identifier: connection.id, targets: ['preview'] }, prompt))
      .rejects.toThrow('Use add for a different organization or API');
    expect(prompt.secret).not.toHaveBeenCalled();
    expect(prompt.ask.mock.calls.some(([label]) => label.startsWith('Client ID binding'))).toBe(false);
  });

  it('derives a distinct secret binding for a client binding without the standard suffix', async () => {
    const prompt = injectedPrompt({ 'Client ID binding': 'HOSPITAL_APP_ID', 'Token authentication': 'client_secret_basic' }, {
      'Client ID': 'synthetic-hospital-client', 'Client secret': 'synthetic-hospital-secret',
    });
    const result = await setupConnection({ registry: [connection], credentials: {}, identifier: connection.id, targets: ['preview'] }, prompt);
    expect(prompt.ask).toHaveBeenCalledWith('Client secret binding', 'HOSPITAL_APP_ID_CLIENT_SECRET');
    expect(result.registry[0]).toMatchObject({ clientIdEnv: 'HOSPITAL_APP_ID', clientSecretEnv: 'HOSPITAL_APP_ID_CLIENT_SECRET' });
    expect(result.credentials).toEqual({
      HOSPITAL_APP_ID: [{ targets: ['preview'], value: 'synthetic-hospital-client' }],
      HOSPITAL_APP_ID_CLIENT_SECRET: [{ targets: ['preview'], value: 'synthetic-hospital-secret' }],
    });
  });

  it('collects advanced routing, relative callback, resource, and test-data settings in the same workflow', async () => {
    const prompt = injectedPrompt({
      'Configure callback': 'yes', 'Routing key override': 'sample-health-special',
      'Callback path or exact URL': '/auth/callback/sample-health-special',
      'Import resources': 'Patient, Condition', 'This connection uses test data': 'true',
      'Known test FHIR URLs': 'https://sample.example/test-fhir, https://sample.example/second-test-fhir',
    });
    const result = await setupConnection({ registry: [connection], credentials: {}, identifier: connection.id, targets: ['preview'] }, prompt);
    expect(result.registry[0]).toMatchObject({
      id: connection.id, key: 'sample-health-special', callbackPath: '/auth/callback/sample-health-special',
      resources: ['Patient', 'Condition'], testEnvironment: true,
      testFhirBaseUrls: ['https://sample.example/test-fhir', 'https://sample.example/second-test-fhir'],
    });
    expect(result.registry[0]).not.toHaveProperty('redirectUri');
    const env = withConnectorRegistry({}, result.registry);
    expect(connectorConfig(env, connection.id)).toMatchObject({ resources: ['Patient', 'Condition'], testEnvironment: true });
    expect(connectorRedirectUri({ ...env, APP_ORIGIN: 'https://preview.example' }, connection.id, 'https://preview.example'))
      .toBe('https://preview.example/auth/callback/sample-health-special');
    expect(connectorRedirectUri({ ...env, APP_ORIGIN: 'https://production.example' }, connection.id, 'https://production.example'))
      .toBe('https://production.example/auth/callback/sample-health-special');
  });

  it('supports an exact callback URL and switches it to a relative path without retaining both fields', async () => {
    const original = { ...connection, redirectUri: 'https://app.example/oauth/callback/sample-health-patient-access' };
    const prompt = injectedPrompt({ 'Configure callback': 'yes', 'Callback path or exact URL': '/auth/callback/sample-health-patient-access' });
    const result = await setupConnection({ registry: [original], credentials: {}, identifier: connection.id, targets: ['preview'] }, prompt);
    expect(result.registry[0]).toMatchObject({ callbackPath: '/auth/callback/sample-health-patient-access' });
    expect(result.registry[0]).not.toHaveProperty('redirectUri');
    const switched = await setupConnection({ ...result, identifier: connection.id, targets: ['preview'] }, injectedPrompt({
      'Configure callback': 'yes', 'Callback path or exact URL': 'https://app.example/oauth/callback/sample-health-patient-access',
    }));
    expect(switched.registry[0]).toMatchObject({ redirectUri: 'https://app.example/oauth/callback/sample-health-patient-access' });
    expect(switched.registry[0]).not.toHaveProperty('callbackPath');
  });

  it('rejects a stored callback path and exact URL conflict before prompting', async () => {
    const prompt = injectedPrompt();
    const conflict = { ...connection, callbackPath: '/oauth/callback/sample-health-patient-access', redirectUri: 'https://app.example/oauth/callback/sample-health-patient-access' };
    await expect(setupConnection({ registry: [conflict], credentials: {}, identifier: connection.id, targets: ['preview'] }, prompt)).rejects.toThrow('Connection registry settings need attention');
    expect(prompt.ask).not.toHaveBeenCalled();
    expect(prompt.secret).not.toHaveBeenCalled();
  });

  it.each(['/oauth/callback/another-connection', '/auth/callback/sample-health-patient-access?extra=1', '//outside.example/callback'])('rejects an unsupported callback path %s', async callback => {
    const prompt = injectedPrompt({ 'Configure callback': 'yes', 'Callback path or exact URL': callback });
    await expect(setupConnection({ registry: [connection], credentials: {}, identifier: connection.id, targets: ['preview'] }, prompt))
      .rejects.toThrow(/callback address must match this application|Connection registry settings need attention/);
  });
});
