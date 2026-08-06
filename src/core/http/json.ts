/**
 * JSON helpers for the server/client boundary.
 *
 * `bigint` — which every monetary value in this system is — has no JSON
 * representation and throws on `JSON.stringify`. These helpers convert it to a
 * decimal string; the client parses it back with `deserializeMoney` and formats
 * it with the shared money utilities. Precision is never routed through
 * `number`, so nothing is silently rounded in transit.
 */

export type Jsonified<T> = T extends bigint
  ? string
  : T extends Date
    ? string
    : T extends (infer U)[]
      ? Jsonified<U>[]
      : T extends object
        ? { [K in keyof T]: Jsonified<T[K]> }
        : T;

export function toJsonSafe<T>(value: T): Jsonified<T> {
  return convert(value) as Jsonified<T>;
}

function convert(value: unknown): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(convert);

  if (typeof value === 'object') {
    // Leave class instances we do not own (Buffer, Map, …) alone.
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;

    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = convert(item);
    }
    return out;
  }

  return value;
}

export function jsonResponse(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(toJsonSafe(data)), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(init?.headers ?? {}),
    },
  });
}
