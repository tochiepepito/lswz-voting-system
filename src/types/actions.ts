import type { Failure, Result } from '@/lib/result';

/**
 * Form state types for Server Actions.
 *
 * These live outside the `'use server'` modules on purpose: a file with the
 * `'use server'` directive is only allowed to export async functions, because
 * every export becomes a callable server endpoint. Types belong here instead.
 */

/** State for an action that navigates on success, so only failures surface. */
export type FailureState = Failure | null;

/** State for an action that stays on the page and reports an outcome. */
export type ActionState<T = { message: string }> = Result<T> | null;

/** The common "it worked, here is a sentence to show" payload. */
export type MessagePayload = { message: string };
