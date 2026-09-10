import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { parseEnv } from './dotenv';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const targets = ['development', 'preview', 'production'] as const;
const targetSchema = z.enum(['development', 'preview', 'production']);
export type ConnectorTarget = z.infer<typeof targetSchema>;
export type ConnectorCredentialFiles = Partial<Record<ConnectorTarget, string>>;
export function connectorCredentialPath(target: ConnectorTarget, files: ConnectorCredentialFiles = {}): string {
  return resolve(projectRoot, files[target] ?? (target === 'development' ? '.env' : `.env.secrets.${target}`));
}
function credentialFiles(files: ConnectorCredentialFiles): Record<ConnectorTarget, string> {
  if (Object.entries(files).some(([target, path]) => !targets.includes(target as ConnectorTarget) || typeof path !== 'string' || !path.trim() || path.includes('\0'))) {
    throw new Error('Invalid connector credential file selection.');
  }
  const paths = Object.fromEntries(targets.map(target => [target, connectorCredentialPath(target, files)])) as Record<ConnectorTarget, string>;
  if (new Set(Object.values(paths)).size !== targets.length) throw new Error('Connector credentials require a separate file for each target.');
  return paths;
}
const bindingSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,100}$/);
const valueSchema = z.string().max(16000).refine(value => value.trim().length > 0 && !/[\r\n\0]/.test(value));
const targetListSchema = z.array(targetSchema).min(1).max(3).refine(targets => new Set(targets).size === targets.length);
const credentialSchema = z.strictObject({ targets: targetListSchema, value: valueSchema });
const storeSchema = z.record(bindingSchema, z.array(credentialSchema).min(1).max(3).refine(entries => {
  const targets = entries.flatMap(entry => entry.targets);
  return new Set(targets).size === targets.length;
}));

export type ConnectorCredentials = z.infer<typeof storeSchema>;

/** Never include parser details: credential values may appear in validation issues. */
export function parseConnectorCredentials(input: unknown): ConnectorCredentials {
  const result = storeSchema.safeParse(input);
  if (!result.success) throw new Error('Invalid connector credentials. Use binding names mapped to non-overlapping target groups with nonblank, single-line values.');
  return result.data;
}

function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }

async function fileState(path: string): Promise<Stats | undefined> {
  try {
    const state = await lstat(path);
    if (!state.isFile() || state.isSymbolicLink()) throw new Error('Connector credentials must be a regular file, not a symlink.');
    return state;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function sameFileState(before: Stats | undefined, after: Stats | undefined): boolean {
  if (!before || !after) return before === after;
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

type FileSnapshot = { path: string; state?: Stats; contents: string };

async function readCredentialFile(path: string): Promise<FileSnapshot> {
  const before = await fileState(path);
  if (!before) return { path, contents: '' };
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const state = await file.stat();
    if (!state.isFile()) throw new Error('Connector credentials must be a regular file.');
    if (state.mode & 0o077) throw new Error('Connector credentials permissions must prevent access by other users; use chmod 600.');
    const contents = await file.readFile('utf8');
    if (!sameFileState(before, state) || !sameFileState(state, await fileState(path))) {
      throw new Error('Connector credentials changed while being read. Reload before saving.');
    }
    return { path, state, contents };
  } finally { await file.close(); }
}

function credentialValues(contents: string, allowedBindings: string[]): Record<string, string> {
  let env: Record<string, string>;
  try { env = parseEnv(contents); }
  catch { throw new Error('Connector credentials must contain valid single-line dotenv assignments.'); }
  const allowed = new Set(allowedBindings);
  const result = Object.fromEntries(Object.entries(env).filter(([binding, value]) =>
    value.trim() && (allowed.has(binding) || /(?:^|_)CLIENT_(?:ID|SECRET)$/.test(binding))));
  for (const [binding, value] of Object.entries(result)) {
    if (!bindingSchema.safeParse(binding).success || !valueSchema.safeParse(value).success) {
      throw new Error('Invalid connector credentials. Check the binding names and single-line values.');
    }
  }
  return result;
}

/** Read each target's private dotenv file without falling back to another target. */
export async function loadConnectorCredentials(files: ConnectorCredentialFiles = {}, allowedBindings: string[] = [], selectedTargets: readonly ConnectorTarget[] = targets): Promise<ConnectorCredentials> {
  const paths = credentialFiles(files);
  const selected = targetListSchema.safeParse(selectedTargets);
  if (!selected.success) throw new Error('Invalid connector credential target selection.');
  let store: ConnectorCredentials = {};
  try {
    for (const target of selected.data) {
      const snapshot = await readCredentialFile(paths[target]);
      for (const [binding, value] of Object.entries(credentialValues(snapshot.contents, allowedBindings))) {
        store = upsertConnectorCredential(store, binding, [target], value);
      }
    }
    return store;
  } catch (error) {
    if (error instanceof Error && /^(?:Connector credentials|Invalid connector credential)/.test(error.message)) throw error;
    throw new Error('Unable to read connector credentials. Check the selected dotenv files and permissions.');
  }
}

/** No cross-target fallback and no implicit exposure of inactive credential bindings. */
export function selectConnectorCredentials(store: ConnectorCredentials, target: ConnectorTarget, allowedBindings: string[]): Record<string, string> {
  const parsed = parseConnectorCredentials(store);
  if (!targetSchema.safeParse(target).success || !z.array(bindingSchema).safeParse(allowedBindings).success) {
    throw new Error('Invalid connector credential target or binding allowlist.');
  }
  const allowed = new Set(allowedBindings);
  return Object.fromEntries(Object.entries(parsed).flatMap(([binding, entries]) => {
    if (!allowed.has(binding)) return [];
    const match = entries.find(entry => entry.targets.includes(target));
    return match ? [[binding, match.value]] : [];
  }));
}

/** Replacing selected targets leaves every other binding and target untouched. */
export function upsertConnectorCredential(store: ConnectorCredentials, binding: string, targets: ConnectorTarget[], value: string): ConnectorCredentials {
  const parsed = parseConnectorCredentials(store);
  if (!bindingSchema.safeParse(binding).success || !targetListSchema.safeParse(targets).success || !valueSchema.safeParse(value).success) {
    throw new Error('Invalid connector credential update. Check the binding, targets, and single-line value.');
  }
  const replaced = new Set(targets);
  const entries = (parsed[binding] ?? []).map(entry => ({ ...entry, targets: entry.targets.filter(target => !replaced.has(target)) }))
    .filter(entry => entry.targets.length > 0);
  entries.push({ targets: [...targets], value });
  const coalesced: typeof entries = [];
  for (const entry of entries) {
    const existing = coalesced.find(group => group.value === entry.value);
    if (existing) existing.targets.push(...entry.targets);
    else coalesced.push({ targets: [...entry.targets], value: entry.value });
  }
  parsed[binding] = coalesced;
  return parseConnectorCredentials(parsed);
}

function comparableValues(values: Record<string, string>): string {
  return JSON.stringify(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)));
}

/** Keep comments, blank lines, retired bindings and unrelated settings byte-for-byte. */
function updateDotenv(contents: string, updates: Record<string, string>): string {
  const pending = new Map(Object.entries(updates));
  const newline = contents.includes('\r\n') ? '\r\n' : '\n';
  let result = contents.split(/(?<=\n)/).map(line => {
    const match = /^(\s*(?:export\s+)?([A-Z][A-Z0-9_]*)=)[^\r\n]*(\r?\n)?$/.exec(line);
    if (!match || updates[match[2]] === undefined) return line;
    pending.delete(match[2]);
    return `${match[1]}${JSON.stringify(updates[match[2]])}${match[3] ?? ''}`;
  }).join('');
  for (const [binding, value] of pending) {
    if (result && !result.endsWith('\n')) result += newline;
    result += `${binding}=${JSON.stringify(value)}${newline}`;
  }
  return result;
}

async function temporaryFile(path: string, contents: string): Promise<string> {
  const temporary = join(dirname(path), `.connector-credentials-${randomUUID()}.tmp`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await file.chmod(0o600);
    await file.writeFile(contents, 'utf8');
    await file.sync();
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  } finally { await file.close(); }
  return temporary;
}

type WrittenFile = { before: FileSnapshot; contents: string; state?: Stats };

/** Restore exact previous bytes only while the written file has not changed. */
async function restoreFiles(written: WrittenFile[]): Promise<void> {
  let failed = false;
  for (let index = written.length - 1; index >= 0; index--) {
    const update = written[index];
    let temporary: string | undefined;
    try {
      const current = await readCredentialFile(update.before.path);
      if (!current.state || current.contents !== update.contents || update.state && !sameFileState(current.state, update.state)) {
        throw new Error('Concurrent edit');
      }
      if (update.before.state) temporary = await temporaryFile(update.before.path, update.before.contents);
      if (!sameFileState(current.state, await fileState(update.before.path))) throw new Error('Concurrent edit');
      if (temporary) { await rename(temporary, update.before.path); temporary = undefined; }
      else await unlink(update.before.path);
      written.splice(index, 1);
    } catch { failed = true; }
    finally { if (temporary) await unlink(temporary).catch(() => undefined); }
  }
  if (failed) throw new Error('Connector credentials changed concurrently and could not be restored. Review the selected dotenv files before retrying.');
}

/** Update only supplied changes. Missing/retired keys are preserved; the returned rollback restores exact prior files. */
export async function saveConnectorCredentials(store: ConnectorCredentials, files: ConnectorCredentialFiles = {}, options: {
  expected?: ConnectorCredentials; allowedBindings?: string[]; targets?: ConnectorTarget[];
} = {}): Promise<() => Promise<void>> {
  const parsed = parseConnectorCredentials(store);
  const expected = options.expected === undefined ? undefined : parseConnectorCredentials(options.expected);
  const paths = credentialFiles(files);
  const selected = targetListSchema.safeParse(options.targets ?? targets);
  if (!selected.success) throw new Error('Invalid connector credential target selection.');
  const bindings = [...new Set([...Object.keys(parsed), ...Object.keys(expected ?? {}), ...(options.allowedBindings ?? [])])];
  const checked: FileSnapshot[] = [];
  const prepared: { before: FileSnapshot; contents: string; temporary?: string }[] = [];
  const written: WrittenFile[] = [];
  try {
    for (const target of selected.data) {
      const next = selectConnectorCredentials(parsed, target, bindings);
      const previous = expected === undefined ? undefined : selectConnectorCredentials(expected, target, bindings);
      const updates = Object.fromEntries(Object.entries(next).filter(([binding, value]) => previous?.[binding] !== value));
      if (!Object.keys(updates).length && previous === undefined) continue;
      const path = paths[target];
      const parent = dirname(path);
      await mkdir(parent, { recursive: true, mode: 0o700 });
      if ((await lstat(parent)).isSymbolicLink()) throw new Error('Connector credentials directory must not be a symlink.');
      const before = await readCredentialFile(path);
      const existing = credentialValues(before.contents, bindings);
      if (previous !== undefined && comparableValues(existing) !== comparableValues(previous)) {
        throw new Error('Connector credentials changed since they were loaded. Reload before saving.');
      }
      checked.push(before);
      if (!Object.keys(updates).length) continue;
      const contents = updateDotenv(before.contents, updates);
      if (contents === before.contents) continue;
      prepared.push({ before, contents, temporary: await temporaryFile(path, contents) });
    }
    for (const snapshot of checked) {
      if (!sameFileState(snapshot.state, await fileState(snapshot.path))) throw new Error('Connector credentials changed during the update. Reload before saving.');
    }
    for (const update of prepared) {
      if (!sameFileState(update.before.state, await fileState(update.before.path))) throw new Error('Connector credentials changed during the update. Reload before saving.');
      await rename(update.temporary!, update.before.path);
      update.temporary = undefined;
      const committed: WrittenFile = { before: update.before, contents: update.contents };
      written.push(committed);
      const current = await readCredentialFile(update.before.path);
      if (current.contents !== update.contents) throw new Error('Connector credentials changed during the update. Reload before saving.');
      committed.state = current.state;
    }
    return () => restoreFiles(written);
  } catch (error) {
    await restoreFiles(written);
    if (error instanceof Error && /^(?:Connector credentials|Invalid connector credential)/.test(error.message)) throw error;
    throw new Error('Unable to save connector credentials. Check the selected dotenv files and permissions.');
  } finally {
    for (const update of prepared) if (update.temporary) await unlink(update.temporary).catch(() => undefined);
  }
}
