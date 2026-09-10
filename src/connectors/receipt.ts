import { z } from 'zod';
import { AppError } from '../server/http';
import { connectorIdSchema } from '../shared/connectors';
const encode = (data: Uint8Array) => btoa(String.fromCharCode(...data)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const decode = (data: string) => Uint8Array.from(atob(data.replace(/-/g, '+').replace(/_/g, '/')), x => x.charCodeAt(0));
const schema = z.object({ connector: connectorIdSchema, patientId: z.string().max(250), tokenHash: z.string(), expiresAt: z.number().int(), nonce: z.string() }).strict();
async function key(secret: string) {
  if (secret.length < 32) throw new AppError('signing_unconfigured', 'The secure connection is not configured.', 503);
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign','verify']);
}
const hash = async (token: string) => encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))));
export async function signReceipt(secret: string, connector: string, patientId: string, token: string, expiresIn: number): Promise<string> {
  const value = schema.parse({ connector, patientId, tokenHash: await hash(token), expiresAt: Date.now() + Math.min(expiresIn, 1800) * 1000, nonce: crypto.randomUUID() });
  const payload = encode(new TextEncoder().encode(JSON.stringify(value)));
  const signature = await crypto.subtle.sign('HMAC', await key(secret), new TextEncoder().encode(payload));
  return `${payload}.${encode(new Uint8Array(signature))}`;
}
export async function verifyReceipt(secret: string, receipt: string, connector: string, patientId: string, token: string): Promise<void> {
  try {
    const connectionId = connectorIdSchema.parse(connector);
    const parts = receipt.split('.');
    if (parts.length !== 2 || parts.some(x => !/^[A-Za-z0-9_-]+$/.test(x))) throw new Error();
    if (!await crypto.subtle.verify('HMAC', await key(secret), decode(parts[1]), new TextEncoder().encode(parts[0]))) throw new Error();
    const data = schema.parse(JSON.parse(new TextDecoder().decode(decode(parts[0]))));
    if (data.connector !== connectionId || data.patientId !== patientId || data.expiresAt <= Date.now() || data.tokenHash !== await hash(token)) throw new Error();
  } catch { throw new AppError('invalid_session', 'The patient authorization does not match this request or has expired. Reconnect to continue.', 401); }
}
const referenceSchema = z.object({ connector: connectorIdSchema, patientId: z.string(), tokenHash: z.string(), reference: z.string().max(2000), expiresAt: z.number() }).strict();
export async function signReference(secret: string, connector: string, patientId: string, token: string, reference: string): Promise<string> {
  const value = referenceSchema.parse({ connector, patientId, tokenHash: await hash(token), reference, expiresAt: Date.now() + 5 * 60000 });
  const payload = encode(new TextEncoder().encode(JSON.stringify(value)));
  const signature = await crypto.subtle.sign('HMAC', await key(secret), new TextEncoder().encode(`reference:${payload}`));
  return `${payload}.${encode(new Uint8Array(signature))}`;
}
export async function verifyReference(secret: string, capability: string, connector: string, patientId: string, token: string, reference: string): Promise<void> {
  try {
    const connectionId = connectorIdSchema.parse(connector);
    const parts = capability.split('.');
    if (parts.length !== 2 || parts.some(x => !/^[A-Za-z0-9_-]+$/.test(x))) throw new Error();
    if (!await crypto.subtle.verify('HMAC', await key(secret), decode(parts[1]), new TextEncoder().encode(`reference:${parts[0]}`))) throw new Error();
    const value = referenceSchema.parse(JSON.parse(new TextDecoder().decode(decode(parts[0]))));
    if (value.reference !== reference || value.connector !== connectionId || value.patientId !== patientId || value.tokenHash !== await hash(token) || value.expiresAt <= Date.now()) throw new Error();
  } catch { throw new AppError('invalid_reference', 'The reference was not authorized by an imported record. Reconnect to continue.', 401); }
}
