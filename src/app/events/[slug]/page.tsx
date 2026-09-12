import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Countdown, LocalTime } from '@/components/local-time';
import { IgnForm } from '@/components/voter/ign-form';
import { Alert, Badge, ButtonLink, Card, CsrfField, PageHeader, StatusBadge } from '@/components/ui';
import { VOTING_TYPE_LABELS } from '@/types/domain';
import { changeIdentityAction } from '@/server/actions/voter.actions';
import { toPublicEvent } from '@/server/presenters/public';
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

  return { title: event?.title ?? 'Event not found' };
}

/**
 * Event detail, and step 2 of the voter flow.
 *
 * What this page renders is decided entirely by server-side state:
 *   - no identity claimed  -> the IGN form
 *   - claimed, not voted   -> continue to the ballot
 *   - claimed and voted    -> the receipt
 *
 * `hasVoted` is read from the database on every request. It is never in a
 * cookie, never in localStorage, and never a prop the client can influence.
 */
export default async function EventPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  const event = await EventService.getPublicEventBySlug(slug);
  if (!event) notFound();

  const publicEvent = toPublicEvent(event);
  const resolved = await VoterService.readSession();

  const claimedVoter = resolved
    ? await VoterService.getClaimedVoter(event.id, resolved.session.id)
    : null;

  const hasVoted = claimedVoter ? await VotingService.hasVoted(event.id, claimedVoter.id) : false;
  const canSeeResults = ResultsService.isPublicResultsVisible(event, hasVoted);

  const isOpen = publicEvent.phase === 'OPEN';
  const isBlocked = resolved?.session.isBlocked ?? false;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/events" className="text-sm text-muted hover:text-ink">
          ← All events
        </Link>
      </div>

      <PageHeader
        eyebrow={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={publicEvent.status} />
            <Badge tone="neutral">{VOTING_TYPE_LABELS[publicEvent.votingType]}</Badge>
          </span>
        }
        title={publicEvent.title}
        description={<p className="whitespace-pre-line">{publicEvent.description}</p>}
      />

      <Card className="divide-y divide-line">
        <dl className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2">
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-faint">
              Voting opens
            </dt>
            <dd className="mt-1 text-sm">
              {publicEvent.startsAt ? <LocalTime value={publicEvent.startsAt} /> : 'When published'}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-faint">
              Voting closes
            </dt>
            <dd className="mt-1 text-sm">
              {publicEvent.endsAt ? <LocalTime value={publicEvent.endsAt} /> : 'When an organiser closes it'}
            </dd>
          </div>
        </dl>

        <div className="p-5">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-faint">How to vote</h2>
          <p className="mt-1 font-medium">{publicEvent.ballotRule}</p>
          {publicEvent.instructions ? (
            <p className="mt-2 whitespace-pre-line text-sm text-muted">
              {publicEvent.instructions}
            </p>
          ) : null}
        </div>
      </Card>

      {isOpen && publicEvent.endsAt ? (
        <Alert tone="info">
          <Countdown deadline={publicEvent.endsAt} />
        </Alert>
      ) : null}

      {/* --- The state machine --- */}

      {isBlocked ? (
        <Alert tone="danger" title="Voting is disabled for this browser">
          An organiser has blocked voting from this device. Please contact your community
          organisers if you think this is a mistake.
        </Alert>
      ) : hasVoted ? (
        <Card className="space-y-4 p-5">
          <Alert tone="ok" title="You have already voted in this event">
            Thank you, {claimedVoter?.displayName}. Your vote has been recorded.
          </Alert>
          <div className="flex flex-wrap gap-2">
            <ButtonLink href={`/events/${slug}/confirmation`} variant="secondary">
              View your receipt
            </ButtonLink>
            {canSeeResults ? (
              <ButtonLink href={`/events/${slug}/results`}>See results</ButtonLink>
            ) : null}
          </div>
        </Card>
      ) : !isOpen ? (
        <Card className="space-y-4 p-5">
          <Alert tone="warn">
            {publicEvent.phase === 'UPCOMING'
              ? 'Voting for this event has not started yet.'
              : 'This voting event is no longer active.'}
          </Alert>
          {canSeeResults ? (
            <ButtonLink href={`/events/${slug}/results`}>See results</ButtonLink>
          ) : null}
        </Card>
      ) : claimedVoter ? (
        <Card className="space-y-4 p-5">
          <div>
            <p className="text-sm text-muted">Voting as</p>
            <p className="text-lg font-bold">{claimedVoter.displayName}</p>
          </div>

          <div className="flex flex-wrap gap-2">
            <ButtonLink href={`/events/${slug}/vote`}>Continue to ballot</ButtonLink>

            {/* Lets a shared device be handed to the next player. */}
            <form action={changeIdentityAction}>
              <input type="hidden" name="eventSlug" value={slug} />
              <CsrfField token={resolved?.csrfToken ?? null} />
              <button
                type="submit"
                className="min-h-[2.75rem] rounded-lg px-4 py-2 text-sm font-semibold text-muted hover:bg-surface-2 hover:text-ink"
              >
                Not you? Use a different name
              </button>
            </form>
          </div>
        </Card>
      ) : (
        <Card className="p-5 sm:p-6">
          <h2 className="text-lg font-bold">Enter your in-game name</h2>
          <p className="mt-1 text-sm text-muted">
            No account, password or e-mail needed.
          </p>
          <div className="mt-5">
            <IgnForm eventSlug={slug} csrfToken={resolved?.csrfToken ?? null} />
          </div>
        </Card>
      )}

      {canSeeResults && !hasVoted && isOpen ? (
        <div>
          <Link href={`/events/${slug}/results`} className="text-sm text-accent hover:underline">
            View live results →
          </Link>
        </div>
      ) : null}
    </div>
  );
}
