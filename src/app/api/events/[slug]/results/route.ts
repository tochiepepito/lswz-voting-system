import { jsonError, jsonOk } from '@/lib/http';
import { toPublicResults } from '@/server/presenters/public';
import { parseSlug, requirePublicEvent } from '@/server/api/helpers';
import * as ResultsService from '@/server/services/results.service';
import * as VoterService from '@/server/services/voter.service';
import * as VotingService from '@/server/services/voting.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/events/:slug/results
 *
 * Public tally, subject to the event's configured visibility.
 *
 * The `hasVoted` input to that decision is resolved from the session cookie
 * here. If it were a query parameter, "visible after voting" would be
 * bypassable with `?hasVoted=true`.
 */
export async function GET(_request: Request, context: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await context.params;
    const event = await requirePublicEvent(parseSlug(slug));

    let hasVoted = false;

    const resolved = await VoterService.readSession();
    if (resolved) {
      const voter = await VoterService.getClaimedVoter(event.id, resolved.session.id);
      if (voter) hasVoted = await VotingService.hasVoted(event.id, voter.id);
    }

    const results = await ResultsService.getPublicResults(event, hasVoted);

    return jsonOk({ results: toPublicResults(results) });
  } catch (error) {
    return jsonError(error, 'GET /api/events/[slug]/results');
  }
}
