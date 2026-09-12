'use client';

import { useActionState, useState } from 'react';
import { submitVoteAction } from '@/server/actions/voter.actions';
import type { PublicEvent } from '@/server/presenters/public';
import { Alert, CsrfField, cx } from '../ui';
import { SubmitButton } from '../submit-button';

/**
 * Step 3: the ballot.
 *
 * Client-side selection limits here are an affordance, nothing more. The server
 * revalidates the whole selection against the event's own active options inside
 * the vote transaction, so disabling a checkbox in this component is a courtesy
 * to the voter and not a control - a crafted request bypasses every line of it
 * and still gets refused.
 */
export function BallotForm({
  event,
  csrfToken,
}: {
  event: PublicEvent;
  csrfToken: string | null;
}) {
  const [state, formAction] = useActionState(submitVoteAction, null);
  const [selected, setSelected] = useState<string[]>([]);

  const isMulti = event.votingType === 'MULTIPLE_CHOICE';
  const atLimit = isMulti && selected.length >= event.maxSelections;
  const belowMinimum = selected.length < event.minSelections;

  function toggle(optionId: string, checked: boolean) {
    setSelected((previous) => {
      if (!isMulti) return checked ? [optionId] : [];
      if (checked) {
        return previous.includes(optionId) ? previous : [...previous, optionId];
      }
      return previous.filter((id) => id !== optionId);
    });
  }

  const errorMessage = state && !state.ok ? state.message : null;

  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="eventSlug" value={event.slug} />
      <CsrfField token={csrfToken} />

      {errorMessage ? <Alert tone="danger">{errorMessage}</Alert> : null}

      <fieldset className="space-y-3">
        <legend className="sr-only">{event.ballotRule}</legend>

        {event.options.map((option) => {
          const isSelected = selected.includes(option.id);
          // Only lock out *unselected* options at the limit, so the voter can
          // always change their mind without first hunting for what to untick.
          const isDisabled = isMulti && atLimit && !isSelected;

          return (
            <label key={option.id} className="option-card">
              <input
                type={isMulti ? 'checkbox' : 'radio'}
                name="optionIds"
                value={option.id}
                checked={isSelected}
                disabled={isDisabled}
                onChange={(event_) => toggle(option.id, event_.target.checked)}
                className={cx(
                  'mt-0.5 h-5 w-5 shrink-0 accent-[rgb(var(--c-accent))]',
                  isMulti ? 'rounded' : 'rounded-full',
                )}
              />

              {option.imageUrl ? (
                /* eslint-disable-next-line @next/next/no-img-element -- avatars are arbitrary
                   admin-supplied remote URLs; next/image would need every possible host
                   pre-registered in remotePatterns. The URL is validated as http(s) on input. */
                <img
                  src={option.imageUrl}
                  alt=""
                  loading="lazy"
                  className="h-12 w-12 shrink-0 rounded-lg border border-line object-cover"
                />
              ) : null}

              <span className="min-w-0 flex-1">
                <span className="block font-semibold leading-snug">{option.name}</span>
                {option.description ? (
                  <span className="mt-0.5 block text-sm text-muted">{option.description}</span>
                ) : null}
              </span>
            </label>
          );
        })}
      </fieldset>

      {isMulti ? (
        <p className="text-sm text-muted" aria-live="polite">
          {selected.length} of {event.maxSelections} selected
          {event.minSelections > 1 ? ` · at least ${event.minSelections} required` : ''}
        </p>
      ) : null}

      {/*
        Sticky action bar: on a phone the option list is usually taller than the
        viewport, and a submit button below the fold is the single most common
        reason a voter abandons a ballot.
      */}
      <div className="sticky bottom-0 -mx-4 border-t border-line bg-bg/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-card sm:border sm:px-4">
        <SubmitButton
          className="w-full"
          pendingLabel="Recording your vote..."
          disabled={belowMinimum}
        >
          Submit vote
        </SubmitButton>

        <p className="mt-2 text-center text-xs text-muted">
          {belowMinimum
            ? event.minSelections === 1
              ? 'Choose an option to continue.'
              : `Choose at least ${event.minSelections} options to continue.`
            : 'Your vote is final and cannot be changed.'}
        </p>
      </div>
    </form>
  );
}
