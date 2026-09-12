import type { Metadata } from 'next';
import Link from 'next/link';
import { LocalTime } from '@/components/local-time';
import { ButtonLink, Card, EmptyState, PageHeader, StatusBadge, cx } from '@/components/ui';
import { formatNumber } from '@/lib/format';
import { EVENT_STATUS_LABELS, VOTING_TYPE_LABELS, type EventStatus } from '@/types/domain';
import { requireAdminPage } from '@/server/auth/guard';
import * as EventService from '@/server/services/event.service';

export const metadata: Metadata = { title: 'Events' };
export const dynamic = 'force-dynamic';

const STATUSES: Array<EventStatus | 'ALL'> = [
  'ALL',
  'DRAFT',
  'SCHEDULED',
  'ACTIVE',
  'CLOSED',
  'ARCHIVED',
];

const PAGE_SIZE = 25;

export default async function AdminEventsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string; page?: string }>;
}) {
  await requireAdminPage('event:read');
  const params = await searchParams;

  const status = STATUSES.includes(params.status as EventStatus)
    ? (params.status as EventStatus)
    : undefined;

  const search = params.q?.trim() || undefined;
  const page = Math.max(1, Number(params.page ?? 1) || 1);

  const { items, total } = await EventService.listForAdmin(
    { ...(status ? { status } : {}), ...(search ? { search } : {}) },
    { page, pageSize: PAGE_SIZE },
  );

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-5">
      <PageHeader
        title="Events"
        description={`${formatNumber(total)} event${total === 1 ? '' : 's'}`}
        actions={<ButtonLink href="/admin/events/new">New event</ButtonLink>}
      />

      {/* Filters kept in the URL so a filtered view is linkable and survives a reload. */}
      <div className="flex flex-wrap items-center gap-3">
        <nav className="flex flex-wrap gap-1" aria-label="Filter by status">
          {STATUSES.map((value) => {
            const isActive = value === 'ALL' ? !status : status === value;
            const href =
              value === 'ALL'
                ? '/admin/events'
                : `/admin/events?status=${value}`;

            return (
              <Link
                key={value}
                href={href}
                aria-current={isActive ? 'page' : undefined}
                className={cx(
                  'rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-accent text-accent-ink'
                    : 'text-muted hover:bg-surface-2 hover:text-ink',
                )}
              >
                {value === 'ALL' ? 'All' : EVENT_STATUS_LABELS[value]}
              </Link>
            );
          })}
        </nav>

        <form className="ml-auto" action="/admin/events">
          {status ? <input type="hidden" name="status" value={status} /> : null}
          <input
            type="search"
            name="q"
            defaultValue={search ?? ''}
            placeholder="Search title or slug"
            aria-label="Search events"
            className="w-56 rounded-lg border border-line bg-surface px-3 py-2 text-sm"
          />
        </form>
      </div>

      {items.length === 0 ? (
        <EmptyState
          title={search || status ? 'No events match that filter' : 'No events yet'}
          description={
            search || status
              ? 'Try a different status or search term.'
              : 'Create your first voting event to get started.'
          }
          action={<ButtonLink href="/admin/events/new">New event</ButtonLink>}
        />
      ) : (
        <ul className="space-y-2">
          {items.map((event) => (
            <Card as="li" key={event.id} className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <Link
                    href={`/admin/events/${event.id}`}
                    className="font-semibold hover:text-accent"
                  >
                    {event.title}
                  </Link>

                  <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted">
                    <StatusBadge status={event.status} />
                    <span>{VOTING_TYPE_LABELS[event.votingType]}</span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono">/{event.slug}</span>
                  </div>

                  {event.endsAt ? (
                    <p className="mt-1.5 text-xs text-faint">
                      {event.status === 'CLOSED' || event.status === 'ARCHIVED'
                        ? 'Closed '
                        : 'Closes '}
                      <LocalTime value={event.endsAt.toISOString()} />
                    </p>
                  ) : null}
                </div>

                <div className="flex shrink-0 gap-6 text-right">
                  <div>
                    <div className="text-lg font-bold tabular-nums">
                      {formatNumber(event._count.votes)}
                    </div>
                    <div className="text-xs text-faint">votes</div>
                  </div>
                  <div>
                    <div className="text-lg font-bold tabular-nums">
                      {formatNumber(event._count.options)}
                    </div>
                    <div className="text-xs text-faint">options</div>
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </ul>
      )}

      {totalPages > 1 ? (
        <nav className="flex items-center justify-between text-sm" aria-label="Pagination">
          <span className="text-muted">
            Page {page} of {totalPages}
          </span>
          <div className="flex gap-2">
            {page > 1 ? (
              <Link
                href={`/admin/events?${new URLSearchParams({ ...(status ? { status } : {}), ...(search ? { q: search } : {}), page: String(page - 1) })}`}
                className="rounded-lg border border-line px-3 py-1.5 hover:bg-surface-2"
              >
                Previous
              </Link>
            ) : null}
            {page < totalPages ? (
              <Link
                href={`/admin/events?${new URLSearchParams({ ...(status ? { status } : {}), ...(search ? { q: search } : {}), page: String(page + 1) })}`}
                className="rounded-lg border border-line px-3 py-1.5 hover:bg-surface-2"
              >
                Next
              </Link>
            ) : null}
          </div>
        </nav>
      ) : null}
    </div>
  );
}
