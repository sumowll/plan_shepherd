// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSession, initPrivacy, releaseController, sessionController, sessionGeneration } from '../../src/client/privacy';

const start = new Date('2026-09-06T12:00:00Z');
let dispose: () => void;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(start); dispose = initPrivacy(); });
afterEach(() => { dispose(); clearSession(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('memory session lifecycle', () => {
  it('clears and aborts active requests at 30 minutes of idle time', () => {
    const initial = sessionGeneration(); const pending = sessionController();
    vi.advanceTimersByTime(30 * 60_000 - 1);
    expect(pending.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(pending.signal.aborted).toBe(true); expect(sessionGeneration()).toBe(initial + 1);
  });

  it.each(['pointerdown', 'keydown'])('checks expired idle time before %s can revive a throttled background session', event => {
    const initial = sessionGeneration(); const pending = sessionController();
    // Move the clock without executing the interval, as happens in a suspended tab.
    vi.setSystemTime(new Date(start.getTime() + 31 * 60_000));
    window.dispatchEvent(new Event(event));
    expect(pending.signal.aborted).toBe(true); expect(sessionGeneration()).toBe(initial + 1);
  });

  it.each(['focus', 'visibilitychange'])('checks an expired session when returning through %s', event => {
    const pending = sessionController();
    vi.setSystemTime(new Date(start.getTime() + 31 * 60_000));
    if (event === 'visibilitychange') {
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
      document.dispatchEvent(new Event(event));
    } else window.dispatchEvent(new Event(event));
    expect(pending.signal.aborted).toBe(true);
  });

  it('enforces the two-hour absolute lifetime despite continued activity', () => {
    const initial = sessionGeneration(); const pending = sessionController();
    for (let minutes = 20; minutes < 120; minutes += 20) {
      vi.setSystemTime(new Date(start.getTime() + minutes * 60_000));
      window.dispatchEvent(new Event('keydown'));
      expect(pending.signal.aborted).toBe(false);
    }
    vi.setSystemTime(new Date(start.getTime() + 120 * 60_000));
    window.dispatchEvent(new Event('keydown'));
    expect(pending.signal.aborted).toBe(true); expect(sessionGeneration()).toBe(initial + 1);
  });

  it('clears on pagehide and on restoration from the back-forward cache', () => {
    const first = sessionController(); window.dispatchEvent(new Event('pagehide'));
    expect(first.signal.aborted).toBe(true);
    const second = sessionController(); const restored = new Event('pageshow');
    Object.defineProperty(restored, 'persisted', { value: true }); window.dispatchEvent(restored);
    expect(second.signal.aborted).toBe(true);
  });

  it('releases completed requests and removes lifecycle listeners when disposed', () => {
    const completed = sessionController(); releaseController(completed);
    clearSession(); expect(completed.signal.aborted).toBe(false);
    dispose(); const initial = sessionGeneration();
    window.dispatchEvent(new Event('pagehide')); vi.advanceTimersByTime(31 * 60_000);
    expect(sessionGeneration()).toBe(initial);
  });
});
