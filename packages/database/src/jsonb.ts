/**
 * node-postgres parses `jsonb` columns into JS values before we see them,
 * while some code paths (and pure SQL tools) hand us the raw JSON text.
 * Coerce either shape safely.
 */
export function coerceJsonb<T>(value: unknown): T {
  if (value === null || value === undefined) {
    return value as T;
  }
  if (typeof value === "string") {
    return JSON.parse(value) as T;
  }
  return value as T;
}
