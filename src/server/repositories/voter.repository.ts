import type { Prisma } from '@prisma/client';
import { prisma, type DbClient } from '@/lib/prisma';
import type { IdentityMethod } from '@/types/domain';

/**
 * Data access for voter identities, browser sessions and per-event identity
 * claims - the three pieces the login-free identity model is built from.
 */

// --------------------------------------------------------------------------
// Voters
// --------------------------------------------------------------------------

export const voterSelect = {
  id: true,
  displayName: true,
  normalizedName: true,
  nameHash: true,
  confusableKey: true,
  isBlocked: true,
  blockedReason: true,
  firstSeenAt: true,
  lastSeenAt: true,
} satisfies Prisma.VoterSelect;

export type VoterRow = Prisma.VoterGetPayload<{ select: typeof voterSelect }>;

/**
 * Find or create the voter for a normalised IGN.
 *
 * An upsert keyed on `nameHash` rather than a read-then-create, because two
 * players typing the same name at the same moment would otherwise race and one
 * would get a unique-constraint error instead of a ballot.
 *
 * `displayName` is refreshed on every claim so admin views show the most recent
 * capitalisation the player actually used.
 */
export async function upsertVoter(
  data: {
    displayName: string;
    normalizedName: string;
    nameHash: string;
    confusableKey: string;
  },
  now: Date,
  db: DbClient = prisma,
): Promise<VoterRow> {
  return db.voter.upsert({
    where: { nameHash: data.nameHash },
    create: { ...data, firstSeenAt: now, lastSeenAt: now },
    update: { displayName: data.displayName, lastSeenAt: now },
    select: voterSelect,
  });
}

export async function findVoterByNameHash(
  nameHash: string,
  db: DbClient = prisma,
): Promise<VoterRow | null> {
  return db.voter.findUnique({ where: { nameHash }, select: voterSelect });
}

export async function findVoterById(
  id: string,
  db: DbClient = prisma,
): Promise<VoterRow | null> {
  return db.voter.findUnique({ where: { id }, select: voterSelect });
}

export async function setVoterBlocked(
  voterId: string,
  blocked: boolean,
  reason: string | null,
  db: DbClient = prisma,
): Promise<VoterRow> {
  return db.voter.update({
    where: { id: voterId },
    data: { isBlocked: blocked, blockedReason: blocked ? reason : null },
    select: voterSelect,
  });
}

/**
 * Other voters in this event whose names collapse to the same confusable key.
 *
 * This is the near-duplicate heuristic: `PlayerOne` and `P1ayerOne` both voting
 * in one election is worth a moderator's attention, even though neither is
 * blocked automatically.
 */
export async function findConfusableSiblingsInEvent(
  eventId: string,
  confusableKey: string,
  excludeVoterId: string,
  db: DbClient = prisma,
): Promise<Array<Pick<VoterRow, 'id' | 'displayName'>>> {
  return db.voter.findMany({
    where: {
      confusableKey,
      id: { not: excludeVoterId },
      votes: { some: { eventId, status: 'VALID' } },
    },
    select: { id: true, displayName: true },
    take: 10,
  });
}

export type AdminVoterListItem = VoterRow & { _count: { votes: number } };

export async function listVotersForAdmin(
  filters: { search?: string; blockedOnly?: boolean },
  pagination: { page: number; pageSize: number },
  db: DbClient = prisma,
): Promise<{ items: AdminVoterListItem[]; total: number }> {
  const where: Prisma.VoterWhereInput = {
    ...(filters.blockedOnly ? { isBlocked: true } : {}),
    ...(filters.search
      // No `mode: 'insensitive'` here: that option is PostgreSQL-only and
      // fails at runtime on MySQL, where the utf8mb4_unicode_ci
      // collation already compares case-insensitively.
      ? { normalizedName: { contains: filters.search.toLowerCase() } }
      : {}),
  };

  const [items, total] = await Promise.all([
    db.voter.findMany({
      where,
      select: { ...voterSelect, _count: { select: { votes: true } } },
      orderBy: { lastSeenAt: 'desc' },
      skip: (pagination.page - 1) * pagination.pageSize,
      take: pagination.pageSize,
    }),
    db.voter.count({ where }),
  ]);

  return { items, total };
}

/**
 * Identities that have actually cast a counted ballot somewhere.
 *
 * Not the same as `voter.count()`: a row is created the moment someone types a
 * name on the IGN screen, whether or not they go on to vote. Counting those as
 * "voters" would overstate turnout.
 */
export async function countVotersWithBallots(db: DbClient = prisma): Promise<number> {
  return db.voter.count({ where: { votes: { some: { status: 'VALID' } } } });
}

export async function countBlockedVoters(db: DbClient = prisma): Promise<number> {
  return db.voter.count({ where: { isBlocked: true } });
}

// --------------------------------------------------------------------------
// Browser sessions
// --------------------------------------------------------------------------

export const voterSessionSelect = {
  id: true,
  tokenHash: true,
  ipHash: true,
  userAgentHash: true,
  createdAt: true,
  lastSeenAt: true,
  expiresAt: true,
  isBlocked: true,
  blockedReason: true,
  voteCount: true,
  claimCount: true,
} satisfies Prisma.VoterSessionSelect;

export type VoterSessionRow = Prisma.VoterSessionGetPayload<{ select: typeof voterSessionSelect }>;

export async function createVoterSession(
  data: {
    tokenHash: string;
    ipHash: string | null;
    userAgentHash: string | null;
    expiresAt: Date;
  },
  db: DbClient = prisma,
): Promise<VoterSessionRow> {
  return db.voterSession.create({ data, select: voterSessionSelect });
}

export async function findVoterSessionByTokenHash(
  tokenHash: string,
  db: DbClient = prisma,
): Promise<VoterSessionRow | null> {
  return db.voterSession.findUnique({ where: { tokenHash }, select: voterSessionSelect });
}

export async function touchVoterSession(
  sessionId: string,
  now: Date,
  db: DbClient = prisma,
): Promise<void> {
  await db.voterSession.update({ where: { id: sessionId }, data: { lastSeenAt: now } });
}

export async function incrementSessionCounters(
  sessionId: string,
  counters: { votes?: number; claims?: number },
  db: DbClient = prisma,
): Promise<void> {
  await db.voterSession.update({
    where: { id: sessionId },
    data: {
      ...(counters.votes ? { voteCount: { increment: counters.votes } } : {}),
      ...(counters.claims ? { claimCount: { increment: counters.claims } } : {}),
    },
  });
}

export async function setVoterSessionBlocked(
  sessionId: string,
  blocked: boolean,
  reason: string | null,
  now: Date,
  db: DbClient = prisma,
): Promise<VoterSessionRow> {
  return db.voterSession.update({
    where: { id: sessionId },
    data: {
      isBlocked: blocked,
      blockedReason: blocked ? reason : null,
      blockedAt: blocked ? now : null,
    },
    select: voterSessionSelect,
  });
}

/** Delete expired sessions. Returns how many rows went. */
export async function deleteExpiredVoterSessions(
  now: Date,
  db: DbClient = prisma,
): Promise<number> {
  const result = await db.voterSession.deleteMany({ where: { expiresAt: { lt: now } } });
  return result.count;
}

// --------------------------------------------------------------------------
// Identity claims
// --------------------------------------------------------------------------

export const claimSelect = {
  id: true,
  eventId: true,
  sessionId: true,
  voterId: true,
  identityMethod: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.EventIdentityClaimSelect;

export type ClaimRow = Prisma.EventIdentityClaimGetPayload<{ select: typeof claimSelect }>;

/**
 * Record "this browser is PlayerOne for this event".
 *
 * Upsert on the (eventId, sessionId) unique key, so re-entering a name before
 * voting simply replaces the claim rather than accumulating rows. Once a vote
 * exists the vote's own unique constraint takes over and the claim no longer
 * matters.
 */
export async function upsertClaim(
  data: {
    eventId: string;
    sessionId: string;
    voterId: string;
    identityMethod: IdentityMethod;
  },
  db: DbClient = prisma,
): Promise<ClaimRow> {
  return db.eventIdentityClaim.upsert({
    where: { eventId_sessionId: { eventId: data.eventId, sessionId: data.sessionId } },
    create: data,
    update: { voterId: data.voterId, identityMethod: data.identityMethod },
    select: claimSelect,
  });
}

export async function findClaim(
  eventId: string,
  sessionId: string,
  db: DbClient = prisma,
): Promise<(ClaimRow & { voter: VoterRow }) | null> {
  return db.eventIdentityClaim.findUnique({
    where: { eventId_sessionId: { eventId, sessionId } },
    select: { ...claimSelect, voter: { select: voterSelect } },
  });
}

export async function deleteClaim(
  eventId: string,
  sessionId: string,
  db: DbClient = prisma,
): Promise<void> {
  await db.eventIdentityClaim.deleteMany({ where: { eventId, sessionId } });
}

/**
 * How many distinct identities this browser has claimed in one event.
 * More than one means someone tried several names here: not proof of fraud
 * (shared family PC) but firmly worth flagging.
 */
export async function countDistinctClaimedVoters(
  eventId: string,
  sessionId: string,
  db: DbClient = prisma,
): Promise<number> {
  const rows = await db.auditLog.findMany({
    where: { eventId, voterSessionId: sessionId, action: 'VOTER_IDENTITY_CLAIMED' },
    select: { voterId: true },
    distinct: ['voterId'],
    take: 25,
  });

  return rows.length;
}

/** How many browser sessions have claimed this identity in one event. */
export async function countSessionsClaimingVoter(
  eventId: string,
  voterId: string,
  db: DbClient = prisma,
): Promise<number> {
  return db.eventIdentityClaim.count({ where: { eventId, voterId } });
}
