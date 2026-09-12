import { appError } from '@/lib/errors';
import type { RequestContext } from '@/lib/http';
import { isUniqueViolationOn, prisma } from '@/lib/prisma';
import { fallbackSlug, slugify, uniqueSlug } from '@/lib/slug';
import { reconciledStatus, selectionBounds } from '@/lib/voting-rules';
import type { EventStatus } from '@/types/domain';
import {
  countEventsByStatus,
  createEvent as createEventRow,
  createOption,
  deleteOption,
  findEventById,
  findEventBySlug,
  findEventsNeedingReconciliation,
  listEventsForAdmin,
  listOptions,
  listPublicEvents as listPublicEventRows,
  countOptionVotes,
  reconcileEventStatus,
  setEventStatus,
  setOptionOrder,
  slugExists,
  updateEvent as updateEventRow,
  updateOption,
  type EventWithOptions,
  type OptionRow,
} from '../repositories/event.repository';
import { countValidVotes } from '../repositories/vote.repository';
import type {
  CreateEventInput,
  EventLifecycleAction,
  OptionInput,
  UpdateEventInput,
} from '@/schemas/event';
import * as AuditService from './audit.service';

/**
 * EventService
 *
 * Owns the event lifecycle and the rules about what may change and when.
 *
 * The central design decision here is LAZY STATUS RECONCILIATION. An event's
 * stored status and its schedule can disagree - a SCHEDULED event whose start
 * time has passed, an ACTIVE event past its end time. Rather than depending on
 * a cron job (which, if it fails, silently extends an election), every read
 * reconciles the row it just loaded, and `lib/voting-rules` treats the clock as
 * authoritative regardless of what the column says.
 *
 * The consequence is worth stating plainly: a deployment with no scheduler at
 * all is still correct. The scheduler, where present, only keeps the stored
 * status tidy for listings.
 */

type ActorContext = {
  adminId: string;
  adminLabel: string;
  context: RequestContext;
};

// --------------------------------------------------------------------------
// Reads
// --------------------------------------------------------------------------

/**
 * Bring a stale status into line with the clock, then return the corrected row.
 * The update is guarded on the previous status, so concurrent readers cannot
 * both apply it.
 */
async function reconcile<T extends { id: string; status: EventStatus; startsAt: Date | null; endsAt: Date | null }>(
  event: T,
  now = new Date(),
): Promise<T> {
  const target = reconciledStatus(event, now);
  if (!target) return event;

  const updated = await reconcileEventStatus(event.id, event.status, target, now).catch(() => 0);

  if (updated > 0) {
    await AuditService.recordSystemAction({
      action: target === 'ACTIVE' ? 'EVENT_OPENED' : 'EVENT_CLOSED',
      summary:
        target === 'ACTIVE'
          ? 'Voting opened automatically at its scheduled start time.'
          : 'Voting closed automatically at its scheduled end time.',
      eventId: event.id,
      metadata: { from: event.status, to: target },
    });
  }

  return { ...event, status: target };
}

/** Public event by slug. Returns null for draft or unpublished events. */
export async function getPublicEventBySlug(slug: string): Promise<EventWithOptions | null> {
  const event = await findEventBySlug(slug);
  if (!event) return null;
  if (event.status === 'DRAFT' || event.publishedAt === null) return null;

  return reconcile(event);
}

/** Every event a voter may see, newest-closing first. */
export async function listPublicEvents(): Promise<EventWithOptions[]> {
  const events = await listPublicEventRows();
  return Promise.all(events.map((event) => reconcile(event)));
}

export async function getEventForAdmin(id: string): Promise<EventWithOptions | null> {
  const event = await findEventById(id);
  if (!event) return null;

  return reconcile(event);
}

export async function listForAdmin(
  filters: { status?: EventStatus; search?: string },
  pagination: { page: number; pageSize: number },
) {
  return listEventsForAdmin(filters, pagination);
}

export async function statusCounts() {
  return countEventsByStatus();
}

/**
 * Batch reconciliation, for an optional scheduled job.
 * Everything stays correct without it; this only tidies stored statuses.
 */
export async function reconcileAll(now = new Date()): Promise<number> {
  const stale = await findEventsNeedingReconciliation(now);
  let changed = 0;

  for (const event of stale) {
    const target = reconciledStatus(event, now);
    if (!target) continue;

    const updated = await reconcileEventStatus(event.id, event.status, target, now);
    if (updated > 0) changed += 1;
  }

  return changed;
}

// --------------------------------------------------------------------------
// Creation
// --------------------------------------------------------------------------

/** Shape of a brand-new option, before it has an id. */
type NewOption = {
  name: string;
  description: string | null;
  imageUrl: string | null;
  displayOrder: number;
  isActive: boolean;
};

/** Yes/No events get their two options generated rather than typed. */
function optionsFor(input: CreateEventInput): NewOption[] {
  if (input.votingType !== 'YES_NO') return input.options as NewOption[];

  return [
    { name: 'Yes', description: null, imageUrl: null, displayOrder: 0, isActive: true },
    { name: 'No', description: null, imageUrl: null, displayOrder: 1, isActive: true },
  ];
}

export async function createEvent(
  input: CreateEventInput,
  actor: ActorContext,
): Promise<EventWithOptions> {
  const options = optionsFor(input);
  const bounds = selectionBounds(input);

  const requestedSlug = input.slug ?? slugify(input.title);
  const slug = await uniqueSlug(requestedSlug || fallbackSlug(input.title), (candidate) =>
    slugExists(candidate),
  );

  // An explicit slug that collided is an error the admin should see, rather
  // than being silently given `-2`.
  if (input.slug && slug !== input.slug) throw appError('SLUG_IN_USE');

  try {
    const event = await createEventRow({
      slug,
      title: input.title,
      description: input.description,
      instructions: input.instructions,
      votingType: input.votingType,
      minSelections: bounds.min,
      maxSelections: bounds.max,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      resultsVisibility: input.resultsVisibility,
      maxVotesPerSession: input.maxVotesPerSession,
      ipSoftLimit: input.ipSoftLimit,
      requireCaptcha: input.requireCaptcha,
      createdById: actor.adminId,
      options: options.map((option, index) => ({
        name: option.name,
        description: option.description,
        imageUrl: option.imageUrl,
        displayOrder: option.displayOrder || index,
        isActive: option.isActive,
      })),
    });

    await AuditService.recordAdminAction({
      action: 'EVENT_CREATED',
      summary: `Event "${event.title}" was created.`,
      adminId: actor.adminId,
      adminLabel: actor.adminLabel,
      eventId: event.id,
      context: actor.context,
      metadata: { slug: event.slug, votingType: event.votingType, options: options.length },
    });

    return event;
  } catch (error) {
    if (isUniqueViolationOn(error, 'slug')) throw appError('SLUG_IN_USE');
    throw error;
  }
}

export async function duplicateEvent(
  eventId: string,
  title: string,
  actor: ActorContext,
): Promise<EventWithOptions> {
  const source = await findEventById(eventId);
  if (!source) throw appError('EVENT_NOT_FOUND');

  const slug = await uniqueSlug(slugify(title) || fallbackSlug(title), (candidate) =>
    slugExists(candidate),
  );

  // A duplicate always starts as a DRAFT with no schedule: copying an active
  // election's dates would immediately open a second live ballot.
  const created = await createEventRow({
    slug,
    title,
    description: source.description,
    instructions: source.instructions,
    votingType: source.votingType,
    minSelections: source.minSelections,
    maxSelections: source.maxSelections,
    startsAt: null,
    endsAt: null,
    resultsVisibility: source.resultsVisibility,
    maxVotesPerSession: source.maxVotesPerSession,
    ipSoftLimit: source.ipSoftLimit,
    requireCaptcha: source.requireCaptcha,
    createdById: actor.adminId,
    options: source.options.map((option) => ({
      name: option.name,
      description: option.description,
      imageUrl: option.imageUrl,
      displayOrder: option.displayOrder,
      isActive: option.isActive,
    })),
  });

  await AuditService.recordAdminAction({
    action: 'EVENT_DUPLICATED',
    summary: `Event "${source.title}" was duplicated as "${title}".`,
    adminId: actor.adminId,
    adminLabel: actor.adminLabel,
    eventId: created.id,
    context: actor.context,
    metadata: { sourceEventId: source.id, sourceSlug: source.slug },
  });

  return created;
}

// --------------------------------------------------------------------------
// Updates
// --------------------------------------------------------------------------

/**
 * Fields that become immutable once a single ballot has been cast.
 *
 * Changing any of these after voting starts would retroactively alter the rules
 * under which existing ballots were cast - turning a single-choice election into
 * a multi-pick one, or moving the opening time behind the first vote. Titles and
 * descriptions stay editable so typos can still be fixed.
 */
const LOCKED_AFTER_FIRST_VOTE = [
  'votingType',
  'minSelections',
  'maxSelections',
  'startsAt',
] as const;

export async function updateEvent(
  input: UpdateEventInput,
  actor: ActorContext,
): Promise<EventWithOptions> {
  const existing = await findEventById(input.id);
  if (!existing) throw appError('EVENT_NOT_FOUND');

  if (existing.status === 'ARCHIVED') {
    throw appError('EVENT_NOT_EDITABLE', { message: 'Archived events cannot be edited.' });
  }

  const bounds = selectionBounds(input);
  const voteCount = await countValidVotes(existing.id);

  if (voteCount > 0) {
    const changed: string[] = [];

    if (input.votingType !== existing.votingType) changed.push('votingType');
    if (bounds.min !== existing.minSelections) changed.push('minSelections');
    if (bounds.max !== existing.maxSelections) changed.push('maxSelections');
    if (input.startsAt?.getTime() !== existing.startsAt?.getTime()) changed.push('startsAt');

    const locked = changed.filter((field) =>
      (LOCKED_AFTER_FIRST_VOTE as readonly string[]).includes(field),
    );

    if (locked.length > 0) {
      throw appError('EVENT_NOT_EDITABLE', {
        message: `Voting has already started, so the ballot rules can no longer change (${locked.join(', ')}).`,
      });
    }
  }

  const slug = input.slug ?? existing.slug;
  if (slug !== existing.slug && (await slugExists(slug, existing.id))) {
    throw appError('SLUG_IN_USE');
  }

  try {
    const updated = await updateEventRow(existing.id, {
      slug,
      title: input.title,
      description: input.description,
      instructions: input.instructions,
      votingType: input.votingType,
      minSelections: bounds.min,
      maxSelections: bounds.max,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      resultsVisibility: input.resultsVisibility,
      maxVotesPerSession: input.maxVotesPerSession,
      ipSoftLimit: input.ipSoftLimit,
      requireCaptcha: input.requireCaptcha,
    });

    await AuditService.recordAdminAction({
      action: 'EVENT_UPDATED',
      summary: `Event "${updated.title}" was updated.`,
      adminId: actor.adminId,
      adminLabel: actor.adminLabel,
      eventId: updated.id,
      context: actor.context,
      metadata: { voteCountAtEdit: voteCount },
    });

    return updated;
  } catch (error) {
    if (isUniqueViolationOn(error, 'slug')) throw appError('SLUG_IN_USE');
    throw error;
  }
}

// --------------------------------------------------------------------------
// Lifecycle
// --------------------------------------------------------------------------

/** Legal transitions. Anything not listed here is refused. */
const TRANSITIONS: Record<EventLifecycleAction, EventStatus[]> = {
  publish: ['DRAFT'],
  unpublish: ['SCHEDULED'],
  open: ['DRAFT', 'SCHEDULED'],
  close: ['SCHEDULED', 'ACTIVE'],
  archive: ['CLOSED'],
};

export async function applyLifecycleAction(
  eventId: string,
  action: EventLifecycleAction,
  actor: ActorContext,
): Promise<{ status: EventStatus }> {
  const event = await findEventById(eventId);
  if (!event) throw appError('EVENT_NOT_FOUND');

  if (!TRANSITIONS[action].includes(event.status)) {
    throw appError('INVALID_STATUS_TRANSITION');
  }

  const now = new Date();

  if (action === 'publish') {
    // Publishing means "make visible". Whether that also opens voting depends
    // entirely on the schedule, so the operator cannot accidentally open an
    // election early by pressing Publish.
    const opensLater = event.startsAt !== null && event.startsAt > now;
    const status: EventStatus = opensLater ? 'SCHEDULED' : 'ACTIVE';

    if (!opensLater && event.options.filter((option) => option.isActive).length < 2) {
      throw appError('CONFLICT', {
        message: 'Add at least two active options before opening voting.',
      });
    }

    await setEventStatus(event.id, status, {
      publishedAt: now,
      ...(status === 'ACTIVE' ? { openedAt: now } : {}),
    });

    await AuditService.recordAdminAction({
      action: 'EVENT_PUBLISHED',
      summary: `Event "${event.title}" was published${opensLater ? ' and scheduled' : ' and opened'}.`,
      adminId: actor.adminId,
      adminLabel: actor.adminLabel,
      eventId: event.id,
      context: actor.context,
      metadata: { status },
    });

    return { status };
  }

  if (action === 'unpublish') {
    const votes = await countValidVotes(event.id);
    if (votes > 0) {
      throw appError('CONFLICT', {
        message: 'This event already has votes and can no longer be unpublished. Close it instead.',
      });
    }

    await setEventStatus(event.id, 'DRAFT', { publishedAt: null });

    await AuditService.recordAdminAction({
      action: 'EVENT_UNPUBLISHED',
      summary: `Event "${event.title}" was returned to draft.`,
      adminId: actor.adminId,
      adminLabel: actor.adminLabel,
      eventId: event.id,
      context: actor.context,
    });

    return { status: 'DRAFT' };
  }

  if (action === 'open') {
    if (event.options.filter((option) => option.isActive).length < 2) {
      throw appError('CONFLICT', {
        message: 'Add at least two active options before opening voting.',
      });
    }

    await setEventStatus(event.id, 'ACTIVE', { publishedAt: event.publishedAt ?? now, openedAt: now });

    // An event opened by hand with no start time recorded gets one now, so the
    // voting window is always a closed interval in the audit record.
    if (!event.startsAt) await updateEventRow(event.id, { startsAt: now });

    await AuditService.recordAdminAction({
      action: 'EVENT_OPENED',
      summary: `Voting opened for "${event.title}".`,
      adminId: actor.adminId,
      adminLabel: actor.adminLabel,
      eventId: event.id,
      context: actor.context,
    });

    return { status: 'ACTIVE' };
  }

  if (action === 'close') {
    await setEventStatus(event.id, 'CLOSED', { closedAt: now });
    if (!event.endsAt || event.endsAt > now) await updateEventRow(event.id, { endsAt: now });

    await AuditService.recordAdminAction({
      action: 'EVENT_CLOSED',
      summary: `Voting closed for "${event.title}".`,
      adminId: actor.adminId,
      adminLabel: actor.adminLabel,
      eventId: event.id,
      context: actor.context,
    });

    return { status: 'CLOSED' };
  }

  await setEventStatus(event.id, 'ARCHIVED', { archivedAt: now });

  await AuditService.recordAdminAction({
    action: 'EVENT_ARCHIVED',
    summary: `Event "${event.title}" was archived.`,
    adminId: actor.adminId,
    adminLabel: actor.adminLabel,
    eventId: event.id,
    context: actor.context,
  });

  return { status: 'ARCHIVED' };
}

// --------------------------------------------------------------------------
// Options
// --------------------------------------------------------------------------

export async function getOptions(eventId: string): Promise<OptionRow[]> {
  return listOptions(eventId);
}

export async function addOption(
  eventId: string,
  input: Omit<OptionInput, 'id'>,
  actor: ActorContext,
): Promise<OptionRow> {
  const event = await findEventById(eventId);
  if (!event) throw appError('EVENT_NOT_FOUND');
  if (event.status === 'CLOSED' || event.status === 'ARCHIVED') {
    throw appError('EVENT_NOT_EDITABLE', {
      message: 'Options cannot be added to an event that has finished.',
    });
  }

  try {
    const option = await createOption({
      eventId,
      name: input.name,
      description: input.description,
      imageUrl: input.imageUrl,
      displayOrder: input.displayOrder || event.options.length,
      isActive: input.isActive,
    });

    await AuditService.recordAdminAction({
      action: 'OPTION_CREATED',
      summary: `Option "${option.name}" was added to "${event.title}".`,
      adminId: actor.adminId,
      adminLabel: actor.adminLabel,
      eventId,
      context: actor.context,
    });

    return option;
  } catch (error) {
    if (isUniqueViolationOn(error, 'name')) {
      throw appError('CONFLICT', { message: 'An option with that name already exists.' });
    }
    throw error;
  }
}

export async function editOption(
  eventId: string,
  optionId: string,
  input: Omit<OptionInput, 'id'>,
  actor: ActorContext,
): Promise<void> {
  const updated = await updateOption(optionId, eventId, {
    name: input.name,
    description: input.description,
    imageUrl: input.imageUrl,
    displayOrder: input.displayOrder,
    isActive: input.isActive,
  });

  if (updated === 0) throw appError('NOT_FOUND');

  await AuditService.recordAdminAction({
    action: input.isActive ? 'OPTION_UPDATED' : 'OPTION_DEACTIVATED',
    summary: `Option "${input.name}" was ${input.isActive ? 'updated' : 'deactivated'}.`,
    adminId: actor.adminId,
    adminLabel: actor.adminLabel,
    eventId,
    context: actor.context,
  });
}

/**
 * Delete an option.
 *
 * Refused once the option has received a vote: removing it would silently
 * change historical tallies and orphan the ballots that chose it. The admin is
 * told to deactivate instead, which hides it from new voters while keeping
 * every existing result reconstructable.
 */
export async function removeOption(
  eventId: string,
  optionId: string,
  actor: ActorContext,
): Promise<void> {
  const votes = await countOptionVotes(optionId);

  if (votes > 0) {
    throw appError('CONFLICT', {
      message: `This option already has ${votes} vote${votes === 1 ? '' : 's'} and cannot be deleted. Deactivate it instead.`,
    });
  }

  const deleted = await deleteOption(optionId, eventId);
  if (deleted === 0) throw appError('NOT_FOUND');

  await AuditService.recordAdminAction({
    action: 'OPTION_DELETED',
    summary: 'An option was deleted before any votes were cast for it.',
    adminId: actor.adminId,
    adminLabel: actor.adminLabel,
    eventId,
    context: actor.context,
    metadata: { optionId },
  });
}

export async function reorderOptions(
  eventId: string,
  orderedOptionIds: readonly string[],
): Promise<void> {
  await setOptionOrder(eventId, orderedOptionIds);
}

/** Dashboard tile numbers. */
export async function overviewCounts() {
  const [byStatus, totalVotes] = await Promise.all([
    countEventsByStatus(),
    prisma.vote.count({ where: { status: 'VALID' } }),
  ]);

  return {
    active: byStatus.ACTIVE,
    scheduled: byStatus.SCHEDULED,
    draft: byStatus.DRAFT,
    closed: byStatus.CLOSED,
    archived: byStatus.ARCHIVED,
    totalVotes,
  };
}
