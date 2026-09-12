'use client';

import { useActionState, useState } from 'react';
import {
  changeOwnPasswordAction,
  createAdminAction,
  resetAdminPasswordAction,
  updateAdminAction,
} from '@/server/actions/admin.actions';
import { PASSWORD_MIN_LENGTH } from '@/lib/password-policy';
import { ADMIN_ROLE_LABELS, type AdminRole } from '@/types/domain';
import { Alert, Card, CsrfField, Field, inputClass, selectClass } from '../ui';
import { SubmitButton } from '../submit-button';

/** Administrator account management forms. */

export function CreateAdminForm({ csrfToken }: { csrfToken: string | null }) {
  const [state, formAction] = useActionState(createAdminAction, null);
  const [open, setOpen] = useState(false);

  const errors = state && !state.ok ? state.fieldErrors : undefined;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full rounded-card border border-dashed border-line py-3 text-sm font-medium text-muted hover:border-accent hover:text-accent"
      >
        + Add an administrator
      </button>
    );
  }

  return (
    <Card className="p-5">
      <form action={formAction} className="space-y-4">
        <CsrfField token={csrfToken} />

        <h2 className="font-semibold">New administrator</h2>

        {state ? (
          <Alert tone={state.ok ? 'ok' : 'danger'}>
            {state.ok ? state.data.message : state.message}
          </Alert>
        ) : null}

        <Field label="E-mail" htmlFor="new-admin-email" required errors={errors?.['email']}>
          <input
            id="new-admin-email"
            name="email"
            type="email"
            required
            autoCapitalize="none"
            className={inputClass}
          />
        </Field>

        <Field
          label="Display name"
          htmlFor="new-admin-name"
          required
          errors={errors?.['displayName']}
        >
          <input id="new-admin-name" name="displayName" required className={inputClass} />
        </Field>

        <Field
          label="Temporary password"
          htmlFor="new-admin-password"
          required
          hint={`At least ${PASSWORD_MIN_LENGTH} characters. They will be asked to change it on first sign-in.`}
          errors={errors?.['password']}
        >
          <input
            id="new-admin-password"
            name="password"
            type="text"
            required
            minLength={PASSWORD_MIN_LENGTH}
            className={inputClass}
            autoComplete="off"
          />
        </Field>

        <Field label="Role" htmlFor="new-admin-role" required errors={errors?.['role']}>
          <select id="new-admin-role" name="role" defaultValue="ADMIN" className={selectClass}>
            {Object.entries(ADMIN_ROLE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>

        <label className="flex items-center gap-2.5 text-sm">
          <input
            type="checkbox"
            name="mustChangePassword"
            defaultChecked
            className="h-5 w-5 rounded accent-[rgb(var(--c-accent))]"
          />
          Require a password change on first sign-in
        </label>

        <div className="flex gap-2">
          <SubmitButton pendingLabel="Creating...">Create administrator</SubmitButton>
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

export function UpdateAdminForm({
  adminId,
  displayName,
  role,
  isActive,
  isSelf,
  csrfToken,
}: {
  adminId: string;
  displayName: string;
  role: AdminRole;
  isActive: boolean;
  isSelf: boolean;
  csrfToken: string | null;
}) {
  const [updateState, updateFormAction] = useActionState(updateAdminAction, null);
  const [resetState, resetFormAction] = useActionState(resetAdminPasswordAction, null);
  const [open, setOpen] = useState(false);

  const feedback = updateState ?? resetState;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium hover:bg-surface-2"
      >
        Manage
      </button>
    );
  }

  return (
    <div className="w-full space-y-4 border-t border-line pt-4">
      {feedback ? (
        <Alert tone={feedback.ok ? 'ok' : 'danger'}>
          {feedback.ok ? feedback.data.message : feedback.message}
        </Alert>
      ) : null}

      <form action={updateFormAction} className="space-y-3">
        <CsrfField token={csrfToken} />
        <input type="hidden" name="adminId" value={adminId} />

        <Field label="Display name" htmlFor={`name-${adminId}`} required>
          <input
            id={`name-${adminId}`}
            name="displayName"
            required
            defaultValue={displayName}
            className={inputClass}
          />
        </Field>

        <Field label="Role" htmlFor={`role-${adminId}`} required>
          <select
            id={`role-${adminId}`}
            name="role"
            defaultValue={role}
            className={selectClass}
          >
            {Object.entries(ADMIN_ROLE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>

        <label className="flex items-center gap-2.5 text-sm">
          <input
            type="checkbox"
            name="isActive"
            defaultChecked={isActive}
            className="h-5 w-5 rounded accent-[rgb(var(--c-accent))]"
          />
          Account is active
        </label>

        {isSelf ? (
          <p className="text-xs text-warn">
            This is your own account. Deactivating it or removing your super-administrator role will
            sign you out.
          </p>
        ) : null}

        <SubmitButton pendingLabel="Saving...">Save changes</SubmitButton>
      </form>

      <form action={resetFormAction} className="space-y-3 border-t border-line pt-4">
        <CsrfField token={csrfToken} />
        <input type="hidden" name="adminId" value={adminId} />

        <Field
          label="Set a new password"
          htmlFor={`reset-${adminId}`}
          hint="Signs out every session for this account."
        >
          <input
            id={`reset-${adminId}`}
            name="newPassword"
            type="text"
            minLength={PASSWORD_MIN_LENGTH}
            className={inputClass}
            autoComplete="off"
            placeholder={`At least ${PASSWORD_MIN_LENGTH} characters`}
          />
        </Field>

        <SubmitButton variant="danger" pendingLabel="Resetting...">
          Reset password
        </SubmitButton>
      </form>

      <button
        type="button"
        onClick={() => setOpen(false)}
        className="text-sm text-muted hover:text-ink"
      >
        Close
      </button>
    </div>
  );
}

/**
 * Change your own password.
 *
 * On success every session is revoked and the operator is redirected to sign in
 * again - which is the entire point of changing a password.
 */
export function ChangePasswordForm({ csrfToken }: { csrfToken: string | null }) {
  const [state, formAction] = useActionState(changeOwnPasswordAction, null);
  const errors = state && !state.ok ? state.fieldErrors : undefined;

  return (
    <form action={formAction} className="space-y-4">
      <CsrfField token={csrfToken} />

      {state && !state.ok ? <Alert tone="danger">{state.message}</Alert> : null}

      <Field
        label="Current password"
        htmlFor="currentPassword"
        required
        errors={errors?.['currentPassword']}
      >
        <input
          id="currentPassword"
          name="currentPassword"
          type="password"
          required
          autoComplete="current-password"
          className={inputClass}
        />
      </Field>

      <Field
        label="New password"
        htmlFor="newPassword"
        required
        hint={`At least ${PASSWORD_MIN_LENGTH} characters. Length matters far more than symbols.`}
        errors={errors?.['newPassword']}
      >
        <input
          id="newPassword"
          name="newPassword"
          type="password"
          required
          minLength={PASSWORD_MIN_LENGTH}
          autoComplete="new-password"
          className={inputClass}
        />
      </Field>

      <Field
        label="Confirm new password"
        htmlFor="confirmPassword"
        required
        errors={errors?.['confirmPassword']}
      >
        <input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          required
          autoComplete="new-password"
          className={inputClass}
        />
      </Field>

      <Alert tone="info">
        Changing your password signs out every session, including this one.
      </Alert>

      <SubmitButton pendingLabel="Updating...">Change password</SubmitButton>
    </form>
  );
}
