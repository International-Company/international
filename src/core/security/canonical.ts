/**
 * Deterministic JSON serialisation.
 *
 * The audit chain hashes records, so two structurally equal values must always
 * produce byte-identical output — otherwise the same record would hash
 * differently on re-verification and the chain would appear tampered with for
 * no reason. That means: object keys sorted, bigints stringified, dates in ISO,
 * and `undefined` treated exactly like `null`.
 *
 * Kept free of the `server-only` guard so it can be unit-tested directly; it
 * has no I/O and no dependencies.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalize);

  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      out[key] = normalize(source[key]);
    }
    return out;
  }

  return value;
}
