import { withConnectorRegistry } from '../../src/server/connector-registry';
import { describe, expect, it, vi, afterEach } from 'vitest';
import app from '../../src/server/index';
import { connectorConfig, connectorRedirectUri } from '../../src/server/config';
import { connectorDefinition, connectorEnvironmentKeys, connectorRegistry } from '../../src/server/connector-registry';
import { bundledConnectionId, connectionIdentity } from '../helpers/connection-identity';
import { signReceipt } from '../../src/connectors/receipt';

const registration = {
  ...connectionIdentity('north-hospital'), name: 'North Hospital', kind: 'provider',
  fhirBaseUrl: 'https://north.example/fhir', clientIdEnv: 'NORTH_CLIENT_ID', clientSecretEnv: 'NORTH_CLIENT_SECRET',
  authorizationUrl: 'https://north.example/authorize', tokenUrl: 'https://north.example/token',
};
const { clientIdEnv: _clientIdEnv, ...derivedRegistration } = registration;
const { key: _routingKey, ...defaultRouteRegistration } = registration;
const env = withConnectorRegistry({ APP_ENV: 'development', APP_ORIGIN: 'https://app.example', PATIENT_PROCESSING_APPROVED: 'true', SESSION_SIGNING_KEY: 's'.repeat(48), NORTH_CLIENT_ID: 'synthetic-north-client', NORTH_CLIENT_SECRET: 'synthetic-north-secret' }, [registration]);
afterEach(() => vi.unstubAllGlobals());

describe('configuration registry', () => {
  it('resolves an arbitrary registration and its exact callback without vendor branches', () => {
    expect(connectorConfig(env, registration.id)).toMatchObject({ id: registration.id, key: registration.key, organizationId: registration.organizationId, name: registration.name,
      kind: 'provider', apiType: 'patient_access', grantedScopeFormat: 'smart', configured: true, enabled: true,
      clientId: env.NORTH_CLIENT_ID, clientSecret: env.NORTH_CLIENT_SECRET,
      resources: ['Patient', 'Encounter', 'MedicationRequest', 'MedicationDispense'],
    });
    expect(connectorRedirectUri(env, registration.id, 'https://untrusted.example')).toBe(`${env.APP_ORIGIN}/oauth/callback/north-hospital`);
    expect(connectorEnvironmentKeys(env)).toEqual({ runtimeKeys: ['NORTH_CLIENT_ID', 'NORTH_CLIENT_SECRET'], secretKeys: ['NORTH_CLIENT_SECRET'] });
  });

  it('resolves a readable key and canonical UUID to the same registered connection', () => {
    expect(connectorDefinition(env, registration.key)).toBe(connectorDefinition(env, registration.id));
    expect(connectorConfig(env, registration.key)).toEqual(connectorConfig(env, registration.id));
    expect(connectorConfig(env, registration.key).id).toBe(registration.id);
  });

  it('normalizes UUID casing while keeping the readable key independent of identity', () => {
    const id = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
    const settings = withConnectorRegistry({ ...env }, [{ ...registration, id: id.toUpperCase() }]);
    expect(connectorDefinition(settings, id.toUpperCase()).id).toBe(id);
    expect(connectorDefinition(settings, registration.key).id).toBe(id);
  });

  it.each(['id', 'organizationId', 'apiType'])('requires explicit %s on every connection', field => {
    const definition = { ...registration } as Record<string, unknown>;
    delete definition[field];
    expect(() => connectorRegistry(withConnectorRegistry({}, [definition]))).toThrow('registry');
  });

  it('derives an omitted routing key from organization and API', () => {
    const definitions = [defaultRouteRegistration];
    const settings = withConnectorRegistry({ ...env }, definitions);
    const connection = connectorDefinition(settings, registration.id);
    expect(connection).toMatchObject({ id: registration.id, organizationId: 'north-hospital', apiType: 'patient_access', key: 'north-hospital-patient-access' });
    expect(connectorDefinition(settings, 'north-hospital-patient-access')).toBe(connection);
    expect(connectorConfig(settings, 'north-hospital-patient-access')).toMatchObject({ id: registration.id, enabled: true });
    expect(connectorRedirectUri(settings, registration.id, env.APP_ORIGIN)).toBe(`${env.APP_ORIGIN}/oauth/callback/north-hospital-patient-access`);
    expect(() => connectorDefinition(settings, 'north-hospital')).toThrow('not registered');
    expect(definitions[0]).not.toHaveProperty('key');
  });

  it('uses an explicit routing key as the sole route for a registration', () => {
    expect(connectorDefinition(env, 'north-hospital').id).toBe(registration.id);
    expect(() => connectorDefinition(env, 'north-hospital-patient-access')).toThrow('not registered');
    expect(connectorRedirectUri(env, registration.id, env.APP_ORIGIN)).toBe(`${env.APP_ORIGIN}/oauth/callback/north-hospital`);
  });

  it.each(['', ' ', null])('rejects an explicit invalid key %j instead of deriving a replacement', key => {
    expect(() => connectorRegistry(withConnectorRegistry({}, [{ ...registration, key }]))).toThrow('registry');
  });

  it('rejects colliding derived routes and requires separate explicit keys for additional registrations', () => {
    const second = { ...defaultRouteRegistration, id: connectionIdentity('second', 2).id };
    expect(() => connectorRegistry(withConnectorRegistry({}, [defaultRouteRegistration, second]))).toThrow('registry');
    const settings = withConnectorRegistry({ ...env }, [defaultRouteRegistration, { ...second, key: 'north-hospital-second-app' }]);
    expect(connectorRegistry(settings).map(({ id, key }) => ({ id, key }))).toEqual([
      { id: registration.id, key: 'north-hospital-patient-access' }, { id: second.id, key: 'north-hospital-second-app' },
    ]);
  });

  it('rejects a derived route that collides with an explicit route in either registry order', () => {
    const explicit = { ...registration, ...connectionIdentity('north-hospital-patient-access', 2, 'south-hospital') };
    for (const definitions of [[defaultRouteRegistration, explicit], [explicit, defaultRouteRegistration]]) {
      expect(() => connectorRegistry(withConnectorRegistry({}, definitions))).toThrow('registry');
    }
  });

  it('requires a valid explicit route when the derived key exceeds the route length limit', () => {
    const definition = { ...defaultRouteRegistration, organizationId: 'a'.repeat(80) };
    expect(() => connectorRegistry(withConnectorRegistry({}, [definition]))).toThrow('registry');
    const settings = withConnectorRegistry({ ...env }, [{ ...definition, key: 'north-short-route' }]);
    expect(connectorDefinition(settings, 'north-short-route')).toMatchObject({ id: registration.id, organizationId: definition.organizationId });
    expect(connectorRedirectUri(settings, registration.id, env.APP_ORIGIN)).toBe(`${env.APP_ORIGIN}/oauth/callback/north-short-route`);
  });

  it('keeps identity stable when a connection is renamed or moved to a new readable key', () => {
    const settings = withConnectorRegistry({ ...env }, [{ ...registration, key: 'north-patient-access', name: 'North Health' }]);
    expect(connectorConfig(settings, registration.id)).toMatchObject({ id: registration.id, organizationId: registration.organizationId, key: 'north-patient-access', name: 'North Health' });
    expect(connectorDefinition(settings, 'north-patient-access').id).toBe(registration.id);
    expect(() => connectorDefinition(settings, registration.key)).toThrow('not registered');
  });

  it('keeps separate API registrations for the same payer with their own credentials, endpoints and callbacks', () => {
    const bindings = { patient_access: 'EXAMPLE_PAYER_PATIENT_ACCESS_CLIENT_ID', payer_to_payer: 'EXAMPLE_PAYER_PAYER_TO_PAYER_CLIENT_ID', provider_directory: 'EXAMPLE_PAYER_PROVIDER_DIRECTORY_CLIENT_ID' };
    const definitions = (['patient_access', 'payer_to_payer', 'provider_directory'] as const).map((apiType, index) => {
      const { key: _key, ...definition } = {
        ...derivedRegistration, ...connectionIdentity('example-payer', index + 1), name: 'Example Payer', kind: 'payer', apiType,
        fhirBaseUrl: `https://payer.example/${apiType}`, clientSecretEnv: `EXAMPLE_${apiType.toUpperCase()}_CLIENT_SECRET`,
      };
      return definition;
    });
    const credentials = Object.fromEntries(definitions.flatMap(definition => [
      [bindings[definition.apiType], `${definition.apiType}-client`], [definition.clientSecretEnv, `${definition.apiType}-secret`],
    ]));
    const settings = withConnectorRegistry({ ...env, ...credentials }, definitions);
    const expectedKeys = ['example-payer-patient-access', 'example-payer-payer-to-payer', 'example-payer-provider-directory'];
    expect(connectorRegistry(settings).map(definition => definition.key)).toEqual(expectedKeys);
    expect(connectorRegistry(settings).map(({ id, organizationId, kind, apiType, fhirBaseUrl }) => ({ id, organizationId, kind, apiType, fhirBaseUrl })))
      .toEqual(definitions.map(({ id, organizationId, kind, apiType, fhirBaseUrl }) => ({ id, organizationId, kind, apiType, fhirBaseUrl })));
    for (const [index, definition] of definitions.entries()) {
      expect(connectorDefinition(settings, expectedKeys[index]).id).toBe(definition.id);
      expect(connectorDefinition(settings, definition.id).clientIdEnv).toBe(bindings[definition.apiType]);
      expect(connectorConfig(settings, definition.id)).toMatchObject({ apiType: definition.apiType, base: definition.fhirBaseUrl,
        clientId: credentials[bindings[definition.apiType]], clientSecret: credentials[definition.clientSecretEnv], enabled: definition.apiType === 'patient_access' });
      expect(connectorRedirectUri(settings, definition.id, env.APP_ORIGIN)).toBe(`${env.APP_ORIGIN}/oauth/callback/${expectedKeys[index]}`);
    }
    for (const missing of definitions) {
      for (const missingBinding of [bindings[missing.apiType], missing.clientSecretEnv]) {
        const remainingCredentials = { ...credentials };
        delete remainingCredentials[missingBinding];
        const incompleteSettings = withConnectorRegistry({ ...env, ...remainingCredentials }, definitions);
        expect(connectorConfig(incompleteSettings, missing.id)).toMatchObject({
          clientId: remainingCredentials[bindings[missing.apiType]] ?? '', clientSecret: remainingCredentials[missing.clientSecretEnv] ?? '', configured: false, enabled: false,
        });
        for (const other of definitions.filter(definition => definition.id !== missing.id)) {
          expect(connectorConfig(incompleteSettings, other.id)).toMatchObject({
            clientId: credentials[bindings[other.apiType]], clientSecret: credentials[other.clientSecretEnv], enabled: other.apiType === 'patient_access',
          });
        }
      }
    }
  });

  it('keeps the derived credential binding stable when the routing key changes', () => {
    const settings = withConnectorRegistry({ ...env, NORTH_HOSPITAL_PATIENT_ACCESS_CLIENT_ID: 'organization-api-client' }, [{ ...derivedRegistration, key: 'new-patient-route' }]);
    expect(connectorConfig(settings, 'new-patient-route')).toMatchObject({ id: registration.id, clientId: 'organization-api-client', enabled: true });
    expect(connectorEnvironmentKeys(settings)).toEqual({ runtimeKeys: ['NORTH_HOSPITAL_PATIENT_ACCESS_CLIENT_ID', 'NORTH_CLIENT_SECRET'], secretKeys: ['NORTH_CLIENT_SECRET'] });
  });

  it.each([
    ['atrius-health', '1938958e-4c7b-426b-a356-0e0a47f9d31c', 'EPIC_CLIENT_ID'],
    ['bch', 'ff868f81-a768-44e8-9d13-57135ccafc61', 'EPIC_CLIENT_ID'],
    ['cigna', '74883015-7d10-40a9-a7d5-f75c6b1582ae', 'CIGNA_PATIENT_ACCESS_CLIENT_ID'],
    ['aetna', 'f99b1027-4b43-4acd-8e6b-7814f0287743', 'AETNA_PATIENT_ACCESS_CLIENT_ID'],
  ])('preserves %s identity and client registration under its API-specific routing key', (organizationId, id, clientIdEnv) => {
    const key = `${organizationId}-patient-access`;
    const settings = { [clientIdEnv]: 'existing-client-registration' };
    expect(connectorDefinition(settings, key)).toMatchObject({ id, organizationId, key, apiType: 'patient_access', clientIdEnv });
    expect(connectorDefinition(settings, id)).toBe(connectorDefinition(settings, key));
    expect(connectorConfig(settings, id).clientId).toBe('existing-client-registration');
    expect(connectorRedirectUri(settings, id, env.APP_ORIGIN)).toBe(`${env.APP_ORIGIN}/oauth/callback/${key}`);
  });

  it('allows registrations in the same organization and API to share a default or select an explicit client binding', () => {
    const definitions = [derivedRegistration,
      { ...derivedRegistration, ...connectionIdentity('north-second-endpoint', 2, registration.organizationId) },
      { ...derivedRegistration, ...connectionIdentity('north-separate-app', 3, registration.organizationId), clientIdEnv: 'NORTH_SEPARATE_APP_CLIENT_ID' },
    ];
    const settings = withConnectorRegistry({ ...env, NORTH_HOSPITAL_PATIENT_ACCESS_CLIENT_ID: 'shared-client', NORTH_SEPARATE_APP_CLIENT_ID: 'separate-client' }, definitions);
    expect(definitions.map(definition => connectorConfig(settings, definition.id).clientId)).toEqual(['shared-client', 'shared-client', 'separate-client']);
    expect(connectorEnvironmentKeys(settings).runtimeKeys.filter(key => key === 'NORTH_HOSPITAL_PATIENT_ACCESS_CLIENT_ID')).toHaveLength(1);
  });

  it.each([undefined, '', ' '])('keeps an explicit client binding authoritative when its value is %j', value => {
    const settings = withConnectorRegistry({ ...env, NORTH_CLIENT_ID: value, NORTH_HOSPITAL_PATIENT_ACCESS_CLIENT_ID: 'must-not-fall-back', LEGACY_CLIENT_ID: 'also-not-a-fallback' }, [{ ...registration }]);
    expect(connectorConfig(settings, registration.id)).toMatchObject({ clientId: value ?? '', configured: false, enabled: false });
    expect(connectorEnvironmentKeys(settings).runtimeKeys).not.toContain('NORTH_HOSPITAL_PATIENT_ACCESS_CLIENT_ID');
  });

  it('keeps literal client IDs independent of derived or legacy environment values', () => {
    const settings = withConnectorRegistry({ ...env, NORTH_HOSPITAL_PATIENT_ACCESS_CLIENT_ID: 'derived-client', LEGACY_CLIENT_ID: 'legacy-client' }, [{ ...derivedRegistration, clientId: 'literal-client' }]);
    expect(connectorConfig(settings, registration.id)).toMatchObject({ clientId: 'literal-client', enabled: true });
    expect(connectorEnvironmentKeys(settings).runtimeKeys).not.toContain('NORTH_HOSPITAL_PATIENT_ACCESS_CLIENT_ID');
    expect(connectorConfig({ ...settings, LEGACY_CLIENT_ID: '', NORTH_HOSPITAL_PATIENT_ACCESS_CLIENT_ID: '' }, registration.id).clientId).toBe('literal-client');
    expect(connectorConfig(withConnectorRegistry({ ...settings }, [{ ...derivedRegistration, clientId: '' }]), registration.id))
      .toMatchObject({ clientId: '', configured: false, enabled: false });
  });

  it('allows one organization to offer provider and payer connections with independent resources', () => {
    const payer = { ...registration, ...connectionIdentity('north-claims', 2, registration.organizationId), kind: 'payer' };
    const settings = withConnectorRegistry({ ...env }, [registration, payer]);
    expect(connectorRegistry(settings).map(({ id, organizationId, kind }) => ({ id, organizationId, kind }))).toEqual([
      { id: registration.id, organizationId: registration.organizationId, kind: 'provider' },
      { id: payer.id, organizationId: registration.organizationId, kind: 'payer' },
    ]);
    expect(connectorConfig(settings, registration.id).resources).toEqual(['Patient', 'Encounter', 'MedicationRequest', 'MedicationDispense']);
    expect(connectorConfig(settings, payer.id).resources).toEqual(['Patient', 'ExplanationOfBenefit']);
  });

  it.each(['payer_to_payer', 'provider_directory'])('does not enable patient imports for %s even with credentials and explicit patient resources', apiType => {
    const settings = withConnectorRegistry({ ...env }, [{ ...registration, kind: 'payer', apiType, enabled: true, scopes: 'system/ExplanationOfBenefit.read', resources: ['Patient', 'ExplanationOfBenefit'] }]);
    expect(connectorConfig(settings, registration.id)).toMatchObject({
      apiType, configured: false, enabled: false, resources: [], unavailableReason: expect.stringContaining('API is not supported'),
    });
  });

  it('uses a payer resource set independently of the connection ID or grant format', () => {
    const settings = withConnectorRegistry({ ...env }, [{ ...registration, kind: 'payer' }]);
    expect(connectorConfig(settings, registration.id).resources).toEqual(['Patient', 'ExplanationOfBenefit']);
  });

  it('does not silently treat a missing declared client secret as a public registration', () => {
    expect(connectorConfig({ ...env, NORTH_CLIENT_SECRET: '' }, registration.id)).toMatchObject({
      tokenAuthMethod: 'client_secret_basic', configured: false, enabled: false, unavailableReason: expect.stringContaining('client secret'),
    });
  });

  it('keeps grant format, requested scopes and secret authentication independent within the same organization and API', () => {
    const { clientSecretEnv: _secret, ...publicRegistration } = registration;
    const definitions = [
      { ...publicRegistration, grantedScopeFormat: 'read_search' },
      { ...registration, ...connectionIdentity('north-resource-access', 2, registration.organizationId), grantedScopeFormat: 'resource_operations',
        clientSecretAuthMethod: 'client_secret_post', scopes: 'openid fhirUser patient/*.read' },
      { ...registration, ...connectionIdentity('north-smart-access', 3, registration.organizationId), grantedScopeFormat: 'smart',
        scopes: 'patient/Patient.r patient/Encounter.rs' },
    ];
    const settings = withConnectorRegistry({ ...env }, definitions);
    const configs = definitions.map(definition => connectorConfig(settings, definition.id));
    expect(configs).toEqual([
      expect.objectContaining({ grantedScopeFormat: 'read_search', scopes: 'launch/patient patient/*.read', tokenAuthMethod: 'none', enabled: true }),
      expect.objectContaining({ grantedScopeFormat: 'resource_operations', scopes: 'openid fhirUser patient/*.read', tokenAuthMethod: 'client_secret_post', enabled: true }),
      expect.objectContaining({ grantedScopeFormat: 'smart', scopes: 'patient/Patient.r patient/Encounter.rs', tokenAuthMethod: 'client_secret_basic', enabled: true }),
    ]);
    expect(configs.every(config => config.organizationId === registration.organizationId && config.apiType === 'patient_access')).toBe(true);
  });

  it.each(['client_secret_basic', 'client_secret_post'] as const)('uses %s only with a declared client secret', clientSecretAuthMethod => {
    const { clientSecretEnv: _secret, ...publicRegistration } = registration;
    const definition = { ...publicRegistration, clientSecretAuthMethod };
    const settings = withConnectorRegistry({ ...env }, [definition]);
    expect(connectorConfig(settings, definition.id)).toMatchObject({ clientSecret: '', tokenAuthMethod: 'none', enabled: true });
    expect(connectorConfig({ ...settings, NORTH_CLIENT_SECRET: '' }, definition.id)).toMatchObject({ tokenAuthMethod: 'none', enabled: true });
    const declared = withConnectorRegistry({ ...settings, NORTH_CLIENT_SECRET: '' }, [{ ...definition, clientSecretEnv: 'NORTH_CLIENT_SECRET' }]);
    expect(connectorConfig(declared, definition.id)).toMatchObject({
      tokenAuthMethod: clientSecretAuthMethod, enabled: false, configured: false, unavailableReason: expect.stringContaining('client secret'),
    });
  });

  it.each(['none', 'client_secret_basic', 'client_secret_post'] as const)('honors explicit %s authentication over the conditional default', tokenAuthMethod => {
    const definition = { ...registration, clientSecretAuthMethod: tokenAuthMethod === 'client_secret_post' ? 'client_secret_basic' : 'client_secret_post', tokenAuthMethod };
    const settings = withConnectorRegistry({ ...env }, [definition]);
    expect(connectorConfig(settings, definition.id)).toMatchObject({ tokenAuthMethod, enabled: true });
    expect(connectorConfig({ ...settings, NORTH_CLIENT_SECRET: '' }, definition.id)).toMatchObject({ tokenAuthMethod, enabled: tokenAuthMethod === 'none' });
    const legacySettings = { ...settings, NORTH_TOKEN_AUTH_METHOD: tokenAuthMethod === 'none' ? 'client_secret_basic' : 'none' };
    expect(connectorConfig(legacySettings, definition.id)).toMatchObject({ tokenAuthMethod, enabled: true });
  });

  it('keeps a programmatically supplied registry isolated from bundled integrations', () => {
    expect(connectorRegistry(withConnectorRegistry({ ...env }, []))).toEqual([]);
    expect(() => connectorConfig(env, 'atrius-health-patient-access')).toThrow('not registered');
    expect(connectorRegistry({}).map(entry => entry.key)).toEqual(['atrius-health-patient-access', 'bch-patient-access', 'cigna-patient-access', 'aetna-patient-access']);
  });

  it('ignores undeclared credential and metadata variables while using explicit registration fields', () => {
    const { clientSecretEnv: _secret, ...publicRegistration } = registration;
    const settings = withConnectorRegistry({ ...env, NORTH_FHIR_BASE_URL: 'https://other.example/fhir',
      NORTH_SCOPES: 'offline_access patient/*.write', NORTH_REDIRECT_URI: 'https://other.example/callback',
      NORTH_TOKEN_AUTH_METHOD: 'client_secret_post', NORTH_RESPONSE_MODE: 'form_post', LEGACY_CLIENT_SECRET: 'unused-secret',
    }, [publicRegistration]);
    expect(connectorConfig(settings, registration.id)).toMatchObject({ base: registration.fhirBaseUrl, clientSecret: '',
      scopes: 'launch/patient patient/*.read', tokenAuthMethod: 'none', responseMode: 'query', enabled: true });
    expect(connectorRedirectUri(settings, registration.id, env.APP_ORIGIN)).toBe(`${env.APP_ORIGIN}/oauth/callback/${registration.key}`);
    expect(connectorEnvironmentKeys(settings)).toEqual({ runtimeKeys: ['NORTH_CLIENT_ID'], secretKeys: [] });
  });

  it.each(['[]', [], '', null])('rejects the retired environment registry override %j', CONNECTOR_REGISTRY => {
    expect(() => connectorRegistry({ ...env, CONNECTOR_REGISTRY })).toThrow('registry');
  });

  it('keeps programmatic injection private across serialization while retaining it across an environment copy', () => {
    expect(connectorRegistry({ ...env })).toBe(connectorRegistry(env));
    const serialized = JSON.stringify(env);
    expect(serialized).not.toContain(registration.fhirBaseUrl);
    expect(serialized).not.toContain('CONNECTOR_REGISTRY');
    expect(connectorRegistry(JSON.parse(serialized)).map(entry => entry.organizationId)).toEqual(['atrius-health', 'bch', 'cigna', 'aetna']);
  });

  it('retains the exact registered spelling after validating the origin and path', () => {
    const redirectUri = 'https://APP.example:443/oauth/callback/north-hospital';
    expect(connectorRedirectUri(withConnectorRegistry({ ...env }, [{ ...registration, redirectUri }]), registration.id, env.APP_ORIGIN)).toBe(redirectUri);
  });

  it.each([
    '', '{}', 'null', 'malformed-json',
    ([registration, registration]),
    ([{ ...registration, id: '../token' }]),
    ([{ ...registration, id: 'north%2fhospital' }]),
    ([{ ...registration, id: registration.key }]),
    ([{ ...registration, id: '00000000-0000-0000-0000-000000000000' }]),
    ([{ ...registration, id: 'ffffffff-ffff-ffff-ffff-ffffffffffff' }]),
    ([{ ...registration, key: '../token' }]),
    ([{ ...registration, key: registration.id }]),
    ([{ ...registration, organizationId: '../organization' }]),
    ([registration, { ...registration, id: connectionIdentity('south', 2).id }]),
    ([registration, { ...registration, key: 'south' }]),
    ([
      { ...registration, id: 'abcdefab-cdef-4abc-8def-abcdefabcdef' },
      { ...registration, id: 'ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF', key: 'south' },
    ]),
    ([{ ...registration, clientSecret: 'mistaken-secret' }]),
    ([{ ...registration, clientId: 'ambiguous' }]),
    ([{ ...registration, clientIdEnv: 'NORTH_CLIENT_SECRET' }]),
    ([{ ...registration, clientIdEnv: 'SESSION_SIGNING_KEY' }]),
    ...['smart', 'epic', 'cigna'].map(scopeProfile => ([{ ...registration, scopeProfile }])),
    ...['', 'epic', 'cigna', 'patient_access', null, 42].map(grantedScopeFormat => ([{ ...registration, grantedScopeFormat }])),
    ...['', 'none', 'private_key_jwt', null, 42].map(clientSecretAuthMethod => ([{ ...registration, clientSecretAuthMethod }])),
    ...['', 'payer', 'patient-access', 'unknown', null, 42].map(apiType => ([{ ...registration, apiType }])),
    ([{ ...registration, resources: ['Encounter'] }]),
    ([{ ...registration, resources: ['Patient', 'Patient'] }]),
    ([{ ...registration, resources: ['Patient', 'DocumentReference'] }]),
    ([{ ...registration, legacyCallbackPath: '/auth/callback' }, { ...registration, ...connectionIdentity('south', 2), legacyCallbackPath: '/auth/callback' }]),
    [{ ...registration, legacyEnvPrefixes: ['NORTH'] }],
  ].map(input => ({ input })))('fails closed with a safe registry error for invalid configuration %#', ({ input }) => {
    expect(() => withConnectorRegistry(env, input)).toThrow('Connection registry settings need attention.');
  });

  it('rejects a binding used as a secret in one entry and as a public client ID in another', () => {
    expect(() => connectorRegistry(withConnectorRegistry({}, [registration, { ...registration, ...connectionIdentity('south', 2), clientIdEnv: 'NORTH_CLIENT_SECRET' }]))).toThrow('registry');
  });

  it('rejects a derived client binding used as a secret by any registration', () => {
    const conflicting = { ...registration, ...connectionIdentity('south', 2), clientSecretEnv: 'NORTH_HOSPITAL_PATIENT_ACCESS_CLIENT_ID' };
    for (const definitions of [[derivedRegistration, conflicting], [conflicting, derivedRegistration]]) {
      expect(() => connectorRegistry(withConnectorRegistry({}, definitions))).toThrow('registry');
    }
    expect(() => connectorRegistry(withConnectorRegistry({}, [{ ...derivedRegistration, clientSecretEnv: 'NORTH_HOSPITAL_PATIENT_ACCESS_CLIENT_ID' }]))).toThrow('registry');
  });

  it.each(['123-health', 'a'.repeat(80)])('requires an explicit binding or literal when organizationId %s cannot produce a valid binding', organizationId => {
    const definition = { ...derivedRegistration, organizationId, apiType: 'provider_directory' };
    expect(() => connectorRegistry(withConnectorRegistry({}, [definition]))).toThrow('registry');
    expect(connectorDefinition(withConnectorRegistry({}, [{ ...definition, clientIdEnv: 'APP_SPECIFIC_CLIENT_ID' }]), definition.id).clientIdEnv).toBe('APP_SPECIFIC_CLIENT_ID');
    expect(connectorConfig(withConnectorRegistry({}, [{ ...definition, clientId: 'literal-client' }]), definition.id).clientId).toBe('literal-client');
  });

  it.each(['SESSION_SIGNING_KEY', 'AI_API_KEY', 'CLOUDFLARE_API_TOKEN', 'SHORT_TERM_FEED_TOKEN', 'APP_ORIGIN', 'CONNECTOR_REGISTRY'])(
    'rejects unrelated application binding %s as either credential before exposing or sending it', key => {
      for (const field of ['clientIdEnv', 'clientSecretEnv']) {
        expect(() => connectorRegistry(withConnectorRegistry({}, [{ ...registration, [field]: key }]))).toThrow('registry');
      }
    },
  );

  it('never guesses configuration for syntactically valid but unknown IDs', () => {
    expect(() => connectorDefinition({ ...env, UNKNOWN_CLIENT_ID: 'not-a-registration' }, 'unknown')).toThrow('not registered');
  });
});

describe('registry-backed routes', () => {
  it('publishes and authorizes a derived routing key while returning the permanent connection UUID', async () => {
    const settings = withConnectorRegistry({ ...env }, [defaultRouteRegistration]);
    const status = await app.request(`${env.APP_ORIGIN}/api/status`, {}, settings);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ connectors: [{ id: registration.id, key: 'north-hospital-patient-access', organizationId: 'north-hospital', apiType: 'patient_access', enabled: true }] });
    for (const identifier of ['north-hospital-patient-access', registration.id]) {
      const authorize = await app.request(`${env.APP_ORIGIN}/api/connectors/${identifier}/authorize`, {}, settings);
      expect(authorize.status).toBe(200);
      expect(await authorize.json()).toMatchObject({ connectionId: registration.id, clientId: env.NORTH_CLIENT_ID,
        redirectUri: `${env.APP_ORIGIN}/oauth/callback/north-hospital-patient-access` });
    }
  });

  it.each(['GET', 'POST'])('delivers a %s callback on a derived route with the canonical UUID', async method => {
    const settings = withConnectorRegistry({ ...env }, [defaultRouteRegistration]);
    const values = new URLSearchParams({ state: 'derived-route-state', code: 'synthetic-code' });
    const response = await app.request(`${env.APP_ORIGIN}/oauth/callback/north-hospital-patient-access${method === 'GET' ? `?${values}` : ''}`,
      method === 'GET' ? {} : { method, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: values }, settings);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(`"connector":"${registration.id}"`);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('rejects an unregistered derived route when an explicit key owns the callback', async () => {
    expect((await app.request(`${env.APP_ORIGIN}/api/connectors/north-hospital-patient-access/authorize`, {}, env)).status).toBe(404);
    expect((await app.request(`${env.APP_ORIGIN}/oauth/callback/north-hospital-patient-access?code=synthetic-code&state=opaque-state`, {}, env)).status).toBe(404);
  });

  it('publishes one Atrius connection through Epic without a duplicate Epic organization entry', async () => {
    const response = await app.request(`${env.APP_ORIGIN}/api/status`, {}, {
      APP_ENV: 'development', APP_ORIGIN: env.APP_ORIGIN, EPIC_CLIENT_ID: 'synthetic-epic-client',
      PATIENT_PROCESSING_APPROVED: 'true', SESSION_SIGNING_KEY: env.SESSION_SIGNING_KEY,
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { connectors: { id: string; key: string; organizationId: string; name: string }[] };
    expect(body.connectors.map(connection => connection.key)).toEqual(['atrius-health-patient-access', 'bch-patient-access', 'cigna-patient-access', 'aetna-patient-access']);
    expect(body.connectors.filter(connection => connection.organizationId === 'atrius-health')).toEqual([
      expect.objectContaining({ id: bundledConnectionId('atrius-health-patient-access'), key: 'atrius-health-patient-access', name: 'Atrius Health' }),
    ]);
  });

  it.each(['epic', 'f51b8aa0-94ce-492b-bc06-fcaafdc1ece0'])('rejects the removed duplicate connection identifier %s before upstream I/O', async id => {
    const upstream = vi.fn(); vi.stubGlobal('fetch', upstream);
    const settings = { APP_ENV: 'development', APP_ORIGIN: env.APP_ORIGIN, EPIC_CLIENT_ID: 'synthetic-epic-client',
      PATIENT_PROCESSING_APPROVED: 'true', SESSION_SIGNING_KEY: env.SESSION_SIGNING_KEY };
    for (const action of ['authorize', 'token', 'resource', 'references', 'callback']) {
      const path = action === 'callback' ? `/oauth/callback/${id}` : `/api/connectors/${id}/${action}`;
      const response = await app.request(`${env.APP_ORIGIN}${path}`, ['authorize', 'callback'].includes(action) ? {} : { method: 'POST' }, settings);
      expect(response.status, action).toBe(404);
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each(['atrius-health', 'bch', 'cigna', 'aetna'])('rejects retired bundled key %s on API and callback routes', async key => {
    const upstream = vi.fn(); vi.stubGlobal('fetch', upstream);
    const settings = { APP_ENV: 'development', APP_ORIGIN: env.APP_ORIGIN, EPIC_CLIENT_ID: 'synthetic-epic-client',
      PATIENT_PROCESSING_APPROVED: 'true', SESSION_SIGNING_KEY: env.SESSION_SIGNING_KEY };
    for (const action of ['authorize', 'token', 'resource', 'references']) {
      const response = await app.request(`${env.APP_ORIGIN}/api/connectors/${key}/${action}`, action === 'authorize' ? {} : { method: 'POST' }, settings);
      expect(response.status, action).toBe(404);
    }
    for (const prefix of ['/oauth/callback', '/auth/callback']) {
      for (const method of ['GET', 'POST']) {
        const response = await app.request(`${env.APP_ORIGIN}${prefix}/${key}`, { method }, settings);
        expect(response.status, `${method} ${prefix}`).toBe(404);
      }
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it('publishes display metadata and only safe authorization fields', async () => {
    const status = await app.request(`${env.APP_ORIGIN}/api/status`, {}, env);
    const publicStatus = await status.text();
    expect(status.status).toBe(200);
    expect(JSON.parse(publicStatus).connectors).toEqual([{ id: registration.id, key: registration.key, organizationId: registration.organizationId, name: registration.name, kind: 'provider', apiType: 'patient_access', configured: true, enabled: true }]);
    expect(publicStatus).not.toContain(env.NORTH_CLIENT_ID);
    const authorize = await app.request(`${env.APP_ORIGIN}/api/connectors/${registration.id}/authorize`, {}, env);
    const publicAuthorization = await authorize.text();
    expect(authorize.status).toBe(200);
    expect(JSON.parse(publicAuthorization)).toMatchObject({ connectionId: registration.id, name: registration.name, clientId: env.NORTH_CLIENT_ID,
      redirectUri: `${env.APP_ORIGIN}/oauth/callback/${registration.key}`, resources: ['Patient', 'Encounter', 'MedicationRequest', 'MedicationDispense'] });
    for (const content of [publicStatus, publicAuthorization]) {
      expect(content).not.toContain(env.NORTH_CLIENT_SECRET);
      expect(content).not.toContain(env.SESSION_SIGNING_KEY);
      expect(content).not.toContain('clientSecretEnv');
    }
  });

  it.each(['authorize', 'token', 'resource', 'references', 'callback'])('rejects an unknown %s connection before upstream I/O', async action => {
    const upstream = vi.fn(); vi.stubGlobal('fetch', upstream);
    const path = action === 'callback' ? '/oauth/callback/unknown' : `/api/connectors/unknown/${action}`;
    const response = await app.request(`${env.APP_ORIGIN}${path}`, ['authorize', 'callback'].includes(action) ? {} : { method: 'POST' }, env);
    expect(response.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('keeps disabled entries visible while blocking sign-in before discovery', async () => {
    const upstream = vi.fn(); vi.stubGlobal('fetch', upstream);
    const settings = withConnectorRegistry({ ...env }, [{ ...registration, enabled: false }]);
    const status = await app.request(`${env.APP_ORIGIN}/api/status`, {}, settings);
    const body = await status.json() as { connectors: unknown[]; issues: string[] };
    expect(body).toMatchObject({ connectors: [{ id: registration.id, enabled: false, reason: expect.stringContaining('disabled') }] });
    expect(body.issues).not.toContain(`${registration.name} is not connected.`);
    expect((await app.request(`${env.APP_ORIGIN}/api/connectors/${registration.id}/authorize`, {}, settings)).status).toBe(503);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each(['payer_to_payer', 'provider_directory'])('publishes %s metadata but blocks patient routes before upstream I/O', async apiType => {
    const upstream = vi.fn(); vi.stubGlobal('fetch', upstream);
    const settings = withConnectorRegistry({ ...env }, [{ ...registration, kind: 'payer', apiType }]);
    const status = await app.request(`${env.APP_ORIGIN}/api/status`, {}, settings);
    expect(await status.json()).toMatchObject({ connectors: [{ id: registration.id, kind: 'payer', apiType, enabled: false }] });
    const token = 'synthetic-access-token'; const patientId = 'patient-123';
    const receipt = await signReceipt(env.SESSION_SIGNING_KEY, registration.id, patientId, token, 600);
    const requests: [string, RequestInit][] = [
      ['authorize', {}],
      ['token', { method: 'POST', headers: { Origin: env.APP_ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'synthetic-code', verifier: 'v'.repeat(43) }) }],
      ['resource', { method: 'POST', headers: { Origin: env.APP_ORIGIN, 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ receipt, patientId, resource: 'Patient', from: '2025-01-01', to: '2025-12-31' }) }],
    ];
    for (const [action, request] of requests) {
      const response = await app.request(`${env.APP_ORIGIN}/api/connectors/${registration.id}/${action}`, request, settings);
      expect(response.status, action).toBe(503);
      const body = await response.text();
      expect(JSON.parse(body)).toMatchObject({ error: { code: 'connector_not_configured', message: expect.stringMatching(/API is not supported|not enabled/) } });
      expect(body).not.toContain(env.NORTH_CLIENT_SECRET);
    }
    const callback = await app.request(`${env.APP_ORIGIN}/oauth/callback/${registration.key}?code=synthetic-code&state=synthetic-state`, {}, settings);
    expect(callback.status).toBe(503);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each(['GET', 'POST'])('delivers a custom registration %s callback to the selected connector', async method => {
    const params = new URLSearchParams({ state: 'opaque-state', code: 'synthetic-code' });
    const response = await app.request(`${env.APP_ORIGIN}/oauth/callback/${registration.key}${method === 'GET' ? `?${params}` : ''}`,
      method === 'GET' ? {} : { method, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params }, env);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain(`"connector":"${registration.id}"`);
    expect(html).toContain(`,"${env.APP_ORIGIN}")`);
    expect(html).toContain("history.replaceState(null,'','/oauth/complete')");
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('rejects a callback sent to the wrong origin and a legacy alias absent from the registry', async () => {
    expect((await app.request(`https://wrong.example/oauth/callback/${registration.key}?code=synthetic`, {}, env)).status).toBe(400);
    expect((await app.request(`${env.APP_ORIGIN}/oauth/callback/${registration.id}?code=synthetic`, {}, env)).status).toBe(400);
    expect((await app.request(`${env.APP_ORIGIN}/auth/callback?code=synthetic`, {}, env)).status).toBe(404);
  });

  it('returns a safe service error for an invalid registry', async () => {
    const response = await app.request(`${env.APP_ORIGIN}/api/status`, {}, { ...env, CONNECTOR_REGISTRY: '[{"clientSecret":"mistaken-secret"}]' });
    const body = await response.text();
    expect(response.status).toBe(503);
    expect(body).not.toContain('mistaken-secret');
  });

  it('lists thousands of integrations and resolves the last entry without provider-specific code', async () => {
    const records = Array.from({ length: 2000 }, (_, index) => {
      const { key: _key, ...identity } = connectionIdentity(`hospital-${index}`, index + 1);
      return { ...identity, name: `Hospital ${index}`, kind: 'provider',
        clientId: `public-client-${index}`, fhirBaseUrl: `https://hospital-${index}.example/fhir`,
        authorizationUrl: `https://hospital-${index}.example/authorize`, tokenUrl: `https://hospital-${index}.example/token`,
      };
    });
    const settings = withConnectorRegistry({ ...env }, records);
    expect(connectorRegistry(settings)).toBe(connectorRegistry(settings));
    const status = await app.request(`${env.APP_ORIGIN}/api/status`, {}, settings);
    const body = await status.json() as { connectors: unknown[] };
    expect(body.connectors).toHaveLength(2000);
    expect(connectorRedirectUri(settings, 'hospital-1999-patient-access', env.APP_ORIGIN)).toBe(`${env.APP_ORIGIN}/oauth/callback/hospital-1999-patient-access`);
    const authorize = await app.request(`${env.APP_ORIGIN}/api/connectors/hospital-1999-patient-access/authorize`, {}, settings);
    expect(await authorize.json()).toMatchObject({ clientId: 'public-client-1999', audience: 'https://hospital-1999.example/fhir' });
  });
});
