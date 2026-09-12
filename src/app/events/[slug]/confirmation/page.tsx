import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { LocalTime } from '@/components/local-time';
import { ButtonLink, Card } from '@/components/ui';
import * as EventService from '@/server/services/event.service';
import * as ResultsService from '@/server/services/results.service';
import * as VoterService from '@/server/services/voter.service';
import * as VotingService from '@/server/services/voting.service';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Vote submitted' };

/**
 * Step 4: confirmation.
 *
 * The receipt code shown here is a random 60-bit value stored alongside the
 * vote. The internal vote id never leaves the server - a voter who wants to ask
 * an organiser about their ballot quotes this code instead, and knowing it
 * grants no ability to read or change anything.
 */
export default async function ConfirmationPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  const event = await EventService.getPublicEventBySlug(slug);
  if (!event) notFound();

  const resolved = await VoterService.readSession();
  if (!resolved) redirect(`/events/${slug}`);

  const receipt = await VotingService.getReceiptForSession(event.id, resolved.session.id);
  // No ballot from this browser: send them back to the start rather than
  // showing an empty confirmation.
  if (!receipt) redirect(`/events/${slug}`);

  const canSeeResults = ResultsService.isPublicResultsVisible(event, true);

  return (
    <div className="space-y-6">
      <Card className="overflow-hidden">
        <div className="border-b border-ok/25 bg-ok/10 px-5 py-6 text-center sm:px-8 sm:py-8">
          <div
            className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-ok/15"
            aria-hidden="true"
          >
            <svg viewBox="0 0 24 24" className="h-7 w-7 stroke-ok" fill="none" strokeWidth={2.5}>
              <path d="M20 6 9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>

          <h1 className="mt-4 text-2xl font-bold">Vote submitted successfully</h1>
          <p className="mt-2 text-muted">
            Thank you, <span className="font-semibold text-ink">{receipt.displayName}</span>. Your
            vote has been recorded.
          </p>
          <p className="mt-1 text-sm text-muted">You cannot vote again in this event.</p>
        </div>

        <dl className="divide-y divide-line">
          <div className="flex flex-wrap items-baseline justify-between gap-2 px-5 py-3">
            <dt className="text-sm text-muted">Event</dt>
            <dd className="font-medium">{event.title}</dd>
          </div>

          <div className="flex flex-wrap items-baseline justify-between gap-2 px-5 py-3">
            <dt className="text-sm text-muted">You chose</dt>
            <dd className="text-right font-medium">
              {receipt.optionNames.length > 0 ? receipt.optionNames.join(', ') : '--'}
            </dd>
          </div>

          <div className="flex flex-wrap items-baseline justify-between gap-2 px-5 py-3">
            <dt className="text-sm text-muted">Recorded at</dt>
            <dd className="text-sm">
              <LocalTime value={receipt.castAt.toISOString()} />
            </dd>
          </div>

          <div className="flex flex-wrap items-baseline justify-between gap-2 px-5 py-3">
            <dt className="text-sm text-muted">Receipt code</dt>
            <dd className="font-mono text-sm font-semibold tracking-wider">
              {receipt.receiptCode}
            </dd>
          </div>
        </dl>
      </Card>

      <p className="text-xs text-muted">
        Keep your receipt code if you need to ask an organiser about your vote. It identifies your
        ballot without revealing how you voted.
      </p>

      <div className="flex flex-wrap gap-2">
        {canSeeResults ? (
          <ButtonLink href={`/events/${slug}/results`}>See results</ButtonLink>
        ) : null}
        <ButtonLink href="/events" variant="secondary">
          Back to all events
        </ButtonLink>
      </div>
    </div>
  );
}
