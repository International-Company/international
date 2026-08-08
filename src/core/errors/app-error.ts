/**
 * Error taxonomy. Every failure the application raises deliberately is an
 * `AppError` carrying a stable `code`, an HTTP status, and an i18n key so the
 * UI can render the message in the operator's language without string matching.
 */

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PRECONDITION_FAILED'
  | 'INSUFFICIENT_FUNDS'
  | 'UNBALANCED_ENTRY'
  | 'RATE_UNAVAILABLE'
  | 'DAY_CLOSED'
  | 'ACCOUNT_LOCKED'
  | 'PASSWORD_POLICY'
  | 'RATE_LIMITED'
  | 'EXTERNAL_SERVICE'
  | 'INTERNAL_ERROR';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 422,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PRECONDITION_FAILED: 412,
  INSUFFICIENT_FUNDS: 422,
  UNBALANCED_ENTRY: 500,
  RATE_UNAVAILABLE: 422,
  DAY_CLOSED: 409,
  ACCOUNT_LOCKED: 423,
  PASSWORD_POLICY: 422,
  RATE_LIMITED: 429,
  EXTERNAL_SERVICE: 502,
  INTERNAL_ERROR: 500,
};

export interface FieldIssue {
  path: string;
  message: string;
  code?: string;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** i18n key, e.g. `errors.insufficientFunds`. */
  readonly messageKey: string;
  /** Interpolation values for the i18n message. */
  readonly params: Record<string, string | number>;
  readonly issues: FieldIssue[];
  /** Safe to show the user? Internal errors are redacted in production. */
  readonly expose: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      messageKey?: string;
      params?: Record<string, string | number>;
      issues?: FieldIssue[];
      cause?: unknown;
      expose?: boolean;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.messageKey = options.messageKey ?? `errors.${toCamel(code)}`;
    this.params = options.params ?? {};
    this.issues = options.issues ?? [];
    this.expose = options.expose ?? code !== 'INTERNAL_ERROR';
  }

  toJSON() {
    return {
      code: this.code,
      messageKey: this.messageKey,
      params: this.params,
      issues: this.issues,
      message: this.expose ? this.message : 'Internal server error',
    };
  }
}

function toCamel(code: string): string {
  return code
    .toLowerCase()
    .replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

// --- Constructors ----------------------------------------------------------

export const errors = {
  validation: (issues: FieldIssue[], message = 'Validation failed') =>
    new AppError('VALIDATION_ERROR', message, { issues }),

  unauthenticated: (message = 'Authentication required') =>
    new AppError('UNAUTHENTICATED', message),

  forbidden: (permission?: string) =>
    new AppError('FORBIDDEN', `Missing permission${permission ? `: ${permission}` : ''}`, {
      params: permission ? { permission } : {},
    }),

  notFound: (entity: string, id?: string) =>
    new AppError('NOT_FOUND', `${entity}${id ? ` "${id}"` : ''} not found`, {
      params: { entity, id: id ?? '' },
    }),

  // `params` fills the placeholders in the translated message. Without it a key
  // like "{account} needs {required}" reaches the operator with the braces
  // still in it, which reads as a broken screen rather than an explanation.
  conflict: (message: string, messageKey?: string, params?: Record<string, string | number>) =>
    new AppError('CONFLICT', message, { messageKey, params }),

  precondition: (message: string, messageKey?: string, params?: Record<string, string | number>) =>
    new AppError('PRECONDITION_FAILED', message, { messageKey, params }),

  insufficientFunds: (account: string, available: string, required: string) =>
    new AppError('INSUFFICIENT_FUNDS', `${account} holds ${available}, needs ${required}`, {
      params: { account, available, required },
    }),

  unbalanced: (difference: string) =>
    new AppError('UNBALANCED_ENTRY', `Journal entry does not balance, difference ${difference}`, {
      params: { difference },
    }),

  rateUnavailable: (pair: string) =>
    new AppError('RATE_UNAVAILABLE', `No active rate for ${pair}`, { params: { pair } }),

  dayClosed: (date: string) =>
    new AppError('DAY_CLOSED', `Business day ${date} is closed`, { params: { date } }),

  accountLocked: (until?: Date) =>
    new AppError('ACCOUNT_LOCKED', 'Account is temporarily locked', {
      params: until ? { until: until.toISOString() } : {},
    }),

  passwordPolicy: (issues: FieldIssue[]) =>
    new AppError('PASSWORD_POLICY', 'Password does not meet policy', { issues }),

  rateLimited: (retryAfterSeconds: number) =>
    new AppError('RATE_LIMITED', 'Too many attempts', { params: { retryAfterSeconds } }),

  external: (service: string, cause?: unknown) =>
    new AppError('EXTERNAL_SERVICE', `${service} request failed`, { params: { service }, cause }),

  internal: (message = 'Internal server error', cause?: unknown) =>
    new AppError('INTERNAL_ERROR', message, { cause, expose: false }),
};

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
