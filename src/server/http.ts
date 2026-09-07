export class AppError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
export async function boundedText(response: Response, limit: number): Promise<string> {
  const length = response.headers.get('content-length');
  if (length && Number(length) > limit) throw new AppError('payload_too_large', 'The response exceeds the safe processing limit.', 413);
  if (!response.body) throw new AppError('empty_response', 'The service returned an empty response.', 502);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) { await reader.cancel(); throw new AppError('payload_too_large', 'The response exceeds the safe processing limit.', 413); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder().decode(bytes);
  } finally { reader.releaseLock(); }
}
export async function boundedJson(response: Response, limit = 4 * 1024 * 1024): Promise<unknown> {
  const text = await boundedText(response, limit);
  try { return JSON.parse(text) as unknown; }
  catch { throw new AppError('invalid_response', 'The service returned invalid JSON.', 502); }
}
export async function readRequest(request: Request, limit = 2 * 1024 * 1024): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new AppError('content_type', 'Send JSON with the application/json content type.', 415);
  try { return await boundedJson(new Response(request.body, { headers: request.headers }), limit); }
  catch (error) {
    if (error instanceof AppError && ['invalid_response', 'empty_response'].includes(error.code)) throw new AppError('invalid_json', 'Send a valid JSON request body.', 400);
    throw error;
  }
}
export async function safeFetch(url: string | URL, options: RequestInit = {}, timeoutMs = 20000): Promise<Response> {
  try {
    return await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  } catch { throw new AppError('upstream_unavailable', 'The connected service did not respond. Please retry.', 502); }
}
