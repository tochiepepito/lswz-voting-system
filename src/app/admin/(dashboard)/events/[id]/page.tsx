import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BallotModeration } from '@/components/admin/ballot-moderation';
import { DuplicateEventForm, LifecycleControls } from '@/components/admin/event-controls';
import { EventForm } from '@/components/admin/event-form';
import { OptionManager } from '@/components/admin/option-manager';
import { LocalTime } from '@/components/local-time';
import { ParticipationChart } from '@/components/participation-chart';
import { ResultsTally, TallyTable } from '@/components/results-tally';
import {
  Alert,
  Badge,
  Card,
  EmptyState,
  PageHeader,
  Stat,
  StatusBadge,
  cx,
} from '@/components/ui';
import { formatNumber } from '@/lib/format';
import {
  AUDIT_ACTION_LABELS,
  RESULTS_VISIBILITY_LABELS,
  VOTING_TYPE_LABELS,
  type AuditAction,
} from '@/types/domain';
import { requireAdminPage } from '@/server/auth/guard';
import * as AdminService from '@/server/services/admin.service';
import * as AuditService from '@/server/services/audit.service';
import * as EventService from '@/server/services/event.service';
import * as ResultsService from '@/server/services/results.service';
import { countOptionVotes } from '@/server/repositories/event.repository';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const event = await EventService.getEventForAdmin(id);

  return { title: event?.title ?? 'Event' };
}

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'options', label: 'Options' },
  { key: 'results', label: 'Results' },
  { key: 'ballots', label: 'Ballots' },
  { key: 'audit', label: 'Audit' },
  { key: 'settings', label: 'Settings' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

/**
 * Event detail.
 *
 * Tabs are driven by a query parameter rather than client state, so each one is
 * a real server-rendered view that can be linked, bookmarked and reloaded - and
 * so a tab an operator never opens costs nothing to render.
 */
export default async function AdminEventPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; filter?: string }>;
}) {
  const { admin } = await requireAdminPage('event:read');
  const { id } = await params;
  const query = await searchParams;

  const event = await EventService.getEventForAdmin(id);
  if (!event) notFound();

  const csrfToken = await AdminService.getAdminCsrfToken();
  const tab: TabKey = TABS.some((entry) => entry.key === query.tab)
    ? (query.tab as TabKey)
    : 'overview';

  const canWrite = AdminService.hasCapability(admin.role, 'event:write');
  const canModerate = AdminService.hasCapability(admin.role, 'vote:moderate');
  const canExport = AdminService.hasCapability(admin.role, 'results:export');

  const stats = await ResultsService.participationStats(event);

  return (
    <div className="space-y-5">
      <div>
        <Link href="/admin/events" className="text-sm text-muted hover:text-ink">
          ← Events
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
          <Link
            href={`/events/${event.slug}`}
            className="font-mono text-sm text-accent hover:underline"
          >
            /events/{event.slug} ↗
          </Link>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Counted votes" value={formatNumber(stats.totalBallots)} tone="accent" />
        <Stat label="Unique players" value={formatNumber(stats.distinctVoters)} />
        <Stat
          label="Flagged"
          value={formatNumber(stats.suspiciousVotes)}
          tone={stats.suspiciousVotes > 0 ? 'warn' : 'neutral'}
        />
        <Stat
          label="Invalidated"
          value={formatNumber(stats.invalidatedVotes)}
          tone={stats.invalidatedVotes > 0 ? 'danger' : 'neutral'}
        />
      </div>

      <nav className="flex gap-1 overflow-x-auto border-b border-line" aria-label="Event sections">
        {TABS.map((entry) => (
          <Link
            key={entry.key}
            href={`/admin/events/${event.id}?tab=${entry.key}`}
            aria-current={tab === entry.key ? 'page' : undefined}
            className={cx(
              '-mb-px whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors',
              tab === entry.key
                ? 'border-accent text-accent'
                : 'border-transparent text-muted hover:text-ink',
            )}
          >
            {entry.label}
          </Link>
        ))}
      </nav>

      {tab === 'overview' ? (
        <OverviewTab event={event} csrfToken={csrfToken} canWrite={canWrite} />
      ) : null}

      {tab === 'options' ? (
        <OptionsTab eventId={event.id} csrfToken={csrfToken} canWrite={canWrite} />
      ) : null}

      {tab === 'results' ? <ResultsTab event={event} canExport={canExport} /> : null}

      {tab === 'ballots' ? (
        <BallotsTab
          eventId={event.id}
          filter={query.filter}
          csrfToken={csrfToken}
          canModerate={canModerate}
        />
      ) : null}

      {tab === 'audit' ? <AuditTab eventId={event.id} /> : null}

      {tab === 'settings' ? (
        canWrite ? (
          <EventForm
            mode="edit"
            csrfToken={csrfToken}
            ballotLocked={stats.totalBallots > 0}
            defaults={{
              id: event.id,
              title: event.title,
              slug: event.slug,
              description: event.description,
              instructions: event.instructions ?? '',
              votingType: event.votingType,
              minSelections: event.minSelections,
              maxSelections: event.maxSelections,
              startsAt: event.startsAt,
              endsAt: event.endsAt,
              resultsVisibility: event.resultsVisibility,
              maxVotesPerSession: event.maxVotesPerSession,
              ipSoftLimit: event.ipSoftLimit,
              requireCaptcha: event.requireCaptcha,
            }}
          />
        ) : (
          <Alert tone="info">Your role can view this event but not change it.</Alert>
        )
      ) : null}
    </div>
  );
}

// --------------------------------------------------------------------------

async function OverviewTab({
  event,
  csrfToken,
  canWrite,
}: {
  event: NonNullable<Awaited<ReturnType<typeof EventService.getEventForAdmin>>>;
  csrfToken: string | null;
  canWrite: boolean;
}) {
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card className="space-y-4 p-5">
        <h2 className="font-semibold">Lifecycle</h2>
        {canWrite ? (
          <LifecycleControls eventId={event.id} status={event.status} csrfToken={csrfToken} />
        ) : (
          <p className="text-sm text-muted">Your role cannot change the event status.</p>
        )}
      </Card>

      <Card className="p-5">
        <h2 className="mb-4 font-semibold">Configuration</h2>
        <dl className="space-y-3 text-sm">
          <Row label="Opens">
            {event.startsAt ? <LocalTime value={event.startsAt.toISOString()} /> : 'On publish'}
          </Row>
          <Row label="Closes">
            {event.endsAt ? <LocalTime value={event.endsAt.toISOString()} /> : 'Manually'}
          </Row>
          <Row label="Results">{RESULTS_VISIBILITY_LABELS[event.resultsVisibility]}</Row>
          <Row label="Selections">
            {event.minSelections === event.maxSelections
              ? `Exactly ${event.maxSelections}`
              : `${event.minSelections} to ${event.maxSelections}`}
          </Row>
          <Row label="Votes per browser">{event.maxVotesPerSession}</Row>
          <Row label="Flag network above">
            {event.ipSoftLimit === 0 ? 'Disabled' : `${event.ipSoftLimit} votes`}
          </Row>
          <Row label="CAPTCHA">{event.requireCaptcha ? 'Required' : 'Off'}</Row>
          <Row label="Created">
            <LocalTime value={event.createdAt.toISOString()} />
          </Row>
        </dl>
      </Card>

      <Card className="space-y-3 p-5 lg:col-span-2">
        <h2 className="font-semibold">Description</h2>
        <p className="whitespace-pre-line text-sm text-muted">{event.description}</p>
        {event.instructions ? (
          <>
            <h3 className="pt-2 text-sm font-semibold">Instructions</h3>
            <p className="whitespace-pre-line text-sm text-muted">{event.instructions}</p>
          </>
        ) : null}
      </Card>

      {canWrite ? (
        <div className="lg:col-span-2">
          <DuplicateEventForm
            eventId={event.id}
            suggestedTitle={event.title}
            csrfToken={csrfToken}
          />
        </div>
      ) : null}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line pb-2 last:border-0 last:pb-0">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right font-medium">{children}</dd>
    </div>
  );
}

async function OptionsTab({
  eventId,
  csrfToken,
  canWrite,
}: {
  eventId: string;
  csrfToken: string | null;
  canWrite: boolean;
}) {
  const options = await EventService.getOptions(eventId);

  // Vote counts drive whether deletion is offered at all.
  const managed = await Promise.all(
    options.map(async (option) => ({
      id: option.id,
      name: option.name,
      description: option.description,
      imageUrl: option.imageUrl,
      displayOrder: option.displayOrder,
      isActive: option.isActive,
      voteCount: await countOptionVotes(option.id),
    })),
  );

  return (
    <OptionManager
      eventId={eventId}
      options={managed}
      csrfToken={csrfToken}
      editable={canWrite}
    />
  );
}

async function ResultsTab({
  event,
  canExport,
}: {
  event: NonNullable<Awaited<ReturnType<typeof EventService.getEventForAdmin>>>;
  canExport: boolean;
}) {
  const results = await ResultsService.getAdminResults(event);

  if (results.totalBallots === 0) {
    return (
      <EmptyState
        title="No votes yet"
        description="Results appear here as soon as the first ballot is cast."
        icon="📊"
      />
    );
  }

  const rows = results.options.map((option) => ({
    optionId: option.optionId,
    name: option.name,
    description: option.description,
    votes: option.votes,
    isActive: option.isActive,
  }));

  return (
    <div className="space-y-5">
      {canExport ? (
        <div className="flex flex-wrap gap-2">
          {(['summary', 'ballots', 'participants'] as const).map((format) => (
            <a
              key={format}
              href={`/api/admin/events/${event.id}/export?format=${format}`}
              className="rounded-lg border border-line px-3 py-2 text-sm font-medium hover:bg-surface-2"
            >
              Export {format} CSV
            </a>
          ))}
        </div>
      ) : null}

      <Card className="p-5">
        <h2 className="mb-4 font-semibold">
          Results · {formatNumber(results.totalBallots)} ballots
        </h2>
        <ResultsTally
          rows={rows}
          totalBallots={results.totalBallots}
          isMultipleChoice={event.votingType === 'MULTIPLE_CHOICE'}
        />
      </Card>

      <Card className="p-5">
        <h2 className="mb-4 font-semibold">Turnout over time</h2>
        <ParticipationChart
          data={(results.participation ?? []).map((point) => ({
            bucket: point.bucket.toISOString(),
            votes: point.votes,
          }))}
        />
      </Card>

      {results.integrity && results.integrity.heavyNetworks.length > 0 ? (
        <Card className="p-5">
          <h2 className="font-semibold">Network concentration</h2>
          <p className="mt-1 text-xs text-muted">
            Networks that produced several ballots. Shared connections are normal in a guild, so
            this is a prompt to look, not evidence of anything.
          </p>
          <ul className="mt-3 space-y-1.5 text-sm">
            {results.integrity.heavyNetworks.map((network) => (
              <li key={network.ipHash} className="flex justify-between gap-3">
                <span className="truncate font-mono text-xs text-faint">
                  {network.ipHash.slice(0, 16)}…
                </span>
                <span className="tabular-nums">{formatNumber(network.votes)} votes</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <TallyTable rows={rows} totalBallots={results.totalBallots} />
    </div>
  );
}

async function BallotsTab({
  eventId,
  filter,
  csrfToken,
  canModerate,
}: {
  eventId: string;
  filter?: string;
  csrfToken: string | null;
  canModerate: boolean;
}) {
  const { items, total } = await ResultsService.listBallots(
    eventId,
    {
      suspiciousOnly: filter === 'flagged',
      invalidatedOnly: filter === 'invalidated',
    },
    { page: 1, pageSize: 100 },
  );

  return (
    <div className="space-y-4">
      <nav className="flex flex-wrap gap-1" aria-label="Filter ballots">
        {[
          ['', 'All'],
          ['flagged', 'Flagged'],
          ['invalidated', 'Invalidated'],
        ].map(([value, label]) => (
          <Link
            key={label}
            href={`/admin/events/${eventId}?tab=ballots${value ? `&filter=${value}` : ''}`}
            aria-current={(filter ?? '') === value ? 'page' : undefined}
            className={cx(
              'rounded-lg px-3 py-1.5 text-sm font-medium',
              (filter ?? '') === value
                ? 'bg-accent text-accent-ink'
                : 'text-muted hover:bg-surface-2 hover:text-ink',
            )}
          >
            {label}
          </Link>
        ))}
      </nav>

      {!canModerate ? (
        <Alert tone="info">
          Your role can review ballots but not invalidate them.
        </Alert>
      ) : null}

      {items.length === 0 ? (
        <EmptyState title="No ballots match" description="Try a different filter." icon="🗳️" />
      ) : (
        <>
          <p className="text-sm text-muted">{formatNumber(total)} ballots</p>
          <ul className="space-y-3">
            {items.map((ballot) => (
              <li key={ballot.id}>
                <BallotModeration
                  csrfToken={csrfToken}
                  ballot={{
                    id: ballot.id,
                    receiptCode: ballot.receiptCode,
                    voterName: ballot.voter.displayName,
                    status: ballot.status,
                    isSuspicious: ballot.isSuspicious,
                    suspicionReasons: ballot.suspicionReasons,
                    invalidationReason: ballot.invalidationReason,
                    selections: ballot.selections.map((selection) => selection.option.name),
                  }}
                />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

async function AuditTab({ eventId }: { eventId: string }) {
  const { items } = await AuditService.list({ eventId }, { page: 1, pageSize: 100 });

  if (items.length === 0) {
    return <EmptyState title="No audit entries yet" icon="📜" />;
  }

  return (
    <Card className="divide-y divide-line">
      {items.map((entry) => (
        <div key={entry.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
          <Badge
            tone={
              entry.severity === 'CRITICAL'
                ? 'danger'
                : entry.severity === 'WARNING'
                  ? 'warn'
                  : entry.severity === 'NOTICE'
                    ? 'info'
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
              {entry.actorLabel ? ` · ${entry.actorLabel}` : ''}
            </p>
          </div>
        </div>
      ))}
    </Card>
  );
}
