import { describe, expect, it, vi } from 'vitest';
import app from '../../src/server/index';

const origin = 'https://app.example.com';

describe('production asset responses', () => {
  it.each(['/', '/coverage', '/assets/missing.js'])('keeps HTML at %s private and applies browser protections', async path => {
    const html = '<!doctype html><title>Plan Shepherd</title>';
    const fetch = vi.fn(async () => new Response(html, {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=60', ETag: '"html-version"' },
    }));
    const response = await app.request(`${origin}${path}`, {}, { APP_ENV: 'production', APP_ORIGIN: origin, ASSETS: { fetch } });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(html);
    expect(fetch).toHaveBeenCalledOnce();
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('ETag')).toBe('"html-version"');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Pragma')).toBe('no-cache');
    expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
    expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('Strict-Transport-Security')).toBe('max-age=31536000; includeSubDomains');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
  });

  it('preserves immutable caching, body and metadata for a bundled code asset', async () => {
    const code = 'export const ready = true;';
    const response = await app.request(`${origin}/assets/index-A1B2C3D4.js`, {}, {
      APP_ENV: 'production', APP_ORIGIN: origin,
      ASSETS: { fetch: async () => new Response(code, { headers: { 'Content-Type': 'application/javascript', ETag: '"asset-version"' } }) },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(code);
    expect(response.headers.get('Content-Type')).toBe('application/javascript');
    expect(response.headers.get('ETag')).toBe('"asset-version"');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(response.headers.get('Pragma')).toBeNull();
    expect(response.headers.get('Strict-Transport-Security')).toBe('max-age=31536000; includeSubDomains');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('preserves asset errors without marking them immutable', async () => {
    const response = await app.request(`${origin}/assets/missing.js`, {}, {
      APP_ENV: 'production', APP_ORIGIN: origin,
      ASSETS: { fetch: async () => new Response('Missing asset', { status: 404, statusText: 'Not Found', headers: { 'Content-Type': 'text/plain' } }) },
    });

    expect(response.status).toBe(404);
    expect(response.statusText).toBe('Not Found');
    expect(await response.text()).toBe('Missing asset');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});
