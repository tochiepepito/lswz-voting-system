import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { LocalTime } from '@/components/local-time';
import { ResultsTally, TallyTable } from '@/components/results-tally';
import { Alert, Badge, ButtonLink, Card, PageHeader, Stat, StatusBadge } from '@/components/ui';
import { formatNumber } from '@/lib/format';
import { resultsUnavailableReason, votingPhase } from '@/lib/voting-rules';
import { VOTING_TYPE_LABELS } from '@/types/domain';
import * as EventService from '@/server/services/event.service';
import * as ResultsService from '@/server/services/results.service';
import * as VoterService from '@/server/services/voter.service';
import * as VotingService from '@/server/services/voting.service';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const event = await EventService.getPublicEventBySlug(slug);

  return { title: event ? `Results · ${event.title}` : 'Event not found' };
}

/**
 * Public results.
 *
 * Visibility is decided server-side from the event's configuration and this
 * voter's own state. Crucially, `hasVoted` is resolved from the session cookie
 * here - if it were a query parameter or a client prop, the "visible after
 * voting" setting would be one URL edit away from meaningless.
 */
export default async function ResultsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  const event = await EventService.getPublicEventBySlug(slug);
  if (!event) notFound();

  const resolved = await VoterService.readSession();
  let hasVoted = false;

  if (resolved) {
    const voter = await VoterService.getClaimedVoter(event.id, resolved.session.id);
    if (voter) hasVoted = await VotingService.hasVoted(event.id, voter.id);
  }

  const visible = ResultsService.isPublicResultsVisible(event, hasVoted);
  const phase = votingPhase(event);

  return (
    <div className="space-y-6">
      <div>
        <Link href={`/events/${slug}`} className="text-sm text-muted hover:text-ink">
          ← Event details
        </Link>
      </div>

      <PageHeader
        eyebrow={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={event.status} />
            <Badge tone="neutral">{VOTING_TYPE_LABELS[event.votingType]}</Badge>
          </span>
        }
        title={event.title}
        description={
          event.endsAt ? (
            <span className="text-sm">
              {phase === 'ENDED' ? 'Voting closed ' : 'Voting closes '}
              <LocalTime value={event.endsAt.toISOString()} />
            </span>
          ) : null
        }
      />

      {!visible ? (
        <Card className="space-y-4 p-6 text-center">
          <div className="text-3xl" aria-hidden="true">
            🔒
          </div>
          <h2 className="text-lg font-semibold">Results are not available yet</h2>
          <p className="mx-auto max-w-md text-sm text-muted">
            {resultsUnavailableReason(event.resultsVisibility, phase)}
          </p>
          {event.resultsVisibility === 'AFTER_VOTING' && !hasVoted && phase === 'OPEN' ? (
            <div>
              <ButtonLink href={`/events/${slug}`}>Cast your vote</ButtonLink>
            </div>
          ) : null}
        </Card>
      ) : (
        <ResultsBody event={event} hasVoted={hasVoted} phase={phase} />
      )}
    </div>
  );
}

async function ResultsBody({
  event,
  hasVoted,
  phase,
}: {
  event: Awaited<ReturnType<typeof EventService.getPublicEventBySlug>> & object;
  hasVoted: boolean;
  phase: ReturnType<typeof votingPhase>;
}) {
  const results = await ResultsService.getPublicResults(event, hasVoted);

  if (results.totalBallots === 0) {
    return (
      <Card className="p-6 text-center">
        <p className="text-sm text-muted">
          No votes have been cast yet. Check back once voting is under way.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      {phase === 'OPEN' ? (
        <Alert tone="info">
          Voting is still open, so these numbers will keep changing until it closes.
        </Alert>
      ) : null}

      <div className="grid grid-cols-2 gap-3">
        <Stat label="Total votes" value={formatNumber(results.totalBallots)} />
        <Stat label="Unique players" value={formatNumber(results.distinctVoters)} />
      </div>

      <Card className="p-5">
        <h2 className="mb-4 font-semibold">Results</h2>
        <ResultsTally
          rows={results.options.map((option) => ({
            optionId: option.optionId,
            name: option.name,
            votes: option.votes,
            isActive: option.isActive,
          }))}
          totalBallots={results.totalBallots}
          isMultipleChoice={event.votingType === 'MULTIPLE_CHOICE'}
        />
      </Card>

      <TallyTable
        rows={results.options.map((option) => ({
          optionId: option.optionId,
          name: option.name,
          votes: option.votes,
        }))}
        totalBallots={results.totalBallots}
      />
    </div>
  );
}
