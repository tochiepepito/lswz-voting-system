import { type ErrorCode, type FieldErrors, toAppError } from './errors';

/**
 * Serialisable result type for Server Actions.
 *
 * A Server Action that throws produces an opaque, unstyled error in the client
 * and (in production) hides the reason entirely. Actions therefore *return*
 * failures as data, using this union, and let React render them inline in the
 * form. Route handlers, which have a natural error channel in the HTTP status,
 * throw `AppError` instead.
 */

export type Success<T> = { ok: true; data: T };

export type Failure = {
  ok: false;
  code: ErrorCode;
  message: string;
  fieldErrors?: FieldErrors;
};

export type Result<T> = Success<T> | Failure;

export function ok(): Success<undefined>;
export function ok<T>(data: T): Success<T>;
export function ok<T>(data?: T): Success<T | undefined> {
  return { ok: true, data };
}

export function fail(
  code: ErrorCode,
  message: string,
  fieldErrors?: FieldErrors,
): Failure {
  return fieldErrors ? { ok: false, code, message, fieldErrors } : { ok: false, code, message };
}

/**
 * Convert any thrown value into a Failure, logging unexpected ones.
 * `context` names the action for the server log.
 */
export function failFrom(error: unknown, context: string): Failure {
  const appError = toAppError(error, context);
  return fail(appError.code, appError.message, appError.fieldErrors);
}

/**
 * Run an action body, converting any thrown error into a Failure.
 * Keeps every action to a single `return withResult(...)` shape.
 */
export async function withResult<T>(
  context: string,
  body: () => Promise<Result<T>>,
): Promise<Result<T>> {
  try {
    return await body();
  } catch (error) {
    return failFrom(error, context);
  }
}
