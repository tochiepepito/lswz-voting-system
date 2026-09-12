import type { Prisma } from '@prisma/client';
import { prisma, type DbClient } from '@/lib/prisma';
import type { EventStatus, VotingType } from '@/types/domain';

/**
 * Data access for voting events and their options.
 *
 * Repositories own *shape*: every read declares an explicit `select`, so adding
 * a column to the schema can never silently start leaking it through an
 * existing endpoint. They own no business rules - nothing here decides whether
 * voting is open, only what rows exist.
 */

// --------------------------------------------------------------------------
// Select shapes
// --------------------------------------------------------------------------

/** Everything the voting flow and the rules engine need. */
export const eventCoreSelect = {
  id: true,
  slug: true,
  title: true,
  description: true,
  instructions: true,
  votingType: true,
  status: true,
  minSelections: true,
  maxSelections: true,
  startsAt: true,
  endsAt: true,
  resultsVisibility: true,
  maxVotesPerSession: true,
  ipSoftLimit: true,
  requireCaptcha: true,
  publishedAt: true,
  openedAt: true,
  closedAt: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
} satisfies Prisma.VotingEventSelect;

export type EventCore = Prisma.VotingEventGetPayload<{ select: typeof eventCoreSelect }>;

export const optionSelect = {
  id: true,
  eventId: true,
  name: true,
  description: true,
  imageUrl: true,
  displayOrder: true,
  isActive: true,
} satisfies Prisma.VotingOptionSelect;

export type OptionRow = Prisma.VotingOptionGetPayload<{ select: typeof optionSelect }>;

export type EventWithOptions = EventCore & { options: OptionRow[] };

const optionOrder: Prisma.VotingOptionOrderByWithRelationInput[] = [
  { displayOrder: 'asc' },
  { name: 'asc' },
];

// --------------------------------------------------------------------------
// Reads
// --------------------------------------------------------------------------

export async function findEventBySlug(
  slug: string,
  db: DbClient = prisma,
): Promise<EventWithOptions | null> {
  return db.votingEvent.findUnique({
    where: { slug },
    select: { ...eventCoreSelect, options: { select: optionSelect, orderBy: optionOrder } },
  });
}

export async function findEventById(
  id: string,
  db: DbClient = prisma,
): Promise<EventWithOptions | null> {
  return db.votingEvent.findUnique({
    where: { id },
    select: { ...eventCoreSelect, options: { select: optionSelect, orderBy: optionOrder } },
  });
}

/** Event core only, without options. Used where the ballot is irrelevant. */
export async function findEventCoreById(
  id: string,
  db: DbClient = prisma,
): Promise<EventCore | null> {
  return db.votingEvent.findUnique({ where: { id }, select: eventCoreSelect });
}

/**
 * Ids of the options a vote may legally reference.
 *
 * Read inside the vote transaction and scoped to the event, which is what makes
 * it impossible to submit another event's option id - the check is against rows,
 * not against anything the client sent.
 */
export async function findSelectableOptionIds(
  eventId: string,
  db: DbClient = prisma,
): Promise<string[]> {
  const rows = await db.votingOption.findMany({
    where: { eventId, isActive: true },
    select: { id: true },
  });

  return rows.map((row) => row.id);
}

/**
 * Events visible to the public: published, not archived, not draft.
 * DRAFT events are excluded at the query level rather than filtered later, so
 * an unfinished ballot cannot leak through a forgotten code path.
 */
export const PUBLIC_EVENT_STATUSES: EventStatus[] = ['SCHEDULED', 'ACTIVE', 'CLOSED'];

export async function listPublicEvents(db: DbClient = prisma): Promise<EventWithOptions[]> {
  return db.votingEvent.findMany({
    where: {
      status: { in: PUBLIC_EVENT_STATUSES },
      publishedAt: { not: null },
    },
    select: { ...eventCoreSelect, options: { select: optionSelect, orderBy: optionOrder } },
    orderBy: [{ status: 'asc' }, { endsAt: 'asc' }, { createdAt: 'desc' }],
    take: 100,
  });
}

export type AdminEventListItem = EventCore & {
  _count: { votes: number; options: number };
  createdBy: { displayName: string; email: string };
};

export async function listEventsForAdmin(
  filters: { status?: EventStatus; search?: string },
  pagination: { page: number; pageSize: number },
  db: DbClient = prisma,
): Promise<{ items: AdminEventListItem[]; total: number }> {
  const where: Prisma.VotingEventWhereInput = {
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.search
      ? {
          // No `mode: 'insensitive'` here: that option is PostgreSQL-only and
          // is a runtime error on MySQL. It is also unnecessary - the default
          // utf8mb4_unicode_ci collation already compares case-insensitively.
          OR: [{ title: { contains: filters.search } }, { slug: { contains: filters.search } }],
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    db.votingEvent.findMany({
      where,
      select: {
        ...eventCoreSelect,
        _count: { select: { votes: true, options: true } },
        createdBy: { select: { displayName: true, email: true } },
      },
      orderBy: [{ createdAt: 'desc' }],
      skip: (pagination.page - 1) * pagination.pageSize,
      take: pagination.pageSize,
    }),
    db.votingEvent.count({ where }),
  ]);

  return { items, total };
}

/**
 * Minimal event metadata for cross-event statistics.
 *
 * Includes DRAFT events: a draft with ballots on it would be a genuine anomaly,
 * and hiding it would hide exactly the thing worth noticing.
 */
export async function listEventsForStats(db: DbClient = prisma) {
  return db.votingEvent.findMany({
    select: { id: true, title: true, slug: true, status: true, votingType: true, endsAt: true },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
}

export async function countEventsByStatus(
  db: DbClient = prisma,
): Promise<Record<EventStatus, number>> {
  const rows = await db.votingEvent.groupBy({ by: ['status'], _count: { _all: true } });

  const counts: Record<EventStatus, number> = {
    DRAFT: 0,
    SCHEDULED: 0,
    ACTIVE: 0,
    CLOSED: 0,
    ARCHIVED: 0,
  };

  for (const row of rows) {
    counts[row.status as EventStatus] = row._count._all;
  }

  return counts;
}

export async function slugExists(
  slug: string,
  excludeEventId?: string,
  db: DbClient = prisma,
): Promise<boolean> {
  const found = await db.votingEvent.findFirst({
    where: { slug, ...(excludeEventId ? { id: { not: excludeEventId } } : {}) },
    select: { id: true },
  });

  return found !== null;
}

// --------------------------------------------------------------------------
// Writes
// --------------------------------------------------------------------------

export type CreateEventData = {
  slug: string;
  title: string;
  description: string;
  instructions: string | null;
  votingType: VotingType;
  minSelections: number;
  maxSelections: number;
  startsAt: Date | null;
  endsAt: Date | null;
  resultsVisibility: Prisma.VotingEventCreateInput['resultsVisibility'];
  maxVotesPerSession: number;
  ipSoftLimit: number;
  requireCaptcha: boolean;
  createdById: string;
  options: Array<{
    name: string;
    description: string | null;
    imageUrl: string | null;
    displayOrder: number;
    isActive: boolean;
  }>;
};

export async function createEvent(
  data: CreateEventData,
  db: DbClient = prisma,
): Promise<EventWithOptions> {
  const { options, createdById, ...event } = data;

  return db.votingEvent.create({
    data: {
      ...event,
      createdBy: { connect: { id: createdById } },
      options: { create: options },
    },
    select: { ...eventCoreSelect, options: { select: optionSelect, orderBy: optionOrder } },
  });
}

export type UpdateEventData = Omit<CreateEventData, 'options' | 'createdById'>;

export async function updateEvent(
  id: string,
  data: Partial<UpdateEventData>,
  db: DbClient = prisma,
): Promise<EventWithOptions> {
  return db.votingEvent.update({
    where: { id },
    data,
    select: { ...eventCoreSelect, options: { select: optionSelect, orderBy: optionOrder } },
  });
}

/**
 * Move an event to a new status and stamp the matching lifecycle timestamp.
 *
 * The timestamp columns exist so the audit trail can answer "when did this
 * election actually open" without replaying the whole log.
 */
export async function setEventStatus(
  id: string,
  status: EventStatus,
  timestamps: Partial<
    Pick<Prisma.VotingEventUpdateInput, 'publishedAt' | 'openedAt' | 'closedAt' | 'archivedAt'>
  >,
  db: DbClient = prisma,
): Promise<EventCore> {
  return db.votingEvent.update({
    where: { id },
    data: { status, ...timestamps },
    select: eventCoreSelect,
  });
}

/**
 * Reconcile a stale status against the clock.
 *
 * Guarded by `status` in the WHERE clause so two concurrent readers cannot both
 * apply the transition; the loser updates zero rows instead of racing.
 */
export async function reconcileEventStatus(
  id: string,
  fromStatus: EventStatus,
  toStatus: EventStatus,
  now: Date,
  db: DbClient = prisma,
): Promise<number> {
  const result = await db.votingEvent.updateMany({
    where: { id, status: fromStatus },
    data: {
      status: toStatus,
      ...(toStatus === 'ACTIVE' ? { openedAt: now } : {}),
      ...(toStatus === 'CLOSED' ? { closedAt: now } : {}),
    },
  });

  return result.count;
}

/** Events whose stored status no longer matches the clock. */
export async function findEventsNeedingReconciliation(
  now: Date,
  db: DbClient = prisma,
): Promise<Array<Pick<EventCore, 'id' | 'status' | 'startsAt' | 'endsAt'>>> {
  return db.votingEvent.findMany({
    where: {
      OR: [
        { status: 'SCHEDULED', startsAt: { lte: now } },
        { status: 'ACTIVE', endsAt: { lte: now } },
      ],
    },
    select: { id: true, status: true, startsAt: true, endsAt: true },
    take: 500,
  });
}

// --------------------------------------------------------------------------
// Options
// --------------------------------------------------------------------------

export async function listOptions(eventId: string, db: DbClient = prisma): Promise<OptionRow[]> {
  return db.votingOption.findMany({
    where: { eventId },
    select: optionSelect,
    orderBy: optionOrder,
  });
}

export async function createOption(
  data: {
    eventId: string;
    name: string;
    description: string | null;
    imageUrl: string | null;
    displayOrder: number;
    isActive: boolean;
  },
  db: DbClient = prisma,
): Promise<OptionRow> {
  return db.votingOption.create({ data, select: optionSelect });
}

export async function updateOption(
  id: string,
  eventId: string,
  data: Partial<Omit<OptionRow, 'id' | 'eventId'>>,
  db: DbClient = prisma,
): Promise<number> {
  // Scoped by eventId as well as id: an option id from another event updates
  // nothing rather than being edited across an event boundary.
  const result = await db.votingOption.updateMany({ where: { id, eventId }, data });
  return result.count;
}

export async function deleteOption(
  id: string,
  eventId: string,
  db: DbClient = prisma,
): Promise<number> {
  const result = await db.votingOption.deleteMany({ where: { id, eventId } });
  return result.count;
}

export async function countOptionVotes(optionId: string, db: DbClient = prisma): Promise<number> {
  return db.voteSelection.count({ where: { optionId } });
}

export async function setOptionOrder(
  eventId: string,
  orderedOptionIds: readonly string[],
  db: DbClient = prisma,
): Promise<void> {
  await Promise.all(
    orderedOptionIds.map((optionId, index) =>
      db.votingOption.updateMany({ where: { id: optionId, eventId }, data: { displayOrder: index } }),
    ),
  );
}
