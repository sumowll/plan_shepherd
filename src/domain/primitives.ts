export function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export const cents = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export const bps = (value: unknown): value is number => cents(value) && value <= 10_000;
export const normalized = (value: string | undefined): string => (value ?? '').trim().toLocaleLowerCase('en-US').replace(/\s+/g, ' ');
export function roundedRatio(amount: number, numerator: number, denominator: number): number {
  if (!cents(amount) || !cents(numerator) || !cents(denominator) || denominator === 0) throw new RangeError('Invalid monetary operands.');
  const result = (BigInt(amount) * BigInt(numerator) + BigInt(Math.floor(denominator / 2))) / BigInt(denominator);
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Amount exceeds supported monetary precision.');
  return Number(result);
}
export function extendedPrice(unitPrice: number, quantity: number): number | null {
  if (!cents(unitPrice) || !Number.isFinite(quantity) || quantity <= 0 || quantity > 1_000_000) return null;
  const scaled = Math.round(quantity * 1_000_000);
  if (scaled / 1_000_000 !== quantity) return null;
  try { return roundedRatio(unitPrice, scaled, 1_000_000); } catch { return null; }
}
export const elapsedDays = (start: string, end: string): number => (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000;
