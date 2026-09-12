'use client';

import { useActionState, useState } from 'react';
import {
  invalidateVoteAction,
  moderateVoterAction,
  restoreVoteAction,
} from '@/server/actions/moderation.actions';
import { Alert, Badge, Card, CsrfField, Field, cx, inputClass } from '../ui';
import { SubmitButton } from '../submit-button';

/**
 * Per-ballot moderation.
 *
 * Two distinct operations, deliberately not merged into one button:
 *
 *   Invalidate      - the ballot stays in the database and drops out of every
 *                     tally. Reversible. The default.
 *   Void for revote - the ballot is deleted so its owner can vote again, after
 *                     its full content is copied into the audit log. Needed
 *                     because `votes(eventId, voterId)` is a plain unique
 *                     constraint: an invalidated row still occupies the slot.
 *
 * Both demand a written reason. An election where ballots can be removed
 * without a recorded justification is not an election.
 */

export type ModeratableBallot = {
  id: string;
  receiptCode: string;
  voterName: string;
  status: 'VALID' | 'INVALIDATED';
  isSuspicious: boolean;
  suspicionReasons: string[];
  invalidationReason: string | null;
  selections: string[];
};

const REASON_LABELS: Record<string, string> = {
  IP_SOFT_LIMIT: 'Many votes from one network',
  CONFUSABLE_NAME: 'Name resembles another voter',
  SHARED_BROWSER: 'Second ballot from this browser',
  IMMEDIATE_SUBMISSION: 'Submitted unusually fast',
};

export function BallotModeration({
  ballot,
  csrfToken,
}: {
  ballot: ModeratableBallot;
  csrfToken: string | null;
}) {
  const [invalidateState, invalidateFormAction] = useActionState(invalidateVoteAction, null);
  const [restoreState, restoreFormAction] = useActionState(restoreVoteAction, null);
  const [open, setOpen] = useState(false);

  const isInvalidated = ballot.status === 'INVALIDATED';
  const feedback = invalidateState ?? restoreState;

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{ballot.voterName}</span>
            {isInvalidated ? <Badge tone="danger">Invalidated</Badge> : null}
            {ballot.isSuspicious ? <Badge tone="warn">Flagged</Badge> : null}
          </div>

          <p className="mt-1 text-sm text-muted">
            Chose: <span className="text-ink">{ballot.selections.join(', ') || '--'}</span>
          </p>

          <p className="mt-0.5 font-mono text-xs text-faint">{ballot.receiptCode}</p>

          {ballot.suspicionReasons.length > 0 ? (
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {ballot.suspicionReasons.map((reason) => (
                <li key={reason}>
                  <Badge tone="warn">{REASON_LABELS[reason] ?? reason}</Badge>
                </li>
              ))}
            </ul>
          ) : null}

          {ballot.invalidationReason ? (
            <p className="mt-2 text-xs text-danger">Reason: {ballot.invalidationReason}</p>
          ) : null}
        </div>

        <div className="shrink-0">
          {isInvalidated ? (
            <form action={restoreFormAction}>
              <CsrfField token={csrfToken} />
              <input type="hidden" name="voteId" value={ballot.id} />
              <SubmitButton variant="secondary" pendingLabel="Restoring...">
                Restore to tally
              </SubmitButton>
            </form>
          ) : (
            <button
              type="button"
              onClick={() => setOpen((previous) => !previous)}
              aria-expanded={open}
              className="rounded-lg border border-danger/30 px-3 py-2 text-sm font-medium text-danger hover:bg-danger/10"
            >
              {open ? 'Cancel' : 'Moderate'}
            </button>
          )}
        </div>
      </div>

      {feedback ? (
        <div className="mt-3">
          <Alert tone={feedback.ok ? 'ok' : 'danger'}>
            {feedback.ok ? feedback.data.message : feedback.message}
          </Alert>
        </div>
      ) : null}

      {open && !isInvalidated ? (
        <form action={invalidateFormAction} className="mt-4 space-y-3 border-t border-line pt-4">
          <CsrfField token={csrfToken} />
          <input type="hidden" name="voteId" value={ballot.id} />

          <Field
            label="Reason"
            htmlFor={`reason-${ballot.id}`}
            required
            hint="Recorded in the audit log against your account."
          >
            <input
              id={`reason-${ballot.id}`}
              name="reason"
              required
              minLength={3}
              maxLength={500}
              className={inputClass}
              placeholder="e.g. Duplicate account confirmed by guild leadership"
            />
          </Field>

          <label className="flex items-start gap-2.5 text-sm">
            <input
              type="checkbox"
              name="allowRevote"
              className="mt-0.5 h-5 w-5 rounded accent-[rgb(var(--c-accent))]"
            />
            <span>
              <span className="font-medium">Also allow this player to vote again</span>
              <span className="block text-xs text-muted">
                Deletes the ballot after copying it into the audit log, freeing their slot. Leave
                unticked to simply exclude it from the tally.
              </span>
            </span>
          </label>

          <SubmitButton variant="danger" pendingLabel="Applying...">
            Invalidate this ballot
          </SubmitButton>
        </form>
      ) : null}
    </Card>
  );
}

/** Block or unblock an in-game name across all events. */
export function VoterModeration({
  voterId,
  voterName,
  isBlocked,
  csrfToken,
}: {
  voterId: string;
  voterName: string;
  isBlocked: boolean;
  csrfToken: string | null;
}) {
  const [state, formAction] = useActionState(moderateVoterAction, null);
  const [open, setOpen] = useState(false);

  return (
    <div className="space-y-2">
      {state ? (
        <Alert tone={state.ok ? 'ok' : 'danger'}>
          {state.ok ? state.data.message : state.message}
        </Alert>
      ) : null}

      {isBlocked ? (
        <form action={formAction}>
          <CsrfField token={csrfToken} />
          <input type="hidden" name="voterId" value={voterId} />
          <SubmitButton variant="secondary" pendingLabel="Unblocking...">
            Unblock {voterName}
          </SubmitButton>
        </form>
      ) : open ? (
        <form action={formAction} className="space-y-3">
          <CsrfField token={csrfToken} />
          <input type="hidden" name="voterId" value={voterId} />
          <input type="hidden" name="blocked" value="on" />

          <Field label="Reason" htmlFor={`block-${voterId}`}>
            <input
              id={`block-${voterId}`}
              name="reason"
              maxLength={500}
              className={cx(inputClass, 'text-sm')}
              placeholder="Why is this name being blocked?"
            />
          </Field>

          <div className="flex gap-2">
            <SubmitButton variant="danger" pendingLabel="Blocking...">
              Block this name
            </SubmitButton>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-lg px-3 py-2 text-sm text-muted hover:text-ink"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-lg border border-danger/30 px-3 py-1.5 text-sm font-medium text-danger hover:bg-danger/10"
        >
          Block
        </button>
      )}
    </div>
  );
}
