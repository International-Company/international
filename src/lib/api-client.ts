'use client';

import type { FieldIssue } from '@/core/errors/app-error';

/**
 * Client-side API access.
 *
 * Wraps `fetch` so every screen handles failures the same way: the server's
 * structured error shape is preserved (code, i18n key, field issues) instead of
 * being flattened into a string, which is what lets forms highlight the exact
 * field the server rejected.
 */

export interface ApiErrorPayload {
  code: string;
  messageKey: string;
  params: Record<string, string | number>;
  issues: FieldIssue[];
  message: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly messageKey: string;
  readonly params: Record<string, string | number>;
  readonly issues: FieldIssue[];

  constructor(status: number, payload: ApiErrorPayload) {
    super(payload.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = payload.code;
    this.messageKey = payload.messageKey;
    this.params = payload.params ?? {};
    this.issues = payload.issues ?? [];
  }

  /** Maps field issues to a `{ field: message }` object for form state. */
  fieldErrors(): Record<string, string> {
    return Object.fromEntries(this.issues.map((issue) => [issue.path, issue.message]));
  }
}

/** `body` is any JSON-serialisable value, not the DOM `BodyInit`. */
type RequestOptions = Omit<RequestInit, 'body'> & { body?: unknown };

async function request<T>(path: string, init: RequestOptions = {}): Promise<T> {
  const { body, headers, ...rest } = init;

  let response: Response;
  try {
    response = await fetch(path, {
      ...rest,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    // Network-level failure — the server was never reached.
    throw new ApiError(0, {
      code: 'NETWORK_ERROR',
      messageKey: 'errors.networkError',
      params: {},
      issues: [],
      message: 'Network request failed',
    });
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const payload = text ? (JSON.parse(text) as { data?: T; error?: ApiErrorPayload }) : {};

  if (!response.ok) {
    throw new ApiError(
      response.status,
      payload.error ?? {
        code: 'INTERNAL_ERROR',
        messageKey: 'errors.internalError',
        params: {},
        issues: [],
        message: response.statusText,
      },
    );
  }

  return payload.data as T;
}

type InitOptions = Omit<RequestOptions, 'body' | 'method'>;

export const api = {
  get: <T>(path: string, init?: InitOptions) => request<T>(path, { ...init, method: 'GET' }),
  post: <T>(path: string, body?: unknown, init?: InitOptions) =>
    request<T>(path, { ...init, method: 'POST', body }),
  patch: <T>(path: string, body?: unknown, init?: InitOptions) =>
    request<T>(path, { ...init, method: 'PATCH', body }),
  put: <T>(path: string, body?: unknown, init?: InitOptions) =>
    request<T>(path, { ...init, method: 'PUT', body }),
  delete: <T>(path: string, init?: InitOptions) => request<T>(path, { ...init, method: 'DELETE' }),
};

/** Builds a query string, dropping empty values so URLs stay readable. */
export function queryString(params: Record<string, unknown>): string {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }

  const result = search.toString();
  return result ? `?${result}` : '';
}
