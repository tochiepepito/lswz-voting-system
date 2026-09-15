'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getRequestContext } from '@/lib/http';
import { fail, ok, withResult } from '@/lib/result';
import { formDataToObject, toFieldErrors } from '@/schemas/common';
import {
  createEventSchema,
  duplicateEventSchema,
  eventLifecycleSchema,
  optionIdSchema,
  optionInputSchema,
  reorderOptionsSchema,
  shuffleOptionsSchema,
  updateEventSchema,
  updateOptionSchema,
} from '@/schemas/event';
import { actorFrom, assertAdminCsrf, requireAdmin } from '@/server/auth/guard';
import * as EventService from '@/server/services/event.service';
import type { ActionState } from '@/types/actions';

/**
 * Administrative event actions.
 *
 * Every one of these begins with the same two lines:
 *
 *     const current = await requireAdmin('<capability>');
 *     await assertAdminCsrf(raw['csrfToken']);
 *
 * That ordering is deliberate - authorisation before CSRF - so an unauthenticated
 * caller gets a 401 rather than a confusing CSRF error, and no work happens
 * before both checks pass. Server Actions are publicly reachable HTTP endpoints;
 * the fact that the UI only renders a button for the right role protects nothing.
 */

/**
 * Options for a new event arrive as a JSON string in one hidden field rather
 * than as dozens of indexed form fields. The repeated-key encoding cannot
 * express "option 3 was deleted" without renumbering everything client-side.
 */
function parseOptionsJson(value: unknown): unknown[] {
  if (typeof value !== 'string' || value.trim() === '') return [];

  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function revalidateEvent(eventId: string, slug?: string) {
  revalidatePath('/admin');
  revalidatePath('/admin/events');
  revalidatePath(`/admin/events/${eventId}`);
  revalidatePath('/events');
  if (slug) revalidatePath(`/events/${slug}`);
}

// --------------------------------------------------------------------------
// Create / update
// --------------------------------------------------------------------------

export async function createEventAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const raw = formDataToObject(formData);

  const outcome = await withResult('createEventAction', async () => {
    const current = await requireAdmin('event:write');
    await assertAdminCsrf(raw['csrfToken']);

    const parsed = createEventSchema.safeParse({
      ...raw,
      options: parseOptionsJson(raw['optionsJson']),
    });

    if (!parsed.success) {
      return fail(
        'VALIDATION_FAILED',
        'Please correct the highlighted fields.',
        toFieldErrors(parsed.error),
      );
    }

    const event = await EventService.createEvent(parsed.data, {
      ...actorFrom(current),
      context: await getRequestContext(),
    });

    return ok({ eventId: event.id, message: 'Event created.' });
  });

  if (outcome.ok) {
    revalidateEvent(outcome.data.eventId);
    redirect(`/admin/events/${outcome.data.eventId}`);
  }

  return outcome;
}

export async function updateEventAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const raw = formDataToObject(formData);

  return withResult('updateEventAction', async () => {
    const current = await requireAdmin('event:write');
    await assertAdminCsrf(raw['csrfToken']);

    const parsed = updateEventSchema.safeParse(raw);
    if (!parsed.success) {
      return fail(
        'VALIDATION_FAILED',
        'Please correct the highlighted fields.',
        toFieldErrors(parsed.error),
      );
    }

    const event = await EventService.updateEvent(parsed.data, {
      ...actorFrom(current),
      context: await getRequestContext(),
    });

    revalidateEvent(event.id, event.slug);

    return ok({ message: 'Changes saved.' });
  });
}

export async function duplicateEventAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const raw = formDataToObject(formData);

  const outcome = await withResult('duplicateEventAction', async () => {
    const current = await requireAdmin('event:write');
    await assertAdminCsrf(raw['csrfToken']);

    const parsed = duplicateEventSchema.safeParse(raw);
    if (!parsed.success) {
      return fail('VALIDATION_FAILED', 'Enter a title for the copy.', toFieldErrors(parsed.error));
    }

    const created = await EventService.duplicateEvent(parsed.data.eventId, parsed.data.title, {
      ...actorFrom(current),
      context: await getRequestContext(),
    });

    return ok({ eventId: created.id, message: 'Event duplicated.' });
  });

  if (outcome.ok) {
    revalidateEvent(outcome.data.eventId);
    redirect(`/admin/events/${outcome.data.eventId}`);
  }

  return outcome;
}

// --------------------------------------------------------------------------
// Lifecycle
// --------------------------------------------------------------------------

export async function eventLifecycleAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const raw = formDataToObject(formData);

  return withResult('eventLifecycleAction', async () => {
    const current = await requireAdmin('event:lifecycle');
    await assertAdminCsrf(raw['csrfToken']);

    const parsed = eventLifecycleSchema.safeParse(raw);
    if (!parsed.success) return fail('VALIDATION_FAILED', 'That action is not recognised.');

    const result = await EventService.applyLifecycleAction(
      parsed.data.eventId,
      parsed.data.action,
      { ...actorFrom(current), context: await getRequestContext() },
    );

    revalidateEvent(parsed.data.eventId);

    const messages: Record<typeof parsed.data.action, string> = {
      publish: 'Event published.',
      unpublish: 'Event returned to draft.',
      open: 'Voting is now open.',
      close: 'Voting is now closed.',
      archive: 'Event archived.',
    };

    return ok({ message: `${messages[parsed.data.action]} Status: ${result.status}.` });
  });
}

// --------------------------------------------------------------------------
// Options
// --------------------------------------------------------------------------

export async function addOptionAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const raw = formDataToObject(formData);

  return withResult('addOptionAction', async () => {
    const current = await requireAdmin('option:write');
    await assertAdminCsrf(raw['csrfToken']);

    const eventId = typeof raw['eventId'] === 'string' ? raw['eventId'] : '';
    const parsed = optionInputSchema.omit({ id: true }).safeParse(raw);

    if (!parsed.success) {
      return fail('VALIDATION_FAILED', 'Check the option details.', toFieldErrors(parsed.error));
    }

    const option = await EventService.addOption(eventId, parsed.data, {
      ...actorFrom(current),
      context: await getRequestContext(),
    });

    revalidateEvent(eventId);

    return ok({ message: `Option "${option.name}" added.` });
  });
}

export async function updateOptionAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const raw = formDataToObject(formData);

  return withResult('updateOptionAction', async () => {
    const current = await requireAdmin('option:write');
    await assertAdminCsrf(raw['csrfToken']);

    const parsed = updateOptionSchema.safeParse(raw);
    if (!parsed.success) {
      return fail('VALIDATION_FAILED', 'Check the option details.', toFieldErrors(parsed.error));
    }

    const { id, eventId, ...input } = parsed.data;

    await EventService.editOption(eventId, id, input, {
      ...actorFrom(current),
      context: await getRequestContext(),
    });

    revalidateEvent(eventId);

    return ok({ message: 'Option updated.' });
  });
}

export async function deleteOptionAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const raw = formDataToObject(formData);

  return withResult('deleteOptionAction', async () => {
    const current = await requireAdmin('option:write');
    await assertAdminCsrf(raw['csrfToken']);

    const parsed = optionIdSchema.safeParse(raw);
    if (!parsed.success) return fail('VALIDATION_FAILED', 'That option is not recognised.');

    await EventService.removeOption(parsed.data.eventId, parsed.data.optionId, {
      ...actorFrom(current),
      context: await getRequestContext(),
    });

    revalidateEvent(parsed.data.eventId);

    return ok({ message: 'Option deleted.' });
  });
}

export async function reorderOptionsAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const raw = formDataToObject(formData);

  return withResult('reorderOptionsAction', async () => {
    const current = await requireAdmin('option:write');
    await assertAdminCsrf(raw['csrfToken']);

    const parsed = reorderOptionsSchema.safeParse({
      eventId: raw['eventId'],
      orderedOptionIds: parseOptionsJson(raw['orderedOptionIdsJson']),
    });

    if (!parsed.success) return fail('VALIDATION_FAILED', 'That ordering is not valid.');

    await EventService.reorderOptions(parsed.data.eventId, parsed.data.orderedOptionIds, {
      ...actorFrom(current),
      context: await getRequestContext(),
    });
    revalidateEvent(parsed.data.eventId);

    return ok({ message: 'Order saved.' });
  });
}

export async function shuffleOptionsAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const raw = formDataToObject(formData);

  return withResult('shuffleOptionsAction', async () => {
    const current = await requireAdmin('option:write');
    await assertAdminCsrf(raw['csrfToken']);

    const parsed = shuffleOptionsSchema.safeParse({ eventId: raw['eventId'] });
    if (!parsed.success) return fail('VALIDATION_FAILED', 'That event could not be found.');

    await EventService.shuffleOptionOrder(parsed.data.eventId, {
      ...actorFrom(current),
      context: await getRequestContext(),
    });
    revalidateEvent(parsed.data.eventId);

    return ok({ message: 'Options shuffled.' });
  });
}
