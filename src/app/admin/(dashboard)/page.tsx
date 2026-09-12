import type { Metadata } from 'next';
import Link from 'next/link';
import { LocalTime } from '@/components/local-time';
import {
  Alert,
  Badge,
  ButtonLink,
  Card,
  EmptyState,
  PageHeader,
  Stat,
  StatusBadge,
} from '@/components/ui';
import { formatNumber } from '@/lib/format';
import { AUDIT_ACTION_LABELS, type AuditAction } from '@/types/domain';
import { requireAdminPage } from '@/server/auth/guard';
import * as AuditService from '@/server/services/audit.service';
import * as EventService from '@/server/services/event.service';

export const metadata: Metadata = { title: 'Overview' };
export const dynamic = 'force-dynamic';

const DAY_MS = 24 * 60 * 60 * 1000;

export default async function AdminOverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ denied?: string }>;
}) {
  const { admin } = await requireAdminPage();
  const params = await searchParams;

  const since = new Date(Date.now() - 7 * DAY_MS);

  const [counts, events, security, recent] = await Promise.all([
    EventService.overviewCounts(),
    EventService.listForAdmin({}, { page: 1, pageSize: 5 }),
    AuditService.securitySummary(since),
    AuditService.list({ since }, { page: 1, pageSize: 8 }),
  ]);

  const flagged = security.duplicates + security.rateLimits + security.suspicious;

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Welcome back, ${admin.displayName.split(' ')[0]}`}
        description="Everything happening across your community's voting events."
        actions={<ButtonLink href="/admin/events/new">New event</ButtonLink>}
      />

      {params.denied ? (
        <Alert tone="warn" title="Not permitted">
          Your role does not allow that section.
        </Alert>
      ) : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Active" value={formatNumber(counts.active)} tone="ok" hint="Open for voting" />
        <Stat label="Upcoming" value={formatNumber(counts.scheduled)} hint="Scheduled to open" />
        <Stat label="Closed" value={formatNumber(counts.closed)} hint="Voting finished" />
        <Stat
          label="Total votes"
          value={formatNumber(counts.totalVotes)}
          tone="accent"
          hint="Counted ballots"
        />
      </div>

      {flagged > 0 ? (
        <Alert tone="warn" title={`${formatNumber(flagged)} security events in the last 7 days`}>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs">
            <span>{formatNumber(security.duplicates)} duplicate attempts blocked</span>
            <span>{formatNumber(security.rateLimits)} rate limits triggered</span>
            <span>{formatNumber(security.suspicious)} ballots flagged</span>
          </div>
          <Link href="/admin/security" className="mt-2 inline-block text-xs font-semibold underline">
            Review security activity →
          </Link>
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-semibold">Recent events</h2>
            <Link href="/admin/events" className="text-sm text-accent hover:underline">
              All events
            </Link>
          </div>

          {events.items.length === 0 ? (
            <EmptyState
              title="No events yet"
              description="Create your first voting event to get started."
              action={<ButtonLink href="/admin/events/new">New event</ButtonLink>}
            />
          ) : (
            <ul className="space-y-2">
              {events.items.map((event) => (
                <Card as="li" key={event.id} className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Link
                        href={`/admin/events/${event.id}`}
                        className="truncate font-semibold hover:text-accent"
                      >
                        {event.title}
                      </Link>
                      <div className="mt-1.5 flex flex-wrap items-center gap-2">
                        <StatusBadge status={event.status} />
                        <span className="text-xs text-muted">
                          {formatNumber(event._count.votes)} votes ·{' '}
                          {formatNumber(event._count.options)} options
                        </span>
                      </div>
                    </div>
                  </div>
                </Card>
              ))}
            </ul>
          )}
        </section>

        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-semibold">Recent activity</h2>
            <Link href="/admin/security" className="text-sm text-accent hover:underline">
              Full audit log
            </Link>
          </div>

          {recent.items.length === 0 ? (
            <Card className="p-5 text-sm text-muted">Nothing has happened in the last 7 days.</Card>
          ) : (
            <Card className="divide-y divide-line">
              {recent.items.map((entry) => (
                <div key={entry.id} className="flex items-start gap-3 px-4 py-3">
                  <Badge
                    tone={
                      entry.severity === 'CRITICAL' || entry.severity === 'WARNING'
                        ? 'warn'
                        : 'neutral'
                    }
                    className="mt-0.5 shrink-0"
                  >
                    {AUDIT_ACTION_LABELS[entry.action as AuditAction]}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">{entry.summary}</p>
                    <p className="mt-0.5 text-xs text-faint">
                      <LocalTime value={entry.createdAt.toISOString()} />
                    </p>
                  </div>
                </div>
              ))}
            </Card>
          )}
        </section>
      </div>
    </div>
  );
}
