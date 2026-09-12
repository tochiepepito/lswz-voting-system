import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { BallotForm } from '@/components/voter/ballot-form';
import { Countdown } from '@/components/local-time';
import { Alert, Card, PageHeader } from '@/components/ui';
import { toPublicEvent } from '@/server/presenters/public';
import * as EventService from '@/server/services/event.service';
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

  return { title: event ? `Vote · ${event.title}` : 'Event not found' };
}

/**
 * Step 3: the ballot.
 *
 * Four server-side gates before a ballot is ever rendered. Each one redirects
 * rather than rendering a form that could not be submitted:
 *   1. the event exists and is public
 *   2. this browser has claimed an identity
 *   3. that identity has not already voted
 *   4. voting is actually open right now
 */
export default async function VotePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  const event = await EventService.getPublicEventBySlug(slug);
  if (!event) notFound();

  const resolved = await VoterService.readSession();
  if (!resolved || resolved.session.isBlocked) redirect(`/events/${slug}`);

  const voter = await VoterService.getClaimedVoter(event.id, resolved.session.id);
  if (!voter) redirect(`/events/${slug}`);

  if (await VotingService.hasVoted(event.id, voter.id)) {
    redirect(`/events/${slug}/confirmation`);
  }

  const publicEvent = toPublicEvent(event);

  if (publicEvent.phase !== 'OPEN') redirect(`/events/${slug}`);

  if (publicEvent.options.length === 0) {
    return (
      <Alert tone="warn" title="This ballot has no options yet">
        An organiser still needs to add the choices for this event.
      </Alert>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <Link href={`/events/${slug}`} className="text-sm text-muted hover:text-ink">
          ← Event details
        </Link>
      </div>

      <PageHeader
        eyebrow={`Voting as ${voter.displayName}`}
        title={publicEvent.title}
        description={<p className="font-medium text-ink">{publicEvent.ballotRule}</p>}
      />

      {publicEvent.instructions ? (
        <Card className="p-4">
          <p className="whitespace-pre-line text-sm text-muted">{publicEvent.instructions}</p>
        </Card>
      ) : null}

      {publicEvent.endsAt ? (
        <p className="text-sm text-muted">
          <Countdown deadline={publicEvent.endsAt} />
        </p>
      ) : null}

      <BallotForm event={publicEvent} csrfToken={resolved.csrfToken} />
    </div>
  );
}
