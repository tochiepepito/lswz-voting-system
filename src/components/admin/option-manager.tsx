'use client';

import { useActionState, useState } from 'react';
import {
  addOptionAction,
  deleteOptionAction,
  reorderOptionsAction,
  shuffleOptionsAction,
  updateOptionAction,
} from '@/server/actions/event.actions';
import { Alert, Badge, Card, CsrfField, Field, cx, inputClass } from '../ui';
import { SubmitButton } from '../submit-button';

/**
 * Manage the options on an existing event.
 *
 * Each row is an independent form with its own action state, so saving one
 * option cannot clobber unsaved edits in another and a failure is reported next
 * to the thing that failed.
 *
 * DELETION vs DEACTIVATION: an option that has received votes cannot be
 * deleted - the server refuses, because removing it would rewrite historical
 * tallies and orphan the ballots that chose it. Deactivating hides it from new
 * voters while every past result stays reconstructable.
 *
 * ORDER vs RANDOMIZE: the arrows here set `displayOrder`, the one order admins
 * ever see and the order voters get unless the event's "randomize" setting (on
 * the event form) overrides it with a per-voter shuffle at ballot time. Moving
 * a row or shuffling here never touches that per-voter randomization - the two
 * are independent, and both can be on at once (a fixed admin-facing order, a
 * scrambled voter-facing one).
 */

export type ManagedOption = {
  id: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  displayOrder: number;
  isActive: boolean;
  voteCount: number;
};

export function OptionManager({
  eventId,
  options,
  csrfToken,
  editable,
}: {
  eventId: string;
  options: readonly ManagedOption[];
  csrfToken: string | null;
  editable: boolean;
}) {
  const [reorderState, reorderFormAction] = useActionState(reorderOptionsAction, null);
  const orderedIds = options.map((option) => option.id);

  return (
    <div className="space-y-4">
      {options.length === 0 ? (
        <Alert tone="warn">
          This event has no options yet. Voting cannot open until at least two exist.
        </Alert>
      ) : (
        <>
          {reorderState && !reorderState.ok ? <Alert tone="danger">{reorderState.message}</Alert> : null}

          {editable && options.length > 1 ? (
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted">
                Use the arrows to arrange the order shown to admins (and to voters, unless
                randomised per voter on the event form).
              </p>
              <ShuffleButton eventId={eventId} csrfToken={csrfToken} />
            </div>
          ) : null}

          <ul className="space-y-3">
            {options.map((option, index) => (
              <OptionRow
                key={option.id}
                eventId={eventId}
                option={option}
                csrfToken={csrfToken}
                editable={editable}
                canMoveUp={editable && index > 0}
                canMoveDown={editable && index < options.length - 1}
                moveUpOrder={swap(orderedIds, index, index - 1)}
                moveDownOrder={swap(orderedIds, index, index + 1)}
                reorderFormAction={reorderFormAction}
              />
            ))}
          </ul>
        </>
      )}

      {editable ? <AddOptionForm eventId={eventId} csrfToken={csrfToken} /> : null}
    </div>
  );
}

/** New array with the elements at `a` and `b` swapped. No-op if either is out of range. */
function swap<T>(items: readonly T[], a: number, b: number): T[] {
  const result = [...items];
  if (a < 0 || b < 0 || a >= result.length || b >= result.length) return result;

  // Both indices were just bounds-checked above.
  [result[a], result[b]] = [result[b]!, result[a]!];
  return result;
}

function ShuffleButton({ eventId, csrfToken }: { eventId: string; csrfToken: string | null }) {
  const [state, formAction] = useActionState(shuffleOptionsAction, null);

  return (
    <div className="shrink-0">
      <form action={formAction} className="flex items-center gap-2">
        <CsrfField token={csrfToken} />
        <input type="hidden" name="eventId" value={eventId} />
        <SubmitButton variant="secondary" pendingLabel="Shuffling...">
          🔀 Shuffle order
        </SubmitButton>
      </form>
      {state && !state.ok ? <p className="mt-1 text-right text-xs text-danger">{state.message}</p> : null}
    </div>
  );
}

function OptionRow({
  eventId,
  option,
  csrfToken,
  editable,
  canMoveUp,
  canMoveDown,
  moveUpOrder,
  moveDownOrder,
  reorderFormAction,
}: {
  eventId: string;
  option: ManagedOption;
  csrfToken: string | null;
  editable: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  moveUpOrder: string[];
  moveDownOrder: string[];
  reorderFormAction: (formData: FormData) => void;
}) {
  const [updateState, updateFormAction] = useActionState(updateOptionAction, null);
  const [deleteState, deleteFormAction] = useActionState(deleteOptionAction, null);
  const [expanded, setExpanded] = useState(false);

  const hasVotes = option.voteCount > 0;

  return (
    <Card as="li" className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          {editable ? (
            <div className="flex shrink-0 flex-col gap-1">
              <form action={reorderFormAction}>
                <CsrfField token={csrfToken} />
                <input type="hidden" name="eventId" value={eventId} />
                <input type="hidden" name="orderedOptionIdsJson" value={JSON.stringify(moveUpOrder)} />
                <button
                  type="submit"
                  disabled={!canMoveUp}
                  aria-label={`Move "${option.name}" up`}
                  className="flex h-7 w-7 items-center justify-center rounded-lg border border-line text-sm hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-30"
                >
                  ▲
                </button>
              </form>
              <form action={reorderFormAction}>
                <CsrfField token={csrfToken} />
                <input type="hidden" name="eventId" value={eventId} />
                <input type="hidden" name="orderedOptionIdsJson" value={JSON.stringify(moveDownOrder)} />
                <button
                  type="submit"
                  disabled={!canMoveDown}
                  aria-label={`Move "${option.name}" down`}
                  className="flex h-7 w-7 items-center justify-center rounded-lg border border-line text-sm hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-30"
                >
                  ▼
                </button>
              </form>
            </div>
          ) : null}

          {option.imageUrl ? (
            /* eslint-disable-next-line @next/next/no-img-element -- arbitrary remote avatar URL */
            <img
              src={option.imageUrl}
              alt=""
              className="h-10 w-10 shrink-0 rounded-lg border border-line object-cover"
            />
          ) : null}

          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{option.name}</span>
              {!option.isActive ? <Badge tone="neutral">Inactive</Badge> : null}
              {hasVotes ? <Badge tone="accent">{option.voteCount} votes</Badge> : null}
            </div>
            {option.description ? (
              <p className="mt-0.5 text-sm text-muted">{option.description}</p>
            ) : null}
          </div>
        </div>

        {editable ? (
          <button
            type="button"
            onClick={() => setExpanded((previous) => !previous)}
            aria-expanded={expanded}
            className="shrink-0 rounded-lg border border-line px-3 py-1.5 text-sm font-medium hover:bg-surface-2"
          >
            {expanded ? 'Close' : 'Edit'}
          </button>
        ) : null}
      </div>

      {expanded ? (
        <div className="mt-4 space-y-4 border-t border-line pt-4">
          {updateState ? (
            <Alert tone={updateState.ok ? 'ok' : 'danger'}>
              {updateState.ok ? updateState.data.message : updateState.message}
            </Alert>
          ) : null}
          {deleteState && !deleteState.ok ? (
            <Alert tone="danger">{deleteState.message}</Alert>
          ) : null}

          <form action={updateFormAction} className="space-y-3">
            <CsrfField token={csrfToken} />
            <input type="hidden" name="id" value={option.id} />
            <input type="hidden" name="eventId" value={eventId} />
            <input type="hidden" name="displayOrder" value={option.displayOrder} />

            <Field label="Name" htmlFor={`name-${option.id}`} required>
              <input
                id={`name-${option.id}`}
                name="name"
                required
                defaultValue={option.name}
                maxLength={120}
                className={inputClass}
              />
            </Field>

            <Field label="Description" htmlFor={`description-${option.id}`}>
              <input
                id={`description-${option.id}`}
                name="description"
                defaultValue={option.description ?? ''}
                maxLength={1000}
                className={inputClass}
              />
            </Field>

            <Field label="Image URL" htmlFor={`imageUrl-${option.id}`}>
              <input
                id={`imageUrl-${option.id}`}
                name="imageUrl"
                defaultValue={option.imageUrl ?? ''}
                maxLength={2048}
                className={cx(inputClass, 'font-mono text-xs')}
              />
            </Field>

            <label className="flex items-center gap-2.5 text-sm">
              <input
                type="checkbox"
                name="isActive"
                defaultChecked={option.isActive}
                className="h-5 w-5 rounded accent-[rgb(var(--c-accent))]"
              />
              Available for voters to choose
            </label>

            <SubmitButton pendingLabel="Saving...">Save option</SubmitButton>
          </form>

          <form
            action={deleteFormAction}
            onSubmit={(event) => {
              if (!window.confirm(`Delete "${option.name}"? This cannot be undone.`)) {
                event.preventDefault();
              }
            }}
            className="border-t border-line pt-4"
          >
            <CsrfField token={csrfToken} />
            <input type="hidden" name="eventId" value={eventId} />
            <input type="hidden" name="optionId" value={option.id} />

            {hasVotes ? (
              <p className="text-xs text-muted">
                This option has votes and cannot be deleted. Untick &ldquo;available&rdquo; above to
                withdraw it instead.
              </p>
            ) : (
              <SubmitButton variant="danger" pendingLabel="Deleting...">
                Delete option
              </SubmitButton>
            )}
          </form>
        </div>
      ) : null}
    </Card>
  );
}

function AddOptionForm({ eventId, csrfToken }: { eventId: string; csrfToken: string | null }) {
  const [state, formAction] = useActionState(addOptionAction, null);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full rounded-card border border-dashed border-line py-3 text-sm font-medium text-muted hover:border-accent hover:text-accent"
      >
        + Add an option
      </button>
    );
  }

  return (
    <Card className="p-4">
      <form action={formAction} className="space-y-3">
        <CsrfField token={csrfToken} />
        <input type="hidden" name="eventId" value={eventId} />
        <input type="hidden" name="displayOrder" value={0} />
        <input type="hidden" name="isActive" value="on" />

        {state ? (
          <Alert tone={state.ok ? 'ok' : 'danger'}>
            {state.ok ? state.data.message : state.message}
          </Alert>
        ) : null}

        <Field label="Name" htmlFor="new-option-name" required errors={state && !state.ok ? state.fieldErrors?.['name'] : undefined}>
          <input
            id="new-option-name"
            name="name"
            required
            maxLength={120}
            className={inputClass}
            placeholder="Candidate or option name"
          />
        </Field>

        <Field label="Description" htmlFor="new-option-description">
          <input
            id="new-option-description"
            name="description"
            maxLength={1000}
            className={inputClass}
            placeholder="Optional"
          />
        </Field>

        <Field label="Image URL" htmlFor="new-option-image">
          <input
            id="new-option-image"
            name="imageUrl"
            maxLength={2048}
            className={cx(inputClass, 'font-mono text-xs')}
            placeholder="https://... (optional)"
          />
        </Field>

        <div className="flex gap-2">
          <SubmitButton pendingLabel="Adding...">Add option</SubmitButton>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded-lg px-3 py-2 text-sm text-muted hover:text-ink"
          >
            Cancel
          </button>
        </div>
      </form>
    </Card>
  );
}
