import Link from 'next/link';
import { LocalTime } from '../local-time';
import { Badge, Card, EmptyState, Stat, StatusBadge, cx } from '../ui';
import { formatNumber } from '@/lib/format';
import { VOTING_TYPE_LABELS } from '@/types/domain';
import type { EventParticipationRow, ParticipationOverview } from '@/server/services/results.service';

/**
 * Voting statistics broken down by event.
 *
 * FORM: magnitude across a handful of named categories, so a horizontal bar per
 * event, sorted busiest first. Laid out as rows rather than a `<table>` because
 * this screen is read on a laptop *and* on a phone mid-election, and a six-column
 * table at 400px is either unreadable or horizontally scrolling.
 *
 * COLOR: one hue for every bar. All events encode the same measure, so this is a
 * single series - and tinting the busiest event differently would be colour by
 * rank, which repaints the chart whenever turnout changes.
 *
 * Every bar is directly labelled, so no hover layer is needed to read a value.
 */

export function EventParticipationPanel({ overview }: { overview: ParticipationOverview }) {
  const { rows, totals } = overview;

  if (rows.length === 0) {
    return (
      <EmptyState
        title="No events yet"
        description="Per-event voting statistics appear here once an event exists."
        icon="📊"
      />
    );
  }

  const withVotes = rows.filter((row) => row.counted > 0);
  const withoutVotes = rows.filter((row) => row.counted === 0);

  return (
    <section className="space-y-4">
      <div>
        <h2 className="font-semibold">Voting statistics per event</h2>
        <p className="mt-1 text-xs text-muted">
          Counted ballots only. Because one identity can hold at most one ballot per event, the
          counted figure is also the number of distinct voters in that event.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Voters who voted"
          value={formatNumber(totals.knownVoters)}
          tone="accent"
          hint="Distinct names, all events"
        />
        <Stat
          label="Counted ballots"
          value={formatNumber(totals.countedBallots)}
          hint={`Across ${formatNumber(totals.eventsWithVotes)} ${
            totals.eventsWithVotes === 1 ? 'event' : 'events'
          }`}
        />
        <Stat
          label="Flagged"
          value={formatNumber(totals.flaggedBallots)}
          tone={totals.flaggedBallots > 0 ? 'warn' : 'neutral'}
          hint="Counted, needs review"
        />
        <Stat
          label="Blocked names"
          value={formatNumber(totals.blockedVoters)}
          tone={totals.blockedVoters > 0 ? 'danger' : 'neutral'}
          hint="Cannot vote again"
        />
      </div>

      <Card className="divide-y divide-line">
        {withVotes.map((row) => (
          <EventRow key={row.eventId} row={row} />
        ))}

        {withoutVotes.length > 0 ? (
          <details className="group">
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-muted hover:text-ink">
              {formatNumber(withoutVotes.length)} event
              {withoutVotes.length === 1 ? '' : 's'} with no ballots yet
            </summary>
            <div className="divide-y divide-line border-t border-line">
              {withoutVotes.map((row) => (
                <EventRow key={row.eventId} row={row} />
              ))}
            </div>
          </details>
        ) : null}
      </Card>
    </section>
  );
}

function EventRow({ row }: { row: EventParticipationRow }) {
  const hasVotes = row.counted > 0;

  /*
   * Session data exists only for ballots cast through the web flow. Seeded or
   * imported ballots carry no session, so `distinctSessions` is 0 while
   * `counted` is large - and rendering that as "0 devices" would read as an
   * alarming finding rather than as missing information.
   *
   * The badge is therefore shown only when there IS session data AND it reveals
   * something: fewer devices than ballots, i.e. a shared device.
   */
  const hasSessionData = row.distinctSessions > 0;
  const sharedDevices = hasSessionData ? Math.max(0, row.counted - row.distinctSessions) : 0;

  return (
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Link
            href={`/admin/events/${row.eventId}?tab=results`}
            className="truncate font-medium hover:text-accent"
          >
            {row.title}
          </Link>
          <StatusBadge status={row.status} />
        </div>

        <span className="shrink-0 text-sm tabular-nums">
          <span className="font-bold">{formatNumber(row.counted)}</span>
          <span className="text-muted"> {row.counted === 1 ? 'ballot' : 'ballots'}</span>
        </span>
      </div>

      <div className="mt-2 tally-track" role="img" aria-label={`${row.title}: ${formatNumber(row.counted)} counted ballots`}>
        <div
          className="tally-fill bg-accent"
          style={{ width: `${Math.max(row.relativeShare, hasVotes ? 2 : 0)}%` }}
        />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        <span>{VOTING_TYPE_LABELS[row.votingType]}</span>

        {row.flagged > 0 ? (
          <Link
            href={`/admin/events/${row.eventId}?tab=ballots&filter=flagged`}
            className="hover:underline"
          >
            <Badge tone="warn">{formatNumber(row.flagged)} flagged</Badge>
          </Link>
        ) : null}

        {row.invalidated > 0 ? (
          <Link
            href={`/admin/events/${row.eventId}?tab=ballots&filter=invalidated`}
            className="hover:underline"
          >
            <Badge tone="danger">{formatNumber(row.invalidated)} invalidated</Badge>
          </Link>
        ) : null}

        {sharedDevices > 0 ? (
          <Badge tone="neutral">
            {formatNumber(row.counted)} ballots from {formatNumber(row.distinctSessions)}{' '}
            {row.distinctSessions === 1 ? 'device' : 'devices'}
          </Badge>
        ) : null}

        {row.lastBallotAt ? (
          <span>
            last vote <LocalTime value={row.lastBallotAt.toISOString()} />
          </span>
        ) : (
          <span className="text-faint">no ballots yet</span>
        )}
      </div>
    </div>
  );
}

/**
 * Which events one voter took part in.
 *
 * Shown inline on each voter row, because the question an organiser actually has
 * when looking at a name is "where did this person vote", and a bare total
 * cannot answer it.
 */
export function VoterEventHistory({
  entries,
}: {
  entries: ReadonlyArray<{
    eventId: string;
    eventTitle: string;
    castAt: Date;
    status: string;
    isSuspicious: boolean;
  }>;
}) {
  if (entries.length === 0) {
    return (
      <p className="mt-2 text-xs text-faint">
        Entered a name but has not cast a ballot in any event.
      </p>
    );
  }

  return (
    <div className="mt-2">
      <p className="text-xs font-medium text-faint">Voted in</p>
      <ul className="mt-1 flex flex-wrap gap-1.5">
        {entries.map((entry) => {
          const invalidated = entry.status === 'INVALIDATED';

          return (
            <li key={entry.eventId}>
              <Link
                href={`/admin/events/${entry.eventId}?tab=ballots`}
                className={cx(
                  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors',
                  invalidated
                    ? 'border-danger/25 bg-danger/10 text-danger line-through'
                    : entry.isSuspicious
                      ? 'border-warn/25 bg-warn/10 text-warn'
                      : 'border-line bg-surface-2 text-muted hover:text-ink',
                )}
                title={
                  invalidated
                    ? 'This ballot was invalidated and is not counted'
                    : entry.isSuspicious
                      ? 'This ballot is counted but flagged for review'
                      : 'Counted'
                }
              >
                <span className="max-w-[14rem] truncate">{entry.eventTitle}</span>
                {entry.isSuspicious && !invalidated ? <span aria-hidden="true">⚑</span> : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
