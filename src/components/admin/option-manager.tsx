'use client';

import { useActionState, useState } from 'react';
import {
  addOptionAction,
  deleteOptionAction,
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
  return (
    <div className="space-y-4">
      {options.length === 0 ? (
        <Alert tone="warn">
          This event has no options yet. Voting cannot open until at least two exist.
        </Alert>
      ) : (
        <ul className="space-y-3">
          {options.map((option) => (
            <OptionRow
              key={option.id}
              eventId={eventId}
              option={option}
              csrfToken={csrfToken}
              editable={editable}
            />
          ))}
        </ul>
      )}

      {editable ? <AddOptionForm eventId={eventId} csrfToken={csrfToken} /> : null}
    </div>
  );
}

function OptionRow({
  eventId,
  option,
  csrfToken,
  editable,
}: {
  eventId: string;
  option: ManagedOption;
  csrfToken: string | null;
  editable: boolean;
}) {
  const [updateState, updateFormAction] = useActionState(updateOptionAction, null);
  const [deleteState, deleteFormAction] = useActionState(deleteOptionAction, null);
  const [expanded, setExpanded] = useState(false);

  const hasVotes = option.voteCount > 0;

  return (
    <Card as="li" className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
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
