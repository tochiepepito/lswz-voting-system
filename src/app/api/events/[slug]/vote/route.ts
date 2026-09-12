import { jsonError, jsonOk, readJsonBody, requestContextFrom } from '@/lib/http';
import { submitVoteSchema } from '@/schemas/voter';
import {
  assertVoterRequestIsTrusted,
  parseBody,
  parseSlug,
  requirePublicEvent,
} from '@/server/api/helpers';
import * as VotingService from '@/server/services/voting.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/events/:slug/vote
 *
 * Cast a ballot. The request body carries nothing but the chosen option ids and
 * an optional CAPTCHA token: the event, the voter identity, the voting window,
 * the selectable options and whether this identity already voted are all read
 * from the server's own state inside the vote transaction.
 *
 * The response is a receipt code and the recorded selections - never a vote id.
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

    const input = parseBody(submitVoteSchema, body);

    const receipt = await VotingService.submitVote({
      event,
      optionIds: input.optionIds,
      context: requestContextFrom(request),
      captchaToken: input.captchaToken,
    });

    return jsonOk(
      {
        receiptCode: receipt.receiptCode,
        displayName: receipt.displayName,
        castAt: receipt.castAt.toISOString(),
        selections: receipt.optionNames,
      },
      { status: 201 },
    );
  } catch (error) {
    return jsonError(error, 'POST /api/events/[slug]/vote');
  }
}
