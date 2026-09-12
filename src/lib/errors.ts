/**
 * Error taxonomy.
 *
 * Every failure the voter or administrator can see is one of these codes, and
 * each code has exactly one pre-written, human message. Consequences:
 *
 *   - No database error, Prisma message or stack trace can ever reach a client,
 *     because the response is built from the code, not from `error.message`.
 *   - Error copy is reviewable in one file instead of scattered across handlers.
 *   - Clients can branch on a stable code without parsing prose.
 */

export const ERROR_CODES = [
  // --- Event lifecycle ---
  'EVENT_NOT_FOUND',
  'EVENT_NOT_ACTIVE',
  'EVENT_NOT_STARTED',
  'EVENT_ENDED',
  'EVENT_NOT_EDITABLE',
  'INVALID_STATUS_TRANSITION',

  // --- Ballot ---
  'OPTION_UNAVAILABLE',
  'TOO_FEW_SELECTIONS',
  'TOO_MANY_SELECTIONS',
  'DUPLICATE_SELECTION',

  // --- Voter identity ---
  'IGN_REQUIRED',
  'IGN_INVALID',
  'ALREADY_VOTED',
  'VOTER_BLOCKED',

  // --- Session ---
  'SESSION_REQUIRED',
  'SESSION_INVALID',
  'SESSION_EXPIRED',
  'SESSION_BLOCKED',
  'SESSION_VOTE_LIMIT',
  'IDENTITY_MISMATCH',

  // --- Abuse control ---
  'RATE_LIMITED',
  'CAPTCHA_REQUIRED',
  'CAPTCHA_FAILED',
  'CSRF_FAILED',

  // --- Admin ---
  'UNAUTHORIZED',
  'FORBIDDEN',
  'INVALID_CREDENTIALS',
  'ACCOUNT_LOCKED',
  'ACCOUNT_DISABLED',
  'EMAIL_IN_USE',
  'SLUG_IN_USE',
  'LAST_SUPER_ADMIN',

  // --- Generic ---
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'CONFLICT',
  'RESULTS_NOT_AVAILABLE',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

type ErrorDefinition = {
  status: number;
  /** Shown verbatim to the end user. Must never contain internal detail. */
  message: string;
};

const ERROR_DEFINITIONS: Record<ErrorCode, ErrorDefinition> = {
  EVENT_NOT_FOUND: { status: 404, message: 'That voting event could not be found.' },
  EVENT_NOT_ACTIVE: { status: 409, message: 'This voting event is no longer active.' },
  EVENT_NOT_STARTED: { status: 409, message: 'Voting for this event has not started yet.' },
  EVENT_ENDED: { status: 409, message: 'Voting for this event has already closed.' },
  EVENT_NOT_EDITABLE: {
    status: 409,
    message: 'This event can no longer be edited because voting has already begun.',
  },
  INVALID_STATUS_TRANSITION: {
    status: 409,
    message: 'That change is not allowed from the current event status.',
  },

  OPTION_UNAVAILABLE: { status: 409, message: 'The selected option is no longer available.' },
  TOO_FEW_SELECTIONS: { status: 400, message: 'Please select enough options to cast your vote.' },
  TOO_MANY_SELECTIONS: { status: 400, message: 'You have selected more options than allowed.' },
  DUPLICATE_SELECTION: { status: 400, message: 'The same option was selected more than once.' },

  IGN_REQUIRED: { status: 400, message: 'Please enter your in-game name.' },
  IGN_INVALID: { status: 400, message: 'That in-game name is not valid.' },
  ALREADY_VOTED: { status: 409, message: 'You have already voted in this event.' },
  VOTER_BLOCKED: {
    status: 403,
    message: 'This in-game name has been blocked from voting. Please contact an event organiser.',
  },

  SESSION_REQUIRED: { status: 401, message: 'Please enter your in-game name to continue.' },
  SESSION_INVALID: {
    status: 401,
    message: 'Your voting session is no longer valid. Please enter your in-game name again.',
  },
  SESSION_EXPIRED: {
    status: 401,
    message: 'Your voting session has expired. Please enter your in-game name again.',
  },
  SESSION_BLOCKED: {
    status: 403,
    message: 'Voting from this browser has been disabled. Please contact an event organiser.',
  },
  SESSION_VOTE_LIMIT: {
    status: 409,
    message: 'A vote has already been cast from this browser for this event.',
  },
  IDENTITY_MISMATCH: {
    status: 409,
    message: 'Your in-game name does not match the one used to start this ballot.',
  },

  RATE_LIMITED: { status: 429, message: 'Too many voting attempts. Please try again later.' },
  CAPTCHA_REQUIRED: { status: 400, message: 'Please complete the verification challenge.' },
  CAPTCHA_FAILED: {
    status: 400,
    message: 'Verification failed. Please try the challenge again.',
  },
  CSRF_FAILED: {
    status: 403,
    message: 'Your session has expired. Please reload the page and try again.',
  },

  UNAUTHORIZED: { status: 401, message: 'You need to sign in to do that.' },
  FORBIDDEN: { status: 403, message: 'You do not have permission to do that.' },
  INVALID_CREDENTIALS: { status: 401, message: 'Incorrect e-mail or password.' },
  ACCOUNT_LOCKED: {
    status: 429,
    message: 'Too many failed sign-in attempts. This account is temporarily locked.',
  },
  ACCOUNT_DISABLED: { status: 403, message: 'This administrator account has been disabled.' },
  EMAIL_IN_USE: { status: 409, message: 'An administrator with that e-mail already exists.' },
  SLUG_IN_USE: { status: 409, message: 'Another event is already using that URL slug.' },
  LAST_SUPER_ADMIN: {
    status: 409,
    message: 'At least one active super administrator must remain.',
  },

  VALIDATION_FAILED: { status: 400, message: 'Please check the highlighted fields and try again.' },
  NOT_FOUND: { status: 404, message: 'That item could not be found.' },
  CONFLICT: { status: 409, message: 'That action conflicts with the current state.' },
  RESULTS_NOT_AVAILABLE: {
    status: 403,
    message: 'Results for this event are not available yet.',
  },
  INTERNAL: { status: 500, message: 'Something went wrong. Please try again.' },
};

/** Field-level messages, keyed by form field name. */
export type FieldErrors = Record<string, string[]>;

export type AppErrorOptions = {
  /** Overrides the catalogue message. Must still be user-safe. */
  message?: string;
  /** Per-field validation messages for form rendering. */
  fieldErrors?: FieldErrors;
  /** Seconds until the caller may retry. Surfaced as `Retry-After` on 429. */
  retryAfterSeconds?: number;
  /** Underlying cause. Logged server-side, never serialised to a client. */
  cause?: unknown;
};

/**
 * An error whose message is safe to show a user.
 *
 * Anything thrown that is *not* an AppError is treated as an unexpected bug:
 * logged in full on the server, reported to the client as a bare INTERNAL.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly fieldErrors?: FieldErrors;
  readonly retryAfterSeconds?: number;

  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    const definition = ERROR_DEFINITIONS[code];
    super(options.message ?? definition.message, { cause: options.cause });

    this.name = 'AppError';
    this.code = code;
    this.status = definition.status;
    this.fieldErrors = options.fieldErrors;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }

  /** The exact shape sent to clients. Deliberately minimal. */
  toPublicJSON(): PublicErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.fieldErrors ? { fieldErrors: this.fieldErrors } : {}),
      },
    };
  }
}

export type PublicErrorBody = {
  error: {
    code: ErrorCode;
    message: string;
    fieldErrors?: FieldErrors;
  };
};

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/** Convenience constructor so call sites read as one short line. */
export function appError(code: ErrorCode, options?: AppErrorOptions): AppError {
  return new AppError(code, options);
}

/** The catalogue message for a code, for use in client-side rendering. */
export function messageForCode(code: ErrorCode): string {
  return ERROR_DEFINITIONS[code].message;
}

export function statusForCode(code: ErrorCode): number {
  return ERROR_DEFINITIONS[code].status;
}

/**
 * Normalise any thrown value into an AppError.
 *
 * Unexpected errors are logged here, once, with their full detail, and replaced
 * by a generic INTERNAL so nothing internal escapes. `context` identifies the
 * call site in the log.
 */
export function toAppError(error: unknown, context: string): AppError {
  if (isAppError(error)) return error;

  console.error(`[${context}] unhandled error:`, error);

  return new AppError('INTERNAL', { cause: error });
}
