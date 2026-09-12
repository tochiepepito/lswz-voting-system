'use server';

import { revalidatePath } from 'next/cache';
import { getRequestContext } from '@/lib/http';
import { fail, ok, withResult } from '@/lib/result';
import { formDataToObject, toFieldErrors } from '@/schemas/common';
import {
  invalidateVoteSchema,
  moderateSessionSchema,
  moderateVoterSchema,
  restoreVoteSchema,
} from '@/schemas/event';
import { actorFrom, assertAdminCsrf, requireAdmin } from '@/server/auth/guard';
import * as AuditService from '@/server/services/audit.service';
import * as VoterService from '@/server/services/voter.service';
import * as VotingService from '@/server/services/voting.service';
import type { ActionState } from '@/types/actions';

/**
 * Vote and voter moderation.
 *
 * Every action here changes an election result, so every one of them requires
 * the `vote:moderate` or `voter:moderate` capability, a valid CSRF token, and a
 * written reason - and every one writes an audit row naming the administrator
 * who did it. An election where votes can be removed without a trace is not an
 * election.
 */

function revalidateModeration() {
  revalidatePath('/admin/security');
  revalidatePath('/admin/events');
  revalidatePath('/admin');
}

/**
 * Exclude a vote from the tally, keeping the row.
 * Reversible, and the action to reach for first.
 */
export async function invalidateVoteAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const raw = formDataToObject(formData);

  return withResult('invalidateVoteAction', async () => {
    const current = await requireAdmin('vote:moderate');
    await assertAdminCsrf(raw['csrfToken']);

    const parsed = invalidateVoteSchema.safeParse(raw);
    if (!parsed.success) {
      return fail(
        'VALIDATION_FAILED',
        'A reason is required to invalidate a vote.',
        toFieldErrors(parsed.error),
      );
    }

    const context = await getRequestContext();

    if (parsed.data.allowRevote) {
      await VotingService.voidForRevote({
        voteId: parsed.data.voteId,
        reason: parsed.data.reason,
        ...actorFrom(current),
        context,
      });

      revalidateModeration();

      return ok({ message: 'Vote voided. That player can now cast a new ballot.' });
    }

    await VotingService.invalidate({
      voteId: parsed.data.voteId,
      reason: parsed.data.reason,
      ...actorFrom(current),
      context,
    });

    revalidateModeration();

    return ok({ message: 'Vote invalidated and removed from the tally.' });
  });
}

export async function restoreVoteAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const raw = formDataToObject(formData);

  return withResult('restoreVoteAction', async () => {
    const current = await requireAdmin('vote:moderate');
    await assertAdminCsrf(raw['csrfToken']);

    const parsed = restoreVoteSchema.safeParse(raw);
    if (!parsed.success) return fail('VALIDATION_FAILED', 'That vote is not recognised.');

    await VotingService.restore({
      voteId: parsed.data.voteId,
      ...actorFrom(current),
      context: await getRequestContext(),
    });

    revalidateModeration();

    return ok({ message: 'Vote restored to the tally.' });
  });
}

/**
 * Block or unblock an identity.
 *
 * Blocking stops that normalised IGN claiming a ballot in any future event. It
 * does NOT retroactively remove ballots already cast - that is a separate,
 * individually audited decision.
 */
export async function moderateVoterAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const raw = formDataToObject(formData);

  return withResult('moderateVoterAction', async () => {
    const current = await requireAdmin('voter:moderate');
    await assertAdminCsrf(raw['csrfToken']);

    const parsed = moderateVoterSchema.safeParse(raw);
    if (!parsed.success) {
      return fail('VALIDATION_FAILED', 'Check the details.', toFieldErrors(parsed.error));
    }

    const voter = await VoterService.setBlocked(
      parsed.data.voterId,
      parsed.data.blocked,
      parsed.data.reason,
    );

    await AuditService.recordAdminAction({
      action: parsed.data.blocked ? 'VOTER_BLOCKED' : 'VOTER_UNBLOCKED',
      summary: `"${voter.displayName}" was ${parsed.data.blocked ? 'blocked from' : 'unblocked for'} voting.`,
      ...actorFrom(current),
      voterId: voter.id,
      context: await getRequestContext(),
      metadata: { reason: parsed.data.reason ?? null },
    });

    revalidateModeration();
    revalidatePath('/admin/voters');

    return ok({
      message: parsed.data.blocked
        ? `"${voter.displayName}" can no longer vote.`
        : `"${voter.displayName}" can vote again.`,
    });
  });
}

/** Block a browser session outright. The bluntest tool available. */
export async function moderateSessionAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const raw = formDataToObject(formData);

  return withResult('moderateSessionAction', async () => {
    const current = await requireAdmin('voter:moderate');
    await assertAdminCsrf(raw['csrfToken']);

    const parsed = moderateSessionSchema.safeParse(raw);
    if (!parsed.success) {
      return fail('VALIDATION_FAILED', 'Check the details.', toFieldErrors(parsed.error));
    }

    await VoterService.setSessionBlocked(
      parsed.data.sessionId,
      parsed.data.blocked,
      parsed.data.reason,
    );

    await AuditService.recordAdminAction({
      action: 'VOTER_SESSION_BLOCKED',
      summary: `A browser session was ${parsed.data.blocked ? 'blocked' : 'unblocked'}.`,
      ...actorFrom(current),
      context: await getRequestContext(),
      metadata: { sessionId: parsed.data.sessionId, reason: parsed.data.reason ?? null },
    });

    revalidateModeration();

    return ok({ message: parsed.data.blocked ? 'Session blocked.' : 'Session unblocked.' });
  });
}
