const CLEAR_EVENT = 'plan-shepherd:clear-session';
let generation = 0;
const active = new Set<AbortController>();
export function sessionGeneration(): number { return generation; }
export function clearSession(): void {
  generation += 1;
  for (const controller of active) controller.abort();
  active.clear();
  window.dispatchEvent(new CustomEvent(CLEAR_EVENT));
}
export function sessionController(): AbortController {
  const controller = new AbortController(); active.add(controller);
  controller.signal.addEventListener('abort', () => active.delete(controller), { once: true });
  return controller;
}
export function releaseController(controller: AbortController): void { active.delete(controller); }
export function initPrivacy(): () => void {
  let lastActivity = Date.now(); let started = Date.now();
  const expired = () => Date.now() - lastActivity >= 30 * 60_000 || Date.now() - started >= 2 * 60 * 60_000;
  const activity = () => { if (expired()) clearSession(); lastActivity = Date.now(); };
  const cleared = () => { started = Date.now(); lastActivity = started; };
  const pagehide = () => clearSession();
  const pageshow = (event: PageTransitionEvent) => { if (event.persisted) clearSession(); };
  const check = () => {
    if (expired()) clearSession();
  };
  const visible = () => { if (document.visibilityState === 'visible') check(); };
  window.addEventListener('pointerdown', activity); window.addEventListener('keydown', activity);
  window.addEventListener(CLEAR_EVENT, cleared); window.addEventListener('pagehide', pagehide); window.addEventListener('pageshow', pageshow);
  window.addEventListener('focus', check); document.addEventListener('visibilitychange', visible);
  const timer = window.setInterval(check, 15000);
  return () => { window.clearInterval(timer); window.removeEventListener('pointerdown', activity); window.removeEventListener('keydown', activity); window.removeEventListener(CLEAR_EVENT, cleared); window.removeEventListener('pagehide', pagehide); window.removeEventListener('pageshow', pageshow); window.removeEventListener('focus', check); document.removeEventListener('visibilitychange', visible); };
}
