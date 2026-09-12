import type { Metadata } from 'next';
import Link from 'next/link';
import { VoterModeration } from '@/components/admin/ballot-moderation';
import {
  EventParticipationPanel,
  VoterEventHistory,
} from '@/components/admin/event-participation';
import { LocalTime } from '@/components/local-time';
import { Alert, Badge, Card, EmptyState, PageHeader, cx } from '@/components/ui';
import { formatNumber } from '@/lib/format';
import { requireAdminPage } from '@/server/auth/guard';
import * as AdminService from '@/server/services/admin.service';
import * as ResultsService from '@/server/services/results.service';
import * as VoterService from '@/server/services/voter.service';

export const metadata: Metadata = { title: 'Voters' };
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

/**
 * Voter directory.
 *
 * Shows the three representations of an identity side by side, because the
 * distinction matters when judging a dispute: `displayName` is what the player
 * typed, `normalizedName` is what the system compares, and the hash is what
 * would survive a data purge.
 */
export default async function VotersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; blocked?: string; page?: string }>;
}) {
  const { admin } = await requireAdminPage('event:read');
  const params = await searchParams;

  const search = params.q?.trim() || undefined;
  const blockedOnly = params.blocked === '1';
  const page = Math.max(1, Number(params.page ?? 1) || 1);

  const csrfToken = await AdminService.getAdminCsrfToken();
  const canModerate = AdminService.hasCapability(admin.role, 'voter:moderate');

  const [{ items, total }, participation] = await Promise.all([
    VoterService.listForAdmin(
      { ...(search ? { search } : {}), blockedOnly },
      { page, pageSize: PAGE_SIZE },
    ),
    ResultsService.participationByEvent(),
  ]);

  // Only the voters actually on this page: an election with thousands of
  // ballots must not be loaded whole to decorate fifty rows.
  const history = await ResultsService.participationForVoters(items.map((voter) => voter.id));

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-5">
      <PageHeader
        title="Voters"
        description={`${formatNumber(total)} in-game name${total === 1 ? '' : 's'} seen across all events.`}
      />

      <Alert tone="info">
        An in-game name is a claim, not an identity. Blocking one prevents that name from voting in
        future events; it does not remove ballots already cast.
      </Alert>

      <EventParticipationPanel overview={participation} />

      <h2 className="pt-2 font-semibold">Voter directory</h2>

      <div className="flex flex-wrap items-center gap-3">
        <nav className="flex gap-1" aria-label="Filter voters">
          <Link
            href="/admin/voters"
            aria-current={!blockedOnly ? 'page' : undefined}
            className={cx(
              'rounded-lg px-3 py-1.5 text-sm font-medium',
              !blockedOnly ? 'bg-accent text-accent-ink' : 'text-muted hover:bg-surface-2',
            )}
          >
            All
          </Link>
          <Link
            href="/admin/voters?blocked=1"
            aria-current={blockedOnly ? 'page' : undefined}
            className={cx(
              'rounded-lg px-3 py-1.5 text-sm font-medium',
              blockedOnly ? 'bg-accent text-accent-ink' : 'text-muted hover:bg-surface-2',
            )}
          >
            Blocked
          </Link>
        </nav>

        <form className="ml-auto" action="/admin/voters">
          {blockedOnly ? <input type="hidden" name="blocked" value="1" /> : null}
          <input
            type="search"
            name="q"
            defaultValue={search ?? ''}
            placeholder="Search in-game name"
            aria-label="Search voters"
            className="w-56 rounded-lg border border-line bg-surface px-3 py-2 text-sm"
          />
        </form>
      </div>

      {items.length === 0 ? (
        <EmptyState
          title={blockedOnly ? 'Nobody is blocked' : 'No voters yet'}
          description={
            blockedOnly
              ? 'Blocked in-game names will appear here.'
              : 'Voters appear here once they join their first event.'
          }
          icon="👥"
        />
      ) : (
        <ul className="space-y-2">
          {items.map((voter) => (
            <Card as="li" key={voter.id} className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{voter.displayName}</span>
                    {voter.isBlocked ? <Badge tone="danger">Blocked</Badge> : null}
                    <Badge tone="neutral">{formatNumber(voter._count.votes)} votes</Badge>
                  </div>

                  <dl className="mt-2 space-y-0.5 text-xs">
                    <div className="flex gap-2">
                      <dt className="w-20 shrink-0 text-faint">normalised</dt>
                      <dd className="font-mono text-muted">{voter.normalizedName}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="w-20 shrink-0 text-faint">hash</dt>
                      <dd className="truncate font-mono text-faint">
                        {voter.nameHash.slice(0, 24)}…
                      </dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="w-20 shrink-0 text-faint">last seen</dt>
                      <dd className="text-muted">
                        <LocalTime value={voter.lastSeenAt.toISOString()} />
                      </dd>
                    </div>
                  </dl>

                  {voter.blockedReason ? (
                    <p className="mt-2 text-xs text-danger">Reason: {voter.blockedReason}</p>
                  ) : null}

                  <VoterEventHistory entries={history.get(voter.id) ?? []} />
                </div>

                {canModerate ? (
                  <div className="shrink-0">
                    <VoterModeration
                      voterId={voter.id}
                      voterName={voter.displayName}
                      isBlocked={voter.isBlocked}
                      csrfToken={csrfToken}
                    />
                  </div>
                ) : null}
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
                href={`/admin/voters?page=${page - 1}${blockedOnly ? '&blocked=1' : ''}${search ? `&q=${encodeURIComponent(search)}` : ''}`}
                className="rounded-lg border border-line px-3 py-1.5 hover:bg-surface-2"
              >
                Previous
              </Link>
            ) : null}
            {page < totalPages ? (
              <Link
                href={`/admin/voters?page=${page + 1}${blockedOnly ? '&blocked=1' : ''}${search ? `&q=${encodeURIComponent(search)}` : ''}`}
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
