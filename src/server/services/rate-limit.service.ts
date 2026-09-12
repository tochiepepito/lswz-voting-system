import { env } from '@/lib/env';
import { appError } from '@/lib/errors';
import { hashRateLimitBucket, hashRateLimitIdentifier } from '@/lib/crypto';
import { prisma, type DbClient } from '@/lib/prisma';
import {
  consumeRateLimit,
  deleteExpiredRateLimitRecords,
  listRateLimitViolations,
  recordRateLimitBlock,
} from '../repositories/rate-limit.repository';
import type { RateLimitScope } from '@/types/domain';
import * as AuditService from './audit.service';

/**
 * RateLimitService
 *
 * Fixed-window counters, stored in MySQL and keyed by an HMAC of the
 * identifier, so the table never contains a raw IP address.
 *
 * A fixed window rather than a sliding one is a deliberate trade: it permits a
 * burst of up to 2x the limit across a window boundary, and in exchange it costs
 * exactly one atomic upsert per request instead of a growing set of timestamps.
 * For an election that is the right trade - the limits exist to stop scripted
 * ballot-stuffing, not to smooth traffic, and the duplicate-vote constraint is
 * what actually protects correctness.
 */

export type RateLimitRule = {
  scope: RateLimitScope;
  limit: number;
  windowSeconds: number;
};

export const RATE_LIMIT_RULES: Record<RateLimitScope, RateLimitRule> = {
  VOTE_SESSION: {
    scope: 'VOTE_SESSION',
    limit: env.RL_VOTE_SESSION_MAX,
    windowSeconds: env.RL_VOTE_SESSION_WINDOW_SECONDS,
  },
  VOTE_IP: {
    scope: 'VOTE_IP',
    limit: env.RL_VOTE_IP_MAX,
    windowSeconds: env.RL_VOTE_IP_WINDOW_SECONDS,
  },
  CLAIM_IP: {
    scope: 'CLAIM_IP',
    limit: env.RL_CLAIM_IP_MAX,
    windowSeconds: env.RL_CLAIM_IP_WINDOW_SECONDS,
  },
  ADMIN_LOGIN_IP: {
    scope: 'ADMIN_LOGIN_IP',
    limit: env.RL_LOGIN_IP_MAX,
    windowSeconds: env.RL_LOGIN_IP_WINDOW_SECONDS,
  },
  ADMIN_LOGIN_ACCOUNT: {
    scope: 'ADMIN_LOGIN_ACCOUNT',
    limit: env.RL_LOGIN_IP_MAX,
    windowSeconds: env.RL_LOGIN_IP_WINDOW_SECONDS,
  },
};

export type RateLimitDecision = {
  allowed: boolean;
  /** Requests still available in this window. */
  remaining: number;
  retryAfterSeconds: number;
  /** True when no identifier was available and the limit could not be applied. */
  skipped: boolean;
};

const ALLOWED_UNIDENTIFIED: RateLimitDecision = {
  allowed: true,
  remaining: Number.POSITIVE_INFINITY,
  retryAfterSeconds: 0,
  skipped: true,
};

/** Start of the fixed window containing `now`. */
function windowStartFor(now: Date, windowSeconds: number): Date {
  const windowMs = windowSeconds * 1000;
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs);
}

/**
 * Record one hit and decide whether it is allowed.
 *
 * `identifier` is a raw value (an IP, a session id, an e-mail). It is hashed
 * before it touches the database.
 *
 * When `identifier` is null the limit is SKIPPED rather than denied. That case
 * means the deployment could not determine a client IP - refusing every such
 * request would take the whole election offline behind a misconfigured proxy,
 * which is a far worse failure than a missing rate limit.
 */
export async function consume(
  scope: RateLimitScope,
  identifier: string | null,
  options: { now?: Date; db?: DbClient } = {},
): Promise<RateLimitDecision> {
  if (!identifier) return ALLOWED_UNIDENTIFIED;

  const rule = RATE_LIMIT_RULES[scope];
  const now = options.now ?? new Date();
  const db = options.db ?? prisma;

  const windowStart = windowStartFor(now, rule.windowSeconds);
  const windowEnd = new Date(windowStart.getTime() + rule.windowSeconds * 1000);
  const bucketKey = hashRateLimitBucket(scope, identifier, windowStart.getTime());

  const result = await consumeRateLimit(
    {
      bucketKey,
      scope,
      identifierHash: hashRateLimitIdentifier(scope, identifier),
      windowStart,
      windowEnd,
    },
    now,
    db,
  );

  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((result.windowEnd.getTime() - now.getTime()) / 1000),
  );

  if (result.count > rule.limit) {
    await recordRateLimitBlock(bucketKey, db).catch(() => undefined);

    return { allowed: false, remaining: 0, retryAfterSeconds, skipped: false };
  }

  return {
    allowed: true,
    remaining: Math.max(0, rule.limit - result.count),
    retryAfterSeconds: 0,
    skipped: false,
  };
}

/**
 * Consume and throw a RATE_LIMITED AppError when the limit is exceeded.
 * The audit row is written before throwing, so a scripted attack leaves a trail
 * even though every one of its requests is refused.
 */
export async function enforce(
  scope: RateLimitScope,
  identifier: string | null,
  auditContext: {
    summary: string;
    eventId?: string | null;
    voterId?: string | null;
    sessionId?: string | null;
    ipHash?: string | null;
    userAgentHash?: string | null;
  },
  options: { now?: Date; db?: DbClient } = {},
): Promise<void> {
  const decision = await consume(scope, identifier, options);
  if (decision.allowed) return;

  await AuditService.safeWrite({
    action: 'RATE_LIMIT_TRIGGERED',
    actorType: 'SYSTEM',
    eventId: auditContext.eventId ?? null,
    voterId: auditContext.voterId ?? null,
    voterSessionId: auditContext.sessionId ?? null,
    ipHash: auditContext.ipHash ?? null,
    userAgentHash: auditContext.userAgentHash ?? null,
    summary: auditContext.summary,
    metadata: {
      scope,
      limit: RATE_LIMIT_RULES[scope].limit,
      windowSeconds: RATE_LIMIT_RULES[scope].windowSeconds,
      retryAfterSeconds: decision.retryAfterSeconds,
    },
  });

  throw appError('RATE_LIMITED', { retryAfterSeconds: decision.retryAfterSeconds });
}

/** Recent buckets that actually refused traffic. */
export async function recentViolations(since: Date, limit = 50) {
  return listRateLimitViolations(since, limit);
}

/**
 * Housekeeping. Called opportunistically (roughly 1 request in 200) rather than
 * from a cron job, so a deployment with no scheduler still keeps the table
 * bounded.
 */
export async function pruneExpired(now: Date = new Date()): Promise<number> {
  return deleteExpiredRateLimitRecords(now);
}

export function shouldPrune(): boolean {
  return Math.random() < 0.005;
}
