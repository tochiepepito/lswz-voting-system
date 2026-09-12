import { z } from 'zod';
import { appError } from '@/lib/errors';
import { CSRF_HEADER, isValidCsrfToken, readVoterSessionToken } from '@/lib/cookies';
import { assertTrustedOrigin } from '@/lib/http';
import { toFieldErrors } from '@/schemas/common';
import type { EventWithOptions } from '../repositories/event.repository';
import * as EventService from '../services/event.service';

/** Small helpers shared by the public Route Handlers. */

/** Load a publicly visible event or fail with the standard 404. */
export async function requirePublicEvent(slug: string): Promise<EventWithOptions> {
  const event = await EventService.getPublicEventBySlug(slug);
  if (!event) throw appError('EVENT_NOT_FOUND');

  return event;
}

/** Validate a slug from the URL before it reaches the database. */
export const slugParamSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9-]+$/, 'Invalid event.');

export function parseSlug(raw: string): string {
  const parsed = slugParamSchema.safeParse(raw);
  if (!parsed.success) throw appError('EVENT_NOT_FOUND');

  return parsed.data;
}

/** Parse a body with a schema, converting failures into a 400 with field errors. */
export function parseBody<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    throw appError('VALIDATION_FAILED', { fieldErrors: toFieldErrors(parsed.error) });
  }

  return parsed.data;
}

/**
 * Both CSRF layers for a voter-facing API mutation.
 *
 * The token may arrive in the `X-CSRF-Token` header (fetch clients) or in the
 * JSON body (progressive-enhancement form posts). A request from a browser with
 * no voter session yet is allowed through on the origin check alone, because
 * there is no session to bind a token to until the first IGN is submitted.
 */
export async function assertVoterRequestIsTrusted(
  request: Request,
  bodyToken?: unknown,
): Promise<void> {
  assertTrustedOrigin(request.headers);

  const sessionToken = await readVoterSessionToken();
  if (!sessionToken) return;

  const submitted =
    request.headers.get(CSRF_HEADER) ?? (typeof bodyToken === 'string' ? bodyToken : null);

  if (!isValidCsrfToken(sessionToken, submitted)) {
    throw appError('CSRF_FAILED');
  }
}
