import type { Metadata } from 'next';
import Link from 'next/link';
import { Countdown, LocalTime } from '@/components/local-time';
import { Badge, ButtonLink, Card, EmptyState, PageHeader, StatusBadge } from '@/components/ui';
import { VOTING_TYPE_LABELS } from '@/types/domain';
import { toPublicEventSummary, type PublicEventSummary } from '@/server/presenters/public';
import * as EventService from '@/server/services/event.service';

export const metadata: Metadata = { title: 'Voting events' };
export const dynamic = 'force-dynamic';

/**
 * Step 1 of the voter flow: what can I vote on?
 *
 * Rendered on every request rather than cached. A ballot list is worthless if it
 * is thirty seconds stale at the moment an election opens or closes, and the
 * whole page is cheap - one query.
 */
export default async function EventsPage() {
  const events = await EventService.listPublicEvents();
  const now = new Date();
  const summaries = events.map((event) => toPublicEventSummary(event, now));

  const open = summaries.filter((event) => event.phase === 'OPEN');
  const upcoming = summaries.filter((event) => event.phase === 'UPCOMING');
  const ended = summaries.filter((event) => event.phase === 'ENDED');

  return (
    <div className="space-y-10">
      <PageHeader
        title="Community voting"
        description="Choose an event below, enter your in-game name, and cast your vote. No account needed."
      />

      {summaries.length === 0 ? (
        <EmptyState
          title="No voting events yet"
          description="When your community organisers open an election or a poll, it will appear here."
        />
      ) : null}

      {open.length > 0 ? (
        <Section title="Open now" count={open.length}>
          {open.map((event) => (
            <EventCard key={event.slug} event={event} emphasis />
          ))}
        </Section>
      ) : null}

      {upcoming.length > 0 ? (
        <Section title="Opening soon" count={upcoming.length}>
          {upcoming.map((event) => (
            <EventCard key={event.slug} event={event} />
          ))}
        </Section>
      ) : null}

      {ended.length > 0 ? (
        <Section title="Finished" count={ended.length}>
          {ended.map((event) => (
            <EventCard key={event.slug} event={event} />
          ))}
        </Section>
      ) : null}
    </div>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-faint">
        {title}
        <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs tabular-nums text-muted">
          {count}
        </span>
      </h2>
      <ul className="space-y-3">{children}</ul>
    </section>
  );
}

function EventCard({ event, emphasis }: { event: PublicEventSummary; emphasis?: boolean }) {
  const isOpen = event.phase === 'OPEN';

  return (
    <Card
      as="li"
      className={emphasis ? 'border-accent/40 p-5 shadow-pop' : 'p-5'}
    >
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={event.status} />
        <Badge tone="neutral">{VOTING_TYPE_LABELS[event.votingType]}</Badge>
      </div>

      <h3 className="mt-3 text-lg font-bold leading-snug">
        <Link href={`/events/${event.slug}`} className="hover:text-accent">
          {event.title}
        </Link>
      </h3>

      {/* Clamped so a long description cannot push the action out of reach. */}
      <p className="mt-1.5 line-clamp-3 text-sm text-muted">{event.description}</p>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div className="text-xs text-muted">
          {isOpen && event.endsAt ? (
            <Countdown deadline={event.endsAt} />
          ) : event.phase === 'UPCOMING' && event.startsAt ? (
            <>
              Opens <LocalTime value={event.startsAt} />
            </>
          ) : event.endsAt ? (
            <>
              Closed <LocalTime value={event.endsAt} />
            </>
          ) : null}
        </div>

        <ButtonLink
          href={`/events/${event.slug}`}
          variant={isOpen ? 'primary' : 'secondary'}
        >
          {isOpen ? 'Vote now' : event.phase === 'ENDED' ? 'View' : 'Details'}
        </ButtonLink>
      </div>
    </Card>
  );
}
