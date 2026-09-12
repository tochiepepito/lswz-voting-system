'use client';

import { useActionState } from 'react';
import { claimIdentityAction } from '@/server/actions/voter.actions';
import { IGN_HELP_TEXT } from '@/schemas/voter';
import { IGN_MAX_LENGTH } from '@/lib/ign';
import { Alert, CsrfField, Field, inputClass } from '../ui';
import { SubmitButton } from '../submit-button';

/**
 * Step 2 of the voter flow: enter an in-game name.
 *
 * The only field is the IGN. No e-mail, no password, no account - that is the
 * whole point of the design, and it is why the honesty note below the field is
 * part of the interface rather than buried in a policy page: voters should know
 * that their name is what links them to their ballot.
 */
export function IgnForm({
  eventSlug,
  csrfToken,
  defaultValue,
}: {
  eventSlug: string;
  csrfToken: string | null;
  defaultValue?: string;
}) {
  const [state, formAction] = useActionState(claimIdentityAction, null);

  const fieldErrors = state && !state.ok ? state.fieldErrors : undefined;
  const ignErrors = fieldErrors?.['ign'];

  // A failure with no field-level detail (rate limited, event closed, blocked)
  // is shown as a banner instead.
  const banner = state && !state.ok && !ignErrors ? state.message : null;

  return (
    <form action={formAction} className="space-y-5" noValidate>
      <input type="hidden" name="eventSlug" value={eventSlug} />
      <CsrfField token={csrfToken} />

      {banner ? <Alert tone="danger">{banner}</Alert> : null}

      <Field
        label="Your in-game name"
        htmlFor="ign"
        required
        hint={IGN_HELP_TEXT}
        errors={ignErrors}
      >
        <input
          id="ign"
          name="ign"
          type="text"
          required
          autoFocus
          defaultValue={defaultValue}
          maxLength={IGN_MAX_LENGTH}
          // Names are case-insensitive to this system, but autocapitalising
          // would silently change what the player sees themselves typing.
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoComplete="off"
          enterKeyHint="go"
          inputMode="text"
          aria-describedby="ign-hint"
          aria-invalid={ignErrors ? true : undefined}
          className={inputClass}
          placeholder="e.g. PlayerOne"
        />
      </Field>

      <div className="rounded-card border border-line bg-surface-2 p-3 text-xs leading-relaxed text-muted">
        <p>
          Your in-game name is recorded so that each player votes once, and so organisers can check
          participation. It is matched without regard to capitalisation or extra spaces, so{' '}
          <span className="font-mono text-ink">PlayerOne</span> and{' '}
          <span className="font-mono text-ink">playerone</span> are the same person.
        </p>
        <p className="mt-2">
          This is community-level verification, not proof of identity - anyone can type any name.
          Organisers can see and correct suspicious activity.
        </p>
      </div>

      <SubmitButton pendingLabel="Checking..." className="w-full sm:w-auto">
        Continue to vote
      </SubmitButton>
    </form>
  );
}
