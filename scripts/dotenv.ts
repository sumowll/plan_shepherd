export function parseEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) throw new Error('Invalid environment file line. Use KEY=value; multiline values are not supported.');
    let value = match[2].trim();
    if (value.startsWith('"') && value.endsWith('"')) { try { value = JSON.parse(value) as string; } catch { throw new Error(`Invalid quoted value for ${match[1]}`); } }
    else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    if (/[\r\n\0]/.test(value)) throw new Error(`Multiline or null value for ${match[1]} is not allowed`);
    values[match[1]] = value;
  }
  return values;
}
