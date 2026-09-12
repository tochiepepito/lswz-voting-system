import type { Metadata } from 'next';
import Link from 'next/link';
import { LocalTime } from '@/components/local-time';
import { Alert, Badge, Card, EmptyState, PageHeader, Stat, cx } from '@/components/ui';
import { formatNumber } from '@/lib/format';
import { AUDIT_ACTION_LABELS, type AuditAction, type AuditSeverity } from '@/types/domain';
import { requireAdminPage } from '@/server/auth/guard';
import * as AuditService from '@/server/services/audit.service';
import * as RateLimitService from '@/server/services/rate-limit.service';

export const metadata: Metadata = { title: 'Security' };
export const dynamic = 'force-dynamic';

const WINDOWS = [
  { key: '24h', label: 'Last 24 hours', hours: 24 },
  { key: '7d', label: 'Last 7 days', hours: 24 * 7 },
  { key: '30d', label: 'Last 30 days', hours: 24 * 30 },
] as const;

/**
 * Security and abuse review.
 *
 * Everything here is a prompt for a human, not an automated verdict. The system
 * blocks only what it can be certain about (a genuine duplicate, a rate limit)
 * and flags everything else for an organiser who knows the community.
 */
export default async function SecurityPage({
  searchParams,
}: {
  searchParams: Promise<{ window?: string; severity?: string }>;
}) {
  await requireAdminPage('audit:read');
  const params = await searchParams;

  const window = WINDOWS.find((entry) => entry.key === params.window) ?? WINDOWS[1];
  const since = new Date(Date.now() - window.hours * 3_600_000);

  const severity = (['INFO', 'NOTICE', 'WARNING', 'CRITICAL'] as const).includes(
    params.severity as AuditSeverity,
  )
    ? (params.severity as AuditSeverity)
    : undefined;

  const [summary, security, violations] = await Promise.all([
    AuditService.securitySummary(since),
    AuditService.listSecurity(
      { since, ...(severity ? { severity } : {}) },
      { page: 1, pageSize: 100 },
    ),
    RateLimitService.recentViolations(since, 25),
  ]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Security &amp; audit"
        description="Duplicate attempts, rate limits, flagged ballots and administrative actions."
      />

      <nav className="flex flex-wrap gap-1" aria-label="Time window">
        {WINDOWS.map((entry) => (
          <Link
            key={entry.key}
            href={`/admin/security?window=${entry.key}`}
            aria-current={window.key === entry.key ? 'page' : undefined}
            className={cx(
              'rounded-lg px-3 py-1.5 text-sm font-medium',
              window.key === entry.key
                ? 'bg-accent text-accent-ink'
                : 'text-muted hover:bg-surface-2 hover:text-ink',
            )}
          >
            {entry.label}
          </Link>
        ))}
      </nav>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Duplicates blocked"
          value={formatNumber(summary.duplicates)}
          tone={summary.duplicates > 0 ? 'warn' : 'neutral'}
          hint="Second ballot refused"
        />
        <Stat
          label="Rate limits hit"
          value={formatNumber(summary.rateLimits)}
          tone={summary.rateLimits > 0 ? 'warn' : 'neutral'}
          hint="Requests refused"
        />
        <Stat
          label="Flagged ballots"
          value={formatNumber(summary.suspicious)}
          tone={summary.suspicious > 0 ? 'warn' : 'neutral'}
          hint="Counted, needs review"
        />
        <Stat
          label="Failed sign-ins"
          value={formatNumber(summary.failedLogins)}
          tone={summary.failedLogins > 0 ? 'danger' : 'neutral'}
          hint="Administrator accounts"
        />
      </div>

      <Alert tone="info">
        Flagged ballots are still counted. Flagging means &ldquo;a human should look at this&rdquo;,
        not &ldquo;this is fraud&rdquo; - shared networks and similar names are normal in a gaming
        community.
      </Alert>

      {violations.length > 0 ? (
        <Card className="p-5">
          <h2 className="font-semibold">Rate-limit violations</h2>
          <p className="mt-1 text-xs text-muted">
            Identifiers are stored as keyed hashes; raw IP addresses are never written to the
            database.
          </p>

          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-faint">
                  <th scope="col" className="py-2 pr-4 font-semibold">
                    Scope
                  </th>
                  <th scope="col" className="py-2 pr-4 font-semibold">
                    Identifier
                  </th>
                  <th scope="col" className="py-2 pr-4 text-right font-semibold">
                    Requests
                  </th>
                  <th scope="col" className="py-2 pr-4 text-right font-semibold">
                    Refused
                  </th>
                  <th scope="col" className="py-2 font-semibold">
                    Last seen
                  </th>
                </tr>
              </thead>
              <tbody>
                {violations.map((violation) => (
                  <tr
                    key={`${violation.scope}-${violation.identifierHash}-${violation.windowStart.toISOString()}`}
                    className="border-b border-line last:border-0"
                  >
                    <td className="py-2 pr-4">
                      <Badge tone="warn">{violation.scope.replace(/_/g, ' ')}</Badge>
                    </td>
                    <td className="py-2 pr-4 font-mono text-xs text-faint">
                      {violation.identifierHash.slice(0, 14)}…
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums">
                      {formatNumber(violation.count)}
                    </td>
                    <td className="py-2 pr-4 text-right font-semibold tabular-nums text-danger">
                      {formatNumber(violation.blockedCount)}
                    </td>
                    <td className="py-2 text-xs text-muted">
                      <LocalTime value={violation.lastHitAt.toISOString()} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-semibold">Security events</h2>
          <nav className="flex gap-1" aria-label="Filter by severity">
            {([undefined, 'NOTICE', 'WARNING', 'CRITICAL'] as const).map((value) => (
              <Link
                key={value ?? 'all'}
                href={`/admin/security?window=${window.key}${value ? `&severity=${value}` : ''}`}
                aria-current={severity === value ? 'page' : undefined}
                className={cx(
                  'rounded-lg px-2.5 py-1 text-xs font-medium',
                  severity === value
                    ? 'bg-accent text-accent-ink'
                    : 'text-muted hover:bg-surface-2 hover:text-ink',
                )}
              >
                {value ? value.charAt(0) + value.slice(1).toLowerCase() : 'All'}
              </Link>
            ))}
          </nav>
        </div>

        {security.items.length === 0 ? (
          <EmptyState
            title="Nothing to review"
            description={`No security events in the ${window.label.toLowerCase()}.`}
            icon="🛡️"
          />
        ) : (
          <Card className="divide-y divide-line">
            {security.items.map((entry) => (
              <div key={entry.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
                <Badge
                  tone={
                    entry.severity === 'CRITICAL'
                      ? 'danger'
                      : entry.severity === 'WARNING'
                        ? 'warn'
                        : 'info'
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

                {entry.eventId ? (
                  <Link
                    href={`/admin/events/${entry.eventId}?tab=ballots&filter=flagged`}
                    className="shrink-0 text-xs font-medium text-accent hover:underline"
                  >
                    Review →
                  </Link>
                ) : null}
              </div>
            ))}
          </Card>
        )}
      </section>
    </div>
  );
}
