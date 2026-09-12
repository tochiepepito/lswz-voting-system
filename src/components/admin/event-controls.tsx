'use client';

import { useActionState, useState } from 'react';
import { duplicateEventAction, eventLifecycleAction } from '@/server/actions/event.actions';
import type { EventLifecycleAction } from '@/schemas/event';
import type { EventStatus } from '@/types/domain';
import { Alert, Card, CsrfField, Field, inputClass } from '../ui';
import { SubmitButton } from '../submit-button';

/**
 * Event lifecycle controls.
 *
 * Which buttons appear is derived from the current status using the same
 * transition table the server enforces, so the UI cannot offer an action that
 * would be refused. The server checks it again regardless - this component only
 * decides what is worth showing.
 */

const AVAILABLE: Record<EventStatus, EventLifecycleAction[]> = {
  DRAFT: ['publish', 'open'],
  SCHEDULED: ['open', 'close', 'unpublish'],
  ACTIVE: ['close'],
  CLOSED: ['archive'],
  ARCHIVED: [],
};

const LABELS: Record<EventLifecycleAction, string> = {
  publish: 'Publish',
  unpublish: 'Return to draft',
  open: 'Open voting now',
  close: 'Close voting',
  archive: 'Archive',
};

const DESCRIPTIONS: Record<EventLifecycleAction, string> = {
  publish: 'Make the event visible to voters. It opens at its scheduled start time.',
  unpublish: 'Hide the event again. Only possible while it has no votes.',
  open: 'Start accepting votes immediately, ignoring the scheduled start time.',
  close: 'Stop accepting votes. This cannot be undone.',
  archive: 'Move the event out of the active list. Results are kept.',
};

/** Actions a careless click should not complete. */
const NEEDS_CONFIRMATION: ReadonlySet<EventLifecycleAction> = new Set(['close', 'archive', 'unpublish']);

export function LifecycleControls({
  eventId,
  status,
  csrfToken,
}: {
  eventId: string;
  status: EventStatus;
  csrfToken: string | null;
}) {
  const [state, formAction] = useActionState(eventLifecycleAction, null);
  const actions = AVAILABLE[status];

  if (actions.length === 0 && !state) {
    return <p className="text-sm text-muted">This event is archived. No further changes apply.</p>;
  }

  return (
    <div className="space-y-3">
      {state ? (
        <Alert tone={state.ok ? 'ok' : 'danger'}>
          {state.ok ? state.data.message : state.message}
        </Alert>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {actions.map((action) => (
          <form
            key={action}
            action={formAction}
            onSubmit={(event) => {
              if (
                NEEDS_CONFIRMATION.has(action) &&
                !window.confirm(`${LABELS[action]}?\n\n${DESCRIPTIONS[action]}`)
              ) {
                event.preventDefault();
              }
            }}
          >
            <CsrfField token={csrfToken} />
            <input type="hidden" name="eventId" value={eventId} />
            <input type="hidden" name="action" value={action} />
            <SubmitButton
              variant={action === 'close' || action === 'unpublish' ? 'danger' : 'primary'}
              pendingLabel="Working..."
            >
              {LABELS[action]}
            </SubmitButton>
          </form>
        ))}
      </div>

      <ul className="space-y-1 text-xs text-muted">
        {actions.map((action) => (
          <li key={action}>
            <span className="font-medium">{LABELS[action]}:</span> {DESCRIPTIONS[action]}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Duplicate an event.
 *
 * The copy always lands as a DRAFT with no schedule - see EventService. Copying
 * an active election's dates would silently open a second live ballot.
 */
export function DuplicateEventForm({
  eventId,
  suggestedTitle,
  csrfToken,
}: {
  eventId: string;
  suggestedTitle: string;
  csrfToken: string | null;
}) {
  const [state, formAction] = useActionState(duplicateEventAction, null);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg border border-line px-3 py-2 text-sm font-medium hover:bg-surface-2"
      >
        Duplicate event
      </button>
    );
  }

  return (
    <Card className="p-4">
      <form action={formAction} className="space-y-3">
        <CsrfField token={csrfToken} />
        <input type="hidden" name="eventId" value={eventId} />

        {state && !state.ok ? <Alert tone="danger">{state.message}</Alert> : null}

        <Field
          label="Title for the copy"
          htmlFor="duplicate-title"
          required
          hint="The copy starts as a draft with its options, but no schedule and no votes."
        >
          <input
            id="duplicate-title"
            name="title"
            required
            defaultValue={`${suggestedTitle} (copy)`}
            maxLength={140}
            className={inputClass}
          />
        </Field>

        <div className="flex gap-2">
          <SubmitButton pendingLabel="Duplicating...">Create copy</SubmitButton>
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
