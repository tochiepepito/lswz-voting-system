import type { Prisma } from '@prisma/client';
import { prisma, type DbClient } from '@/lib/prisma';
import type { IdentityMethod } from '@/types/domain';

/**
 * Data access for votes, their selections and every aggregate derived from them.
 *
 * Tallies are always computed from `vote_selections` joined to votes with
 * `status = VALID`. There is no denormalised counter anywhere in the system, so
 * invalidating a vote immediately and correctly changes every number on every
 * screen, and no counter can drift out of step with the ballots.
 */

export const voteSelect = {
  id: true,
  receiptCode: true,
  eventId: true,
  voterId: true,
  sessionId: true,
  identityMethod: true,
  status: true,
  isSuspicious: true,
  suspicionReasons: true,
  ipHash: true,
  castAt: true,
  invalidatedAt: true,
  invalidationReason: true,
} satisfies Prisma.VoteSelect;

type VoteRowRaw = Prisma.VoteGetPayload<{ select: typeof voteSelect }>;

/**
 * A vote as the rest of the application sees it.
 *
 * `suspicionReasons` is a JSON column in MySQL (no array type), so the stored
 * shape and the domain shape differ. This repository is the ONE place that
 * bridges them - nothing above it ever handles a `Prisma.JsonValue`.
 */
export type VoteRow = Omit<VoteRowRaw, 'suspicionReasons'> & { suspicionReasons: string[] };

/**
 * Decode a JSON column into a string array.
 *
 * Tolerant by design: a null, a legacy value or hand-edited row yields an empty
 * list rather than throwing. These are advisory moderation flags, and a
 * malformed one must never be able to break a results page or an export.
 */
function decodeSuspicionReasons(value: Prisma.JsonValue | null): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function toVoteRow(row: VoteRowRaw): VoteRow {
  return { ...row, suspicionReasons: decodeSuspicionReasons(row.suspicionReasons) };
}

// --------------------------------------------------------------------------
// Writes
// --------------------------------------------------------------------------

export type CreateVoteData = {
  eventId: string;
  voterId: string;
  sessionId: string | null;
  identityMethod: IdentityMethod;
  receiptCode: string;
  ipHash: string | null;
  userAgentHash: string | null;
  isSuspicious: boolean;
  suspicionReasons: string[];
  optionIds: readonly string[];
};

/**
 * Insert a vote and all of its selections as one statement group.
 *
 * The nested `create` means Prisma emits the vote row and its selection rows
 * inside the caller's transaction: either a complete ballot exists or none of
 * it does. There is no window in which a vote row is visible with no selections
 * attached, which would silently under-count an election.
 *
 * Throws P2002 on `(eventId, voterId)` when the identity has already voted.
 * Callers must let that surface - it is the real duplicate-vote guarantee.
 */
export async function createVoteWithSelections(
  data: CreateVoteData,
  db: DbClient = prisma,
): Promise<VoteRow> {
  const { optionIds, suspicionReasons, ...vote } = data;

  const created = await db.vote.create({
    data: {
      ...vote,
      // Encoded here, decoded in toVoteRow: the JSON column never escapes.
      suspicionReasons: suspicionReasons as Prisma.InputJsonValue,
      selections: { create: optionIds.map((optionId) => ({ optionId })) },
    },
    select: voteSelect,
  });

  return toVoteRow(created);
}

export async function findVoteByEventAndVoter(
  eventId: string,
  voterId: string,
  db: DbClient = prisma,
): Promise<VoteRow | null> {
  const row = await db.vote.findUnique({
    where: { eventId_voterId: { eventId, voterId } },
    select: voteSelect,
  });

  return row ? toVoteRow(row) : null;
}

export async function findVoteById(id: string, db: DbClient = prisma): Promise<VoteRow | null> {
  const row = await db.vote.findUnique({ where: { id }, select: voteSelect });
  return row ? toVoteRow(row) : null;
}

/** A vote plus everything an admin needs to judge it. */
export async function findVoteDetail(id: string, db: DbClient = prisma) {
  const row = await db.vote.findUnique({
    where: { id },
    select: {
      ...voteSelect,
      voter: { select: { id: true, displayName: true, normalizedName: true } },
      selections: { select: { optionId: true, option: { select: { name: true } } } },
      event: { select: { id: true, title: true, slug: true } },
    },
  });

  return row ? { ...row, suspicionReasons: decodeSuspicionReasons(row.suspicionReasons) } : null;
}

export async function invalidateVote(
  voteId: string,
  adminId: string,
  reason: string,
  now: Date,
  db: DbClient = prisma,
): Promise<number> {
  // Guarded on the current status so a double-click cannot overwrite the
  // original invalidation reason and timestamp.
  const result = await db.vote.updateMany({
    where: { id: voteId, status: 'VALID' },
    data: {
      status: 'INVALIDATED',
      invalidatedAt: now,
      invalidatedById: adminId,
      invalidationReason: reason,
    },
  });

  return result.count;
}

export async function restoreVote(voteId: string, db: DbClient = prisma): Promise<number> {
  const result = await db.vote.updateMany({
    where: { id: voteId, status: 'INVALIDATED' },
    data: {
      status: 'VALID',
      invalidatedAt: null,
      invalidatedById: null,
      invalidationReason: null,
    },
  });

  return result.count;
}

/**
 * Remove a vote entirely, freeing the (event, voter) unique slot.
 *
 * Only used by the explicit "void and allow a re-vote" moderation action, and
 * only after the ballot's full content has been written into the audit log, so
 * deleting the row destroys no history.
 */
export async function deleteVote(voteId: string, db: DbClient = prisma): Promise<number> {
  const result = await db.vote.deleteMany({ where: { id: voteId } });
  return result.count;
}

// --------------------------------------------------------------------------
// Counting & abuse signals
// --------------------------------------------------------------------------

export async function countValidVotes(eventId: string, db: DbClient = prisma): Promise<number> {
  return db.vote.count({ where: { eventId, status: 'VALID' } });
}

export async function countVotesBySession(
  eventId: string,
  sessionId: string,
  db: DbClient = prisma,
): Promise<number> {
  return db.vote.count({ where: { eventId, sessionId, status: 'VALID' } });
}

export async function countVotesByIp(
  eventId: string,
  ipHash: string,
  db: DbClient = prisma,
): Promise<number> {
  return db.vote.count({ where: { eventId, ipHash, status: 'VALID' } });
}

export async function countSuspiciousVotes(
  eventId: string,
  db: DbClient = prisma,
): Promise<number> {
  return db.vote.count({ where: { eventId, isSuspicious: true, status: 'VALID' } });
}

export async function countInvalidatedVotes(
  eventId: string,
  db: DbClient = prisma,
): Promise<number> {
  return db.vote.count({ where: { eventId, status: 'INVALIDATED' } });
}

/** Distinct identities that cast a counted ballot. */
export async function countDistinctVoters(
  eventId: string,
  db: DbClient = prisma,
): Promise<number> {
  const rows = await db.vote.findMany({
    where: { eventId, status: 'VALID' },
    select: { voterId: true },
    distinct: ['voterId'],
  });

  return rows.length;
}

// --------------------------------------------------------------------------
// Tallies
// --------------------------------------------------------------------------

export type OptionTally = { optionId: string; votes: number };

/**
 * Votes per option, counting only VALID ballots.
 *
 * For a multiple-choice event the totals across options legitimately exceed the
 * ballot count, because one ballot contributes a selection to each option it
 * picked. Percentages in the UI are therefore always computed against the
 * ballot count, never against the sum of this list.
 */
export async function tallyByOption(
  eventId: string,
  db: DbClient = prisma,
): Promise<OptionTally[]> {
  const rows = await db.voteSelection.groupBy({
    by: ['optionId'],
    where: { vote: { eventId, status: 'VALID' } },
    _count: { _all: true },
  });

  return rows.map((row) => ({ optionId: row.optionId, votes: row._count._all }));
}

export type ParticipationPoint = { bucket: Date; votes: number };

/**
 * Votes per time bucket, for the participation chart.
 *
 * Raw SQL because Prisma cannot express date-truncated grouping. MySQL has no
 * `date_trunc`, so the timestamp is formatted down to the wanted precision with
 * `DATE_FORMAT` and re-parsed. Truncating to the start of the hour or day is
 * exactly what the chart needs, and formatting is indexable-adjacent enough at
 * the row counts an election produces.
 *
 * The event id is bound by the template tag. The format string is NOT
 * interpolated from the argument: it is chosen from a fixed pair by a branch, so
 * there is no path from caller input into the SQL text at all.
 */
export async function participationOverTime(
  eventId: string,
  granularity: 'hour' | 'day',
  db: DbClient = prisma,
): Promise<ParticipationPoint[]> {
  // Two separate literal statements rather than one with an interpolated format
  // string - the safest possible handling of a value that cannot be a parameter.
  const rows =
    granularity === 'hour'
      ? await db.$queryRaw<Array<{ bucket: string; votes: bigint | number }>>`
          SELECT DATE_FORMAT(castAt, '%Y-%m-%d %H:00:00') AS bucket,
                 COUNT(*) AS votes
          FROM votes
          WHERE eventId = ${eventId}
            AND status = 'VALID'
          GROUP BY bucket
          ORDER BY bucket ASC
        `
      : await db.$queryRaw<Array<{ bucket: string; votes: bigint | number }>>`
          SELECT DATE_FORMAT(castAt, '%Y-%m-%d 00:00:00') AS bucket,
                 COUNT(*) AS votes
          FROM votes
          WHERE eventId = ${eventId}
            AND status = 'VALID'
          GROUP BY bucket
          ORDER BY bucket ASC
        `;

  return rows.map((row) => ({
    // MySQL returns the formatted bucket as a string in server-local time, and
    // COUNT(*) as a BigInt that JSON cannot serialise - both are normalised here
    // so nothing above this layer has to know.
    bucket: new Date(`${row.bucket.replace(' ', 'T')}Z`),
    votes: Number(row.votes),
  }));
}

/** Distinct IP buckets that produced votes, with their counts. Abuse triage. */
export async function votesPerIpHash(
  eventId: string,
  minimumCount: number,
  db: DbClient = prisma,
): Promise<Array<{ ipHash: string; votes: number }>> {
  const rows = await db.vote.groupBy({
    by: ['ipHash'],
    where: { eventId, status: 'VALID', ipHash: { not: null } },
    _count: { _all: true },
    orderBy: { _count: { ipHash: 'desc' } },
    take: 50,
  });

  return rows
    .filter((row) => row.ipHash !== null && row._count._all >= minimumCount)
    .map((row) => ({ ipHash: row.ipHash as string, votes: row._count._all }));
}

// --------------------------------------------------------------------------
// Admin listings & export
// --------------------------------------------------------------------------

export type AdminVoteListItem = VoteRow & {
  voter: { id: string; displayName: string; normalizedName: string };
  selections: Array<{ optionId: string; option: { name: string } }>;
};

export async function listVotesForAdmin(
  eventId: string,
  filters: { suspiciousOnly?: boolean; invalidatedOnly?: boolean; search?: string },
  pagination: { page: number; pageSize: number },
  db: DbClient = prisma,
): Promise<{ items: AdminVoteListItem[]; total: number }> {
  const where: Prisma.VoteWhereInput = {
    eventId,
    ...(filters.suspiciousOnly ? { isSuspicious: true } : {}),
    ...(filters.invalidatedOnly ? { status: 'INVALIDATED' } : {}),
    ...(filters.search
      ? { voter: { normalizedName: { contains: filters.search.toLowerCase() } } }
      : {}),
  };

  const [items, total] = await Promise.all([
    db.vote.findMany({
      where,
      select: {
        ...voteSelect,
        voter: { select: { id: true, displayName: true, normalizedName: true } },
        selections: { select: { optionId: true, option: { select: { name: true } } } },
      },
      orderBy: { castAt: 'desc' },
      skip: (pagination.page - 1) * pagination.pageSize,
      take: pagination.pageSize,
    }),
    db.vote.count({ where }),
  ]);

  return {
    items: items.map((item) => ({
      ...item,
      suspicionReasons: decodeSuspicionReasons(item.suspicionReasons),
    })),
    total,
  };
}

export type ExportBallotRow = {
  receiptCode: string;
  displayName: string;
  castAt: Date;
  status: string;
  isSuspicious: boolean;
  suspicionReasons: string[];
  identityMethod: string;
  selections: Array<{ name: string }>;
};

/** Every ballot in an event, ordered oldest first, for CSV export. */
export async function listBallotsForExport(
  eventId: string,
  db: DbClient = prisma,
): Promise<ExportBallotRow[]> {
  const rows = await db.vote.findMany({
    where: { eventId },
    select: {
      receiptCode: true,
      castAt: true,
      status: true,
      isSuspicious: true,
      suspicionReasons: true,
      identityMethod: true,
      voter: { select: { displayName: true } },
      selections: {
        select: { option: { select: { name: true } } },
        orderBy: { option: { displayOrder: 'asc' } },
      },
    },
    orderBy: { castAt: 'asc' },
  });

  return rows.map((row) => ({
    receiptCode: row.receiptCode,
    displayName: row.voter.displayName,
    castAt: row.castAt,
    status: row.status,
    isSuspicious: row.isSuspicious,
    suspicionReasons: decodeSuspicionReasons(row.suspicionReasons),
    identityMethod: row.identityMethod,
    selections: row.selections.map((selection) => ({ name: selection.option.name })),
  }));
}

/** Total counted ballots across the whole system, for the dashboard tile. */
export async function countAllValidVotes(db: DbClient = prisma): Promise<number> {
  return db.vote.count({ where: { status: 'VALID' } });
}

// --------------------------------------------------------------------------
// Cross-event participation
// --------------------------------------------------------------------------

export type EventVoteStats = {
  eventId: string;
  /** Ballots that count toward the tally. */
  counted: number;
  /** Excluded from the tally by a moderator, but still on record. */
  invalidated: number;
  /** Counted, but carrying at least one signal a human should look at. */
  flagged: number;
  /**
   * Distinct browser sessions that produced the counted ballots.
   *
   * Lower than `counted` means several ballots came from one device - normal at
   * a LAN event, worth a look otherwise. Higher is impossible.
   */
  distinctSessions: number;
  firstBallotAt: Date | null;
  lastBallotAt: Date | null;
};

/**
 * Ballot statistics for every event at once.
 *
 * Deliberately NOT a "distinct voters" count: `votes` carries a unique
 * constraint on (eventId, voterId), so one voter can hold at most one row per
 * event and distinct voters is always exactly equal to `counted`. Reporting both
 * would present one number twice and imply a difference that cannot exist.
 *
 * Four grouped queries rather than raw SQL, so this stays portable and needs no
 * hand-written aggregation.
 */
export async function voteStatsByEvent(db: DbClient = prisma): Promise<EventVoteStats[]> {
  const [counted, invalidated, flagged, sessionPairs] = await Promise.all([
    db.vote.groupBy({
      by: ['eventId'],
      where: { status: 'VALID' },
      _count: { _all: true },
      _min: { castAt: true },
      _max: { castAt: true },
    }),
    db.vote.groupBy({
      by: ['eventId'],
      where: { status: 'INVALIDATED' },
      _count: { _all: true },
    }),
    db.vote.groupBy({
      by: ['eventId'],
      where: { status: 'VALID', isSuspicious: true },
      _count: { _all: true },
    }),
    // One row per (event, session) pair; counting the rows per event gives the
    // number of distinct devices without a DISTINCT-on-expression query.
    db.vote.groupBy({
      by: ['eventId', 'sessionId'],
      where: { status: 'VALID', sessionId: { not: null } },
    }),
  ]);

  const invalidatedByEvent = new Map(invalidated.map((row) => [row.eventId, row._count._all]));
  const flaggedByEvent = new Map(flagged.map((row) => [row.eventId, row._count._all]));

  const sessionsByEvent = new Map<string, number>();
  for (const pair of sessionPairs) {
    sessionsByEvent.set(pair.eventId, (sessionsByEvent.get(pair.eventId) ?? 0) + 1);
  }

  // Events with only invalidated ballots still deserve a row, so the union of
  // both key sets is used rather than just the counted ones.
  const eventIds = new Set([
    ...counted.map((row) => row.eventId),
    ...invalidated.map((row) => row.eventId),
  ]);

  const countedByEvent = new Map(counted.map((row) => [row.eventId, row]));

  return [...eventIds].map((eventId) => {
    const row = countedByEvent.get(eventId);

    return {
      eventId,
      counted: row?._count._all ?? 0,
      invalidated: invalidatedByEvent.get(eventId) ?? 0,
      flagged: flaggedByEvent.get(eventId) ?? 0,
      distinctSessions: sessionsByEvent.get(eventId) ?? 0,
      firstBallotAt: row?._min.castAt ?? null,
      lastBallotAt: row?._max.castAt ?? null,
    };
  });
}

export type VoterEventParticipation = {
  voterId: string;
  eventId: string;
  eventTitle: string;
  eventSlug: string;
  castAt: Date;
  status: string;
  isSuspicious: boolean;
};

/**
 * Which events each of the given voters took part in.
 *
 * Scoped to the voter ids actually on screen rather than loading every ballot in
 * the system - the admin list is paginated, and an election with 10,000 ballots
 * should not be fetched whole to decorate 50 rows.
 */
export async function voteHistoryForVoters(
  voterIds: readonly string[],
  db: DbClient = prisma,
): Promise<VoterEventParticipation[]> {
  if (voterIds.length === 0) return [];

  const rows = await db.vote.findMany({
    where: { voterId: { in: [...voterIds] } },
    select: {
      voterId: true,
      eventId: true,
      castAt: true,
      status: true,
      isSuspicious: true,
      event: { select: { title: true, slug: true } },
    },
    orderBy: { castAt: 'desc' },
  });

  return rows.map((row) => ({
    voterId: row.voterId,
    eventId: row.eventId,
    eventTitle: row.event.title,
    eventSlug: row.event.slug,
    castAt: row.castAt,
    status: row.status,
    isSuspicious: row.isSuspicious,
  }));
}
