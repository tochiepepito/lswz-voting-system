'use server';

import { redirect } from 'next/navigation';
import { appError } from '@/lib/errors';
import { getRequestContext } from '@/lib/http';
import { fail, ok, withResult } from '@/lib/result';
import type { FailureState } from '@/types/actions';
import { formDataToObject, toFieldErrors } from '@/schemas/common';
import { claimIdentityFormSchema, submitVoteFormSchema } from '@/schemas/voter';
import { assertVoterCsrf } from '@/server/auth/guard';
import * as EventService from '@/server/services/event.service';
import * as VoterService from '@/server/services/voter.service';
import * as VotingService from '@/server/services/voting.service';

/**
 * Voter-facing Server Actions.
 *
 * These are what the voting UI actually submits to; the Route Handlers in
 * `app/api` expose the same operations for non-browser clients. Both are thin
 * shells over the same services, so there is exactly one implementation of the
 * voting rules and no chance of the two paths disagreeing.
 *
 * A note on `redirect()`: it signals navigation by throwing, so it must be
 * called *after* the error-trapping wrapper has returned. Calling it inside
 * `withResult` would convert a successful navigation into a generic failure.
 */


/**
 * Step 2: claim an IGN for an event, then continue to the ballot.
 *
 * A voter who has already voted is sent to the confirmation page rather than
 * the ballot - the server knows the answer, so there is no point rendering a
 * ballot that cannot be submitted.
 */
export async function claimIdentityAction(
  _previous: FailureState,
  formData: FormData,
): Promise<FailureState> {
  const raw = formDataToObject(formData);

  const outcome = await withResult('claimIdentityAction', async () => {
    await assertVoterCsrf(raw['csrfToken']);

    const parsed = claimIdentityFormSchema.safeParse(raw);
    if (!parsed.success) {
      return fail('VALIDATION_FAILED', 'Please check your in-game name.', toFieldErrors(parsed.error));
    }

    const event = await EventService.getPublicEventBySlug(parsed.data.eventSlug);
    if (!event) throw appError('EVENT_NOT_FOUND');

    const result = await VoterService.claimIdentity({
      event,
      rawIgn: parsed.data.ign,
      context: await getRequestContext(),
      captchaToken: parsed.data.captchaToken,
    });

    return ok({ alreadyVoted: result.alreadyVoted, slug: parsed.data.eventSlug });
  });

  if (outcome.ok) {
    redirect(
      outcome.data.alreadyVoted
        ? `/events/${outcome.data.slug}/confirmation`
        : `/events/${outcome.data.slug}/vote`,
    );
  }

  return outcome;
}

/**
 * Step 3: submit the ballot.
 *
 * `optionIds` arrives as repeated form fields (radio or checkbox), which
 * `formDataToObject` collapses into an array. Everything about whether those
 * ids are acceptable is decided inside `VotingService.submitVote`.
 */
export async function submitVoteAction(
  _previous: FailureState,
  formData: FormData,
): Promise<FailureState> {
  const raw = formDataToObject(formData);

  const outcome = await withResult('submitVoteAction', async () => {
    await assertVoterCsrf(raw['csrfToken']);

    const parsed = submitVoteFormSchema.safeParse(raw);
    if (!parsed.success) {
      return fail('VALIDATION_FAILED', 'Please review your selection.', toFieldErrors(parsed.error));
    }

    const event = await EventService.getPublicEventBySlug(parsed.data.eventSlug);
    if (!event) throw appError('EVENT_NOT_FOUND');

    await VotingService.submitVote({
      event,
      optionIds: parsed.data.optionIds,
      context: await getRequestContext(),
      captchaToken: parsed.data.captchaToken,
    });

    return ok({ slug: parsed.data.eventSlug });
  });

  if (outcome.ok) {
    redirect(`/events/${outcome.data.slug}/confirmation`);
  }

  return outcome;
}

/**
 * Leave the ballot: drop the identity claim for this event.
 *
 * Deliberately does NOT delete a cast vote - that is an administrator action.
 * It exists so a shared device can be handed to the next player.
 */
export async function changeIdentityAction(formData: FormData): Promise<void> {
  const raw = formDataToObject(formData);
  const slug = typeof raw['eventSlug'] === 'string' ? raw['eventSlug'] : '';

  await withResult('changeIdentityAction', async () => {
    await assertVoterCsrf(raw['csrfToken']);
    await VoterService.forgetSession();

    return ok({});
  });

  // Either way the voter lands back on the IGN step: if clearing the session
  // failed, the page simply re-renders with the existing claim intact.
  redirect(slug ? `/events/${slug}` : '/events');
}
