import { jsonError, jsonOk, readJsonBody, requestContextFrom } from '@/lib/http';
import { claimIdentitySchema } from '@/schemas/voter';
import {
  assertVoterRequestIsTrusted,
  parseBody,
  parseSlug,
  requirePublicEvent,
} from '@/server/api/helpers';
import * as VoterService from '@/server/services/voter.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/events/:slug/session
 *
 * Step 2 of the voter flow: submit an IGN and receive an anonymous voting
 * session for this event.
 *
 * The response contains the normalised display name and whether this identity
 * has already voted - both determined server-side. It never contains the
 * session token (that leaves only as an HTTP-only cookie), the voter id, or any
 * internal identifier.
 */
export async function POST(request: Request, context: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await context.params;
    const event = await requirePublicEvent(parseSlug(slug));

    const body = await readJsonBody(request);
    await assertVoterRequestIsTrusted(
      request,
      (body as { csrfToken?: unknown } | null)?.csrfToken,
    );

    const input = parseBody(claimIdentitySchema, body);

    const result = await VoterService.claimIdentity({
      event,
      rawIgn: input.ign,
      context: requestContextFrom(request),
      captchaToken: input.captchaToken,
    });

    return jsonOk({
      displayName: result.voter.displayName,
      alreadyVoted: result.alreadyVoted,
      csrfToken: result.csrfToken,
    });
  } catch (error) {
    return jsonError(error, 'POST /api/events/[slug]/session');
  }
}
