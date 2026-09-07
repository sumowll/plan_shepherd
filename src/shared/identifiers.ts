/** Remove formatting only. Preserve digit count and leading zeros; never infer NDC padding. */
export function normalizeNdc(value: string | undefined): string {
  return (value ?? '').trim().replaceAll('-', '');
}

/** Price observations may use RxNorm or NDC; numeric RxNorm values remain unchanged. */
export function normalizeMedicationCode(value: string): string {
  const code = value.trim();
  return /^[\d-]+$/.test(code) ? normalizeNdc(code) : code;
}
