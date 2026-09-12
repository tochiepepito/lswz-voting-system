'use client';

import { useActionState } from 'react';
import { loginAction } from '@/server/actions/admin.actions';
import { Alert, Field, inputClass } from '../ui';
import { SubmitButton } from '../submit-button';

/**
 * Administrator sign-in.
 *
 * Note what is NOT here: no "e-mail not found" hint, no separate error for a
 * disabled account, no per-field validation message on the password. The server
 * returns one indistinguishable failure for every wrong-credential case, and
 * this form simply renders it - anything more would turn the form into an
 * account-enumeration oracle.
 */
export function LoginForm({ redirectTo }: { redirectTo?: string }) {
  const [state, formAction] = useActionState(loginAction, null);

  const message = state && !state.ok ? state.message : null;

  return (
    <form action={formAction} className="space-y-5">
      {redirectTo ? <input type="hidden" name="redirectTo" value={redirectTo} /> : null}

      {message ? <Alert tone="danger">{message}</Alert> : null}

      <Field label="E-mail" htmlFor="email" required>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className={inputClass}
        />
      </Field>

      <Field label="Password" htmlFor="password" required>
        <input
          id="password"
          name="password"
          type="password"
          required
          autoComplete="current-password"
          className={inputClass}
        />
      </Field>

      <SubmitButton className="w-full" pendingLabel="Signing in...">
        Sign in
      </SubmitButton>
    </form>
  );
}
