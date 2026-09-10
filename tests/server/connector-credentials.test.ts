import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, lstat, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  connectorCredentialPath, loadConnectorCredentials, parseConnectorCredentials,
  saveConnectorCredentials, selectConnectorCredentials, upsertConnectorCredential, type ConnectorCredentialFiles,
} from '../../scripts/connector-credentials';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, lstat: vi.fn(actual.lstat), rename: vi.fn(actual.rename) };
});

const directories: string[] = [];
async function fixtureDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'plan-shepherd-credentials-'));
  directories.push(path);
  return path;
}
function targetFiles(root: string): Record<'development' | 'preview' | 'production', string> {
  return { development: join(root, '.env'), preview: join(root, '.env.secrets.preview'), production: join(root, '.env.secrets.production') };
}
afterEach(async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(lstat).mockImplementation(actual.lstat);
  vi.mocked(rename).mockImplementation(actual.rename);
  vi.clearAllMocks();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('connector credential store', () => {
  it('selects only the requested target and active bindings with no fallback', () => {
    const store = parseConnectorCredentials({
      SHARED_CLIENT_ID: [{ targets: ['development', 'preview'], value: 'shared' }, { targets: ['production'], value: 'production' }],
      PREVIEW_SECRET: [{ targets: ['preview'], value: 'preview-only' }],
      RETIRED_CLIENT_ID: [{ targets: ['production'], value: 'retired' }],
    });
    expect(selectConnectorCredentials(store, 'production', ['SHARED_CLIENT_ID', 'PREVIEW_SECRET', 'MISSING_CLIENT_ID'])).toEqual({ SHARED_CLIENT_ID: 'production' });
    expect(selectConnectorCredentials(store, 'development', ['SHARED_CLIENT_ID', 'PREVIEW_SECRET'])).toEqual({ SHARED_CLIENT_ID: 'shared' });
    expect(selectConnectorCredentials(store, 'preview', ['SHARED_CLIENT_ID', 'PREVIEW_SECRET'])).toEqual({ SHARED_CLIENT_ID: 'shared', PREVIEW_SECRET: 'preview-only' });
    expect(selectConnectorCredentials(store, 'production', [])).toEqual({});
  });

  it('preserves exact nonblank values without trimming or mutating input', () => {
    const input = { CLIENT_ID: [{ targets: ['preview'], value: ' synthetic secret with spaces ' }] };
    const store = parseConnectorCredentials(input);
    expect(selectConnectorCredentials(store, 'preview', ['CLIENT_ID'])).toEqual({ CLIENT_ID: input.CLIENT_ID[0].value });
    store.CLIENT_ID[0].targets.push('production');
    expect(input.CLIENT_ID[0].targets).toEqual(['preview']);
  });

  it.each([
    null,
    [],
    { CLIENT_ID: 'synthetic-secret' },
    { 'invalid-binding-synthetic-secret': [{ targets: ['preview'], value: 'synthetic-secret' }] },
    { CLIENT_ID: [] },
    { CLIENT_ID: [{ targets: [], value: 'synthetic-secret' }] },
    { CLIENT_ID: [{ targets: ['staging'], value: 'synthetic-secret' }] },
    { CLIENT_ID: [{ targets: ['preview', 'preview'], value: 'synthetic-secret' }] },
    { CLIENT_ID: [{ targets: ['preview'], value: 'synthetic-secret' }, { targets: ['preview', 'production'], value: 'other' }] },
    { CLIENT_ID: [{ targets: ['preview'], value: '' }] },
    { CLIENT_ID: [{ targets: ['preview'], value: ' \t ' }] },
    { CLIENT_ID: [{ targets: ['preview'], value: 'synthetic-secret\nline' }] },
    { CLIENT_ID: [{ targets: ['preview'], value: 'synthetic-secret\rline' }] },
    { CLIENT_ID: [{ targets: ['preview'], value: 'synthetic-secret\0line' }] },
    { CLIENT_ID: [{ targets: ['preview'], value: 'x'.repeat(16001) }] },
    { CLIENT_ID: [{ targets: ['preview'], value: 'synthetic-secret', extra: 'synthetic-secret' }] },
    { CLIENT_ID: [{ targets: ['preview'], value: 123 }] },
  ])('rejects invalid credentials with a value-free error (%#)', input => {
    let message = '';
    try { parseConnectorCredentials(input); } catch (error) { message = (error as Error).message; }
    expect(message).toMatch(/^Invalid connector credentials/);
    expect(message).not.toContain('synthetic-secret');
    expect(message).not.toContain('invalid-binding');
  });

  it('replaces selected targets, preserves others, and coalesces equal values', () => {
    const original = parseConnectorCredentials({
      CLIENT_ID: [{ targets: ['development', 'preview'], value: 'old' }, { targets: ['production'], value: 'new' }],
      OTHER_SECRET: [{ targets: ['preview'], value: 'other' }],
    });
    const updated = upsertConnectorCredential(original, 'CLIENT_ID', ['preview'], 'new');
    expect(updated).toEqual({
      CLIENT_ID: [{ targets: ['development'], value: 'old' }, { targets: ['production', 'preview'], value: 'new' }],
      OTHER_SECRET: [{ targets: ['preview'], value: 'other' }],
    });
    expect(original.CLIENT_ID[0]).toEqual({ targets: ['development', 'preview'], value: 'old' });
    const replaced = upsertConnectorCredential(updated, 'CLIENT_ID', ['development', 'preview', 'production'], 'replacement');
    expect(replaced.CLIENT_ID).toEqual([{ targets: ['development', 'preview', 'production'], value: 'replacement' }]);
    expect(upsertConnectorCredential({}, 'NEW_CLIENT_ID', ['production'], 'new')).toEqual({ NEW_CLIENT_ID: [{ targets: ['production'], value: 'new' }] });
  });

  it('validates updates and selectors even when TypeScript is bypassed', () => {
    expect(() => upsertConnectorCredential({}, 'invalid-synthetic-secret', ['preview'], 'secret')).toThrow(/^Invalid connector credential update/);
    expect(() => upsertConnectorCredential({}, 'CLIENT_ID', [], 'secret')).toThrow(/^Invalid connector credential update/);
    expect(() => upsertConnectorCredential({}, 'CLIENT_ID', ['preview'], '\nsecret')).toThrow(/^Invalid connector credential update/);
    expect(() => selectConnectorCredentials({}, 'staging' as never, [])).toThrow(/^Invalid connector credential target/);
    expect(() => selectConnectorCredentials({}, 'preview', ['invalid'])).toThrow(/^Invalid connector credential target/);
  });

  it('treats missing default target files as empty without reading real credentials', async () => {
    vi.mocked(lstat).mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOENT' }));
    await expect(loadConnectorCredentials()).resolves.toEqual({});
    for (const target of ['development', 'preview', 'production'] as const) expect(lstat).toHaveBeenCalledWith(connectorCredentialPath(target));
  });

  it('allows new target files and saves credentials to separate private dotenv files', async () => {
    const root = join(await fixtureDirectory(), 'private');
    const files = targetFiles(root);
    expect(await loadConnectorCredentials(files)).toEqual({});
    const store = upsertConnectorCredential({}, 'CLIENT_ID', ['development', 'preview'], 'synthetic-client');
    await saveConnectorCredentials(store, files, { expected: {} });
    expect(await loadConnectorCredentials(files)).toEqual(store);
    expect((await stat(files.preview)).mode & 0o777).toBe(0o600);
    expect(await readFile(files.preview, 'utf8')).toBe('CLIENT_ID="synthetic-client"\n');
    expect((await readdir(root)).sort()).toEqual(['.env', '.env.secrets.preview']);
    const updated = upsertConnectorCredential(store, 'CLIENT_ID', ['production'], 'production-client');
    await saveConnectorCredentials(updated, files, { expected: store });
    expect(await loadConnectorCredentials(files)).toEqual(updated);
  });

  it('loads custom registry bindings and standard retired bindings while excluding app settings', async () => {
    const files = targetFiles(await fixtureDirectory());
    await writeFile(files.preview, '# Preview\nSESSION_SIGNING_KEY=app-secret\nNORTH_PRIVATE_KEY=custom-secret\nRETIRED_CLIENT_SECRET=saved-retired\nNORTH_CLIENT_ID=preview-client\nEMPTY_CLIENT_SECRET=\n', { mode: 0o600 });
    await writeFile(files.production, 'NORTH_CLIENT_ID=production-client\n', { mode: 0o600 });
    const loaded = await loadConnectorCredentials(files, ['NORTH_PRIVATE_KEY']);
    expect(selectConnectorCredentials(loaded, 'preview', Object.keys(loaded))).toEqual({ NORTH_PRIVATE_KEY: 'custom-secret', RETIRED_CLIENT_SECRET: 'saved-retired', NORTH_CLIENT_ID: 'preview-client' });
    expect(selectConnectorCredentials(loaded, 'production', Object.keys(loaded))).toEqual({ NORTH_CLIENT_ID: 'production-client' });
    expect(loaded).not.toHaveProperty('SESSION_SIGNING_KEY');
  });

  it('reads and checks only the selected target even when the other paths are inaccessible', async () => {
    const files = targetFiles(await fixtureDirectory());
    await writeFile(files.preview, 'CLIENT_ID=preview-client\n', { mode: 0o600 });
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(lstat).mockImplementation(async (...args) => {
      if (args[0] === files.development || args[0] === files.production) throw new Error('Other target must not be read');
      return actual.lstat(...args);
    });
    const expected = await loadConnectorCredentials(files, [], ['preview']);
    expect(expected).toEqual({ CLIENT_ID: [{ targets: ['preview'], value: 'preview-client' }] });
    await saveConnectorCredentials(expected, files, { expected, targets: ['preview'] });
    expect(lstat).not.toHaveBeenCalledWith(files.development);
    expect(lstat).not.toHaveBeenCalledWith(files.production);
  });

  it('updates only selected targets and preserves comments, unrelated app settings and retired bindings exactly', async () => {
    const files = targetFiles(await fixtureDirectory());
    const preview = '# Keep this comment\r\nSESSION_SIGNING_KEY=app-secret\r\n\r\nexport NORTH_PRIVATE_KEY=old-secret\r\nRETIRED_CLIENT_ID=retired\r\nUNRELATED=unchanged';
    await writeFile(files.preview, preview, { mode: 0o600 });
    await writeFile(files.development, '# Development\nNORTH_PRIVATE_KEY=development-secret\n', { mode: 0o600 });
    await writeFile(files.production, '# Production\nNORTH_PRIVATE_KEY=production-secret\n', { mode: 0o600 });
    const before = await Promise.all([stat(files.development), stat(files.production)]);
    const expected = await loadConnectorCredentials(files, ['NORTH_PRIVATE_KEY']);
    const updated = upsertConnectorCredential(expected, 'NORTH_PRIVATE_KEY', ['preview'], 'new-secret');
    await saveConnectorCredentials(updated, files, { expected, allowedBindings: ['NORTH_PRIVATE_KEY'] });
    expect(await readFile(files.preview, 'utf8')).toBe(preview.replace('NORTH_PRIVATE_KEY=old-secret', 'NORTH_PRIVATE_KEY="new-secret"'));
    expect(await readFile(files.development, 'utf8')).toBe('# Development\nNORTH_PRIVATE_KEY=development-secret\n');
    expect(await readFile(files.production, 'utf8')).toBe('# Production\nNORTH_PRIVATE_KEY=production-secret\n');
    expect((await stat(files.development)).ino).toBe(before[0].ino);
    expect((await stat(files.production)).ino).toBe(before[1].ino);
    expect((await stat(files.preview)).mode & 0o777).toBe(0o600);
  });

  it('preserves omitted credentials and does not rewrite unchanged target files', async () => {
    const files = targetFiles(await fixtureDirectory());
    const contents = '# Saved\nCLIENT_ID=existing\nRETIRED_PRIVATE_KEY=keep-this\n';
    await writeFile(files.preview, contents, { mode: 0o600 });
    const before = await stat(files.preview);
    const loaded = await loadConnectorCredentials(files);
    await saveConnectorCredentials(loaded, files, { expected: loaded });
    await saveConnectorCredentials({}, files);
    expect(await readFile(files.preview, 'utf8')).toBe(contents);
    expect((await stat(files.preview)).ino).toBe(before.ino);
  });

  it('refuses stale credential updates in the changed target and leaves no temporary files', async () => {
    const root = await fixtureDirectory();
    const files = targetFiles(root);
    const original = upsertConnectorCredential({}, 'CLIENT_ID', ['preview'], 'original');
    await saveConnectorCredentials(original, files);
    const loaded = await loadConnectorCredentials(files);
    const concurrent = upsertConnectorCredential(original, 'CLIENT_ID', ['preview'], 'concurrent');
    await saveConnectorCredentials(concurrent, files);
    await expect(saveConnectorCredentials(upsertConnectorCredential(loaded, 'CLIENT_ID', ['preview'], 'edited'), files, { expected: loaded }))
      .rejects.toThrow('changed since they were loaded');
    expect(await loadConnectorCredentials(files)).toEqual(concurrent);
    expect(await readdir(root)).toEqual(['.env.secrets.preview']);
  });

  it('keeps unrelated app edits made after loading and credentials changed in another target', async () => {
    const files = targetFiles(await fixtureDirectory());
    await writeFile(files.preview, 'CLIENT_ID=old\nAPP_SETTING=old\n', { mode: 0o600 });
    const expected = await loadConnectorCredentials(files);
    await writeFile(files.preview, 'CLIENT_ID=old\nAPP_SETTING=concurrent\n', { mode: 0o600 });
    await writeFile(files.production, 'CLIENT_ID=concurrent-production\n', { mode: 0o600 });
    await saveConnectorCredentials(upsertConnectorCredential(expected, 'CLIENT_ID', ['preview'], 'updated'), files, { expected, targets: ['preview'] });
    expect(await readFile(files.preview, 'utf8')).toBe('CLIENT_ID="updated"\nAPP_SETTING=concurrent\n');
    expect(await readFile(files.production, 'utf8')).toBe('CLIENT_ID=concurrent-production\n');
  });

  it('rolls back exact previous bytes and removes only files created by the update', async () => {
    const files = targetFiles(await fixtureDirectory());
    const original = '# No trailing newline\nCLIENT_ID=old';
    await writeFile(files.preview, original, { mode: 0o600 });
    const expected = await loadConnectorCredentials(files);
    const updated = upsertConnectorCredential(expected, 'CLIENT_ID', ['preview', 'production'], 'new');
    const restore = await saveConnectorCredentials(updated, files, { expected });
    await restore();
    expect(await readFile(files.preview, 'utf8')).toBe(original);
    await expect(stat(files.production)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rolls back earlier target writes if a later target commit fails', async () => {
    const files = targetFiles(await fixtureDirectory());
    const original = '# Preview\nCLIENT_ID=old\n';
    await writeFile(files.preview, original, { mode: 0o600 });
    const expected = await loadConnectorCredentials(files);
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (to === files.production) throw new Error('Synthetic commit failure');
      return actual.rename(from, to);
    });
    await expect(saveConnectorCredentials(upsertConnectorCredential(expected, 'CLIENT_ID', ['preview', 'production'], 'new'), files, { expected })).rejects.toThrow('Unable to save');
    expect(await readFile(files.preview, 'utf8')).toBe(original);
    expect(await readdir(join(files.preview, '..'))).toEqual(['.env.secrets.preview']);
  });

  it('refuses rollback over a concurrent app-setting edit', async () => {
    const files = targetFiles(await fixtureDirectory());
    const restore = await saveConnectorCredentials(upsertConnectorCredential({}, 'CLIENT_ID', ['preview'], 'saved'), files);
    const concurrent = 'CLIENT_ID="saved"\nSESSION_SIGNING_KEY=concurrent-app-secret\n';
    await writeFile(files.preview, concurrent, { mode: 0o600 });
    await expect(restore()).rejects.toThrow('changed concurrently');
    expect(await readFile(files.preview, 'utf8')).toBe(concurrent);
  });

  it('rejects readable-by-others files without changing their values', async () => {
    const files = targetFiles(await fixtureDirectory());
    const contents = 'CLIENT_ID=synthetic-secret\n';
    await writeFile(files.preview, contents, { mode: 0o600 });
    await chmod(files.preview, 0o644);
    await expect(loadConnectorCredentials(files)).rejects.toThrow('chmod 600');
    await expect(saveConnectorCredentials(upsertConnectorCredential({}, 'CLIENT_ID', ['preview'], 'new'), files)).rejects.toThrow('chmod 600');
    expect(await readFile(files.preview, 'utf8')).toBe(contents);
  });

  it('rejects symlink files and directories without modifying their targets', async () => {
    const root = await fixtureDirectory();
    const files = targetFiles(root);
    const original = join(root, 'original.env');
    await writeFile(original, '# Original\n', { mode: 0o600 });
    await symlink(original, files.preview);
    const store = upsertConnectorCredential({}, 'CLIENT_ID', ['preview'], 'new');
    await expect(loadConnectorCredentials(files)).rejects.toThrow('not a symlink');
    await expect(saveConnectorCredentials(store, files)).rejects.toThrow('not a symlink');
    expect(await readFile(original, 'utf8')).toBe('# Original\n');
    const linked = join(root, 'linked');
    await symlink(await fixtureDirectory(), linked);
    await expect(saveConnectorCredentials(store, { ...files, preview: join(linked, '.env') })).rejects.toThrow('directory must not be a symlink');
  });

  it('rejects using the same file for multiple targets before reading any file', async () => {
    const files = targetFiles(await fixtureDirectory());
    const shared: ConnectorCredentialFiles = { ...files, production: files.preview };
    await expect(loadConnectorCredentials(shared)).rejects.toThrow('separate file for each target');
    expect(lstat).not.toHaveBeenCalled();
  });

  it('never exposes malformed dotenv contents', async () => {
    const files = targetFiles(await fixtureDirectory());
    await writeFile(files.preview, 'malformed synthetic-secret', { mode: 0o600 });
    const error = await loadConnectorCredentials(files).catch(error => error as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Connector credentials must contain valid single-line dotenv assignments.');
  });
});
