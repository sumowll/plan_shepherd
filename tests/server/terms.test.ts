// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import app from '../../src/server/index';

describe('public Terms and Conditions', () => {
  it.each(['/terms', '/terms/'])('serves %s without authentication, assets or configured integrations', async path => {
    const assetFetch = vi.fn(async () => new Response('SPA fallback'));
    const response = await app.request(`https://app.example.com${path}`, {}, {
      APP_ENV: 'production', APP_ORIGIN: 'https://app.example.com', ASSETS: { fetch: assetFetch },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/html');
    expect(response.headers.get('Strict-Transport-Security')).toContain('max-age=31536000');
    expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Set-Cookie')).toBeNull();
    expect(assetFetch).not.toHaveBeenCalled();

    const document = new DOMParser().parseFromString(await response.text(), 'text/html');
    expect(document.title).toBe('Terms and Conditions · Plan Shepherd');
    expect(document.querySelector('main h1')?.textContent).toBe('Terms and Conditions');
    expect(document.querySelector('time')?.getAttribute('datetime')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(document.querySelector('main')?.textContent).toContain('does not enroll you in insurance');
    expect(document.querySelector('footer a')?.getAttribute('href')).toBe('/coverage');
    expect(document.querySelectorAll('script, iframe, form, link[rel="stylesheet"]')).toHaveLength(0);
  });
});
