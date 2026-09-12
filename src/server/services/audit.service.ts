import type { Prisma } from '@prisma/client';
import { prisma, type DbClient } from '@/lib/prisma';
import {
  appendAudit,
  countAuditActions,
  countAuditByAction,
  listAudit,
  type AuditEntry,
  type AuditFilters,
  type AuditRow,
} from '../repositories/audit.repository';
import type { AuditAction, AuditSeverity } from '@/types/domain';
import { SECURITY_AUDIT_ACTIONS } from '@/types/domain';
import type { RequestContext } from '@/lib/http';

/**
 * AuditService
 *
 * Writes the tamper-evident record of everything consequential that happens in
 * the system. Two entry points with deliberately different failure behaviour:
 *
 *   write()     - propagates errors. Used inside the vote transaction, where an
 *                 unrecordable vote must not be a recorded vote.
 *   safeWrite() - swallows and logs. Used on peripheral paths (a failed login,
 *                 a rate-limit trip) where losing the audit row is bad but
 *                 breaking the user's request over it is worse.
 *
 * Nothing written here may contain a secret. Metadata carries hashes, ids and
 * counts - never a session token, a password, or a raw IP address.
 */

/** Default severity per action, so call sites do not each invent one. */
const ACTION_SEVERITY: Partial<Record<AuditAction, AuditSeverity>> = {
  VOTE_DUPLICATE_BLOCKED: 'NOTICE',
  VOTE_SESSION_LIMIT_BLOCKED: 'NOTICE',
  VOTE_REJECTED: 'NOTICE',
  VOTE_FLAGGED_SUSPICIOUS: 'WARNING',
  VOTE_INVALIDATED: 'WARNING',
  VOTE_VOIDED_FOR_REVOTE: 'WARNING',
  RATE_LIMIT_TRIGGERED: 'WARNING',
  SUSPICIOUS_ACTIVITY_DETECTED: 'WARNING',
  CAPTCHA_FAILED: 'NOTICE',
  ADMIN_LOGIN_FAILED: 'NOTICE',
  ADMIN_LOCKED_OUT: 'WARNING',
  VOTER_BLOCKED: 'WARNING',
  VOTER_SESSION_BLOCKED: 'WARNING',
  ADMIN_CREATED: 'NOTICE',
  ADMIN_DEACTIVATED: 'WARNING',
  ADMIN_PASSWORD_CHANGED: 'NOTICE',
  EVENT_CLOSED: 'NOTICE',
  EVENT_ARCHIVED: 'NOTICE',
};

export type AuditInput = Omit<AuditEntry, 'severity'> & { severity?: AuditSeverity };

function withDefaults(input: AuditInput): AuditEntry {
  return {
    ...input,
    severity: input.severity ?? ACTION_SEVERITY[input.action] ?? 'INFO',
  };
}

/** Write an audit row, propagating any failure to the caller. */
export async function write(input: AuditInput, db: DbClient = prisma): Promise<void> {
  await appendAudit(withDefaults(input), db);
}

/** Write an audit row, never throwing. */
export async function safeWrite(input: AuditInput, db: DbClient = prisma): Promise<void> {
  try {
    await appendAudit(withDefaults(input), db);
  } catch (error) {
    // Losing an audit row is a real problem, so it is loud in the server log
    // even though it is not allowed to fail the request that triggered it.
    console.error('[AuditService] failed to write audit entry', {
      action: input.action,
      error,
    });
  }
}

/** Convenience: fold a request context into an entry. */
export function withContext(input: AuditInput, context: RequestContext): AuditInput {
  return {
    ...input,
    ipHash: input.ipHash ?? context.ipHash,
    userAgentHash: input.userAgentHash ?? context.userAgentHash,
  };
}

// --------------------------------------------------------------------------
// Voter-side helpers
// --------------------------------------------------------------------------

export async function recordVoterAction(
  params: {
    action: AuditAction;
    summary: string;
    eventId?: string | null;
    voterId?: string | null;
    sessionId?: string | null;
    voterLabel?: string | null;
    metadata?: Prisma.InputJsonValue;
    severity?: AuditSeverity;
    context?: RequestContext;
  },
  db: DbClient = prisma,
): Promise<void> {
  await safeWrite(
    {
      action: params.action,
      severity: params.severity,
      actorType: 'VOTER',
      actorLabel: params.voterLabel ?? null,
      eventId: params.eventId ?? null,
      voterId: params.voterId ?? null,
      voterSessionId: params.sessionId ?? null,
      ipHash: params.context?.ipHash ?? null,
      userAgentHash: params.context?.userAgentHash ?? null,
      summary: params.summary,
      ...(params.metadata === undefined ? {} : { metadata: params.metadata }),
    },
    db,
  );
}

// --------------------------------------------------------------------------
// Admin-side helpers
// --------------------------------------------------------------------------

export async function recordAdminAction(
  params: {
    action: AuditAction;
    summary: string;
    adminId: string | null;
    adminLabel: string | null;
    eventId?: string | null;
    voterId?: string | null;
    metadata?: Prisma.InputJsonValue;
    severity?: AuditSeverity;
    context?: RequestContext;
  },
  db: DbClient = prisma,
): Promise<void> {
  await safeWrite(
    {
      action: params.action,
      severity: params.severity,
      actorType: 'ADMIN',
      actorLabel: params.adminLabel,
      adminId: params.adminId,
      eventId: params.eventId ?? null,
      voterId: params.voterId ?? null,
      ipHash: params.context?.ipHash ?? null,
      userAgentHash: params.context?.userAgentHash ?? null,
      summary: params.summary,
      ...(params.metadata === undefined ? {} : { metadata: params.metadata }),
    },
    db,
  );
}

export async function recordSystemAction(
  params: {
    action: AuditAction;
    summary: string;
    eventId?: string | null;
    metadata?: Prisma.InputJsonValue;
    severity?: AuditSeverity;
  },
  db: DbClient = prisma,
): Promise<void> {
  await safeWrite(
    {
      action: params.action,
      severity: params.severity,
      actorType: 'SYSTEM',
      eventId: params.eventId ?? null,
      summary: params.summary,
      ...(params.metadata === undefined ? {} : { metadata: params.metadata }),
    },
    db,
  );
}

// --------------------------------------------------------------------------
// Reads
// --------------------------------------------------------------------------

export async function list(
  filters: AuditFilters,
  pagination: { page: number; pageSize: number },
): Promise<{ items: AuditRow[]; total: number }> {
  return listAudit(filters, pagination);
}

export async function listSecurity(
  filters: Omit<AuditFilters, 'actions'>,
  pagination: { page: number; pageSize: number },
): Promise<{ items: AuditRow[]; total: number }> {
  return listAudit({ ...filters, actions: [...SECURITY_AUDIT_ACTIONS] }, pagination);
}

export async function actionBreakdown(filters: AuditFilters) {
  return countAuditByAction(filters);
}

/** Tile counts for the security screen. */
export async function securitySummary(since: Date, eventId?: string) {
  const [duplicates, rateLimits, suspicious, failedLogins] = await Promise.all([
    countAuditActions(['VOTE_DUPLICATE_BLOCKED', 'VOTE_SESSION_LIMIT_BLOCKED'], since, eventId),
    countAuditActions(['RATE_LIMIT_TRIGGERED'], since, eventId),
    countAuditActions(['SUSPICIOUS_ACTIVITY_DETECTED', 'VOTE_FLAGGED_SUSPICIOUS'], since, eventId),
    countAuditActions(['ADMIN_LOGIN_FAILED', 'ADMIN_LOCKED_OUT'], since, undefined),
  ]);

  return { duplicates, rateLimits, suspicious, failedLogins };
}
