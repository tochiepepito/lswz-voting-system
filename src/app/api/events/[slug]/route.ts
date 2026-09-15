import { jsonError, jsonOk } from '@/lib/http';
import { toPublicEvent, type PublicBallotState } from '@/server/presenters/public';
import { parseSlug, requirePublicEvent } from '@/server/api/helpers';
import * as ResultsService from '@/server/services/results.service';
import * as VoterService from '@/server/services/voter.service';
import * as VotingService from '@/server/services/voting.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/events/:slug
 *
 * The event, plus this browser's own state within it.
 *
 * Everything in `ballot` is derived on the server from the session cookie:
 * which identity this browser claimed, whether that identity has voted, and
 * whether results may be shown. The client is told the answer; it never
 * supplies it.
 */
export async function GET(_request: Request, context: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await context.params;
    const event = await requirePublicEvent(parseSlug(slug));

    const resolved = await VoterService.readSession();

    let ballot: PublicBallotState = {
      claimedName: null,
      hasVoted: false,
      receipt: null,
      canSeeResults: ResultsService.isPublicResultsVisible(event, false),
    };
    let voterId: string | null = null;

    if (resolved && !resolved.session.isBlocked) {
      const voter = await VoterService.getClaimedVoter(event.id, resolved.session.id);

      if (voter) {
        voterId = voter.id;
        const receipt = await VotingService.getReceiptForSession(event.id, resolved.session.id);
        const hasVoted = receipt !== null;

        ballot = {
          claimedName: voter.displayName,
          hasVoted,
          receipt: hasVoted
            ? {
                code: receipt.receiptCode,
                castAt: receipt.castAt.toISOString(),
                selections: receipt.optionNames,
              }
            : null,
          canSeeResults: ResultsService.isPublicResultsVisible(event, hasVoted),
        };
      }
    }

    return jsonOk({
      event: toPublicEvent(event, new Date(), voterId),
      ballot,
      csrfToken: resolved?.csrfToken ?? null,
    });
  } catch (error) {
    return jsonError(error, 'GET /api/events/[slug]');
  }
}
