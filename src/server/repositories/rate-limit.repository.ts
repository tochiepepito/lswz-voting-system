import type { Prisma } from '@prisma/client';
import { isUniqueViolation, prisma, type DbClient } from '@/lib/prisma';
import type { RateLimitScope } from '@/types/domain';

/**
 * Data access for rate-limit counters.
 *
 * The counters live in MySQL rather than in process memory on purpose: the
 * app is expected to run as more than one instance (or on a serverless platform
 * where every request may be a fresh isolate), and an in-memory limiter under
 * those conditions multiplies every limit by the instance count while appearing
 * to work perfectly in development.
 */

export type ConsumeResult = {
  /** Count *after* this request was recorded. */
  count: number;
  windowEnd: Date;
};

/**
 * Atomically record one hit against a fixed window and return the new count.
 *
 * The `upsert` compiles to an insert-or-update on the unique `bucketKey`, so
 * the increment happens inside the database and concurrent requests cannot both
 * read a stale count and write the same value back.
 *
 * A concurrent insert can still lose the upsert race and surface as P2002; that
 * is retried once as a plain update, which is guaranteed to succeed because the
 * row now exists.
 */
export async function consumeRateLimit(
  params: {
    bucketKey: string;
    scope: RateLimitScope;
    identifierHash: string;
    windowStart: Date;
    windowEnd: Date;
  },
  now: Date,
  db: DbClient = prisma,
): Promise<ConsumeResult> {
  const create: Prisma.RateLimitRecordCreateInput = {
    bucketKey: params.bucketKey,
    scope: params.scope,
    identifierHash: params.identifierHash,
    windowStart: params.windowStart,
    windowEnd: params.windowEnd,
    count: 1,
    lastHitAt: now,
  };

  try {
    const record = await db.rateLimitRecord.upsert({
      where: { bucketKey: params.bucketKey },
      create,
      update: { count: { increment: 1 }, lastHitAt: now },
      select: { count: true, windowEnd: true },
    });

    return record;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;

    const record = await db.rateLimitRecord.update({
      where: { bucketKey: params.bucketKey },
      data: { count: { increment: 1 }, lastHitAt: now },
      select: { count: true, windowEnd: true },
    });

    return record;
  }
}

/** Note that a request was actually refused, for the security dashboard. */
export async function recordRateLimitBlock(
  bucketKey: string,
  db: DbClient = prisma,
): Promise<void> {
  await db.rateLimitRecord.updateMany({
    where: { bucketKey },
    data: { blockedCount: { increment: 1 } },
  });
}

/** Read a window without recording a hit. */
export async function peekRateLimit(
  bucketKey: string,
  db: DbClient = prisma,
): Promise<{ count: number; windowEnd: Date } | null> {
  return db.rateLimitRecord.findUnique({
    where: { bucketKey },
    select: { count: true, windowEnd: true },
  });
}

export type RateLimitViolation = {
  scope: RateLimitScope;
  identifierHash: string;
  count: number;
  blockedCount: number;
  windowStart: Date;
  windowEnd: Date;
  lastHitAt: Date;
};

/** Buckets that actually refused traffic, newest first. */
export async function listRateLimitViolations(
  since: Date,
  limit = 50,
  db: DbClient = prisma,
): Promise<RateLimitViolation[]> {
  const rows = await db.rateLimitRecord.findMany({
    where: { blockedCount: { gt: 0 }, lastHitAt: { gte: since } },
    select: {
      scope: true,
      identifierHash: true,
      count: true,
      blockedCount: true,
      windowStart: true,
      windowEnd: true,
      lastHitAt: true,
    },
    orderBy: { lastHitAt: 'desc' },
    take: limit,
  });

  return rows as RateLimitViolation[];
}

/**
 * Drop windows that have elapsed.
 *
 * Called opportunistically rather than on a schedule, so the table stays small
 * without the deployment needing a cron job to be correct.
 */
export async function deleteExpiredRateLimitRecords(
  now: Date,
  db: DbClient = prisma,
): Promise<number> {
  const result = await db.rateLimitRecord.deleteMany({ where: { windowEnd: { lt: now } } });
  return result.count;
}
