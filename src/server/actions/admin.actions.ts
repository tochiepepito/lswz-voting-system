'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getRequestContext, assertTrustedOriginFromContext } from '@/lib/http';
import { fail, ok, withResult } from '@/lib/result';
import { formDataToObject, toFieldErrors } from '@/schemas/common';
import {
  changePasswordSchema,
  createAdminSchema,
  loginSchema,
  resetAdminPasswordSchema,
  updateAdminSchema,
} from '@/schemas/admin';
import { actorFrom, assertAdminCsrf, requireAdmin } from '@/server/auth/guard';
import * as AdminService from '@/server/services/admin.service';
import type { ActionState } from '@/types/actions';

/** Administrator authentication and account-management actions. */

/**
 * Sign in.
 *
 * No CSRF token is required here, because there is no session to bind one to
 * yet. The same-origin check still applies, and the real protection against
 * login CSRF is that a forged sign-in gains the attacker nothing.
 */
export async function loginAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const raw = formDataToObject(formData);

  const outcome = await withResult('loginAction', async () => {
    await assertTrustedOriginFromContext();

    const parsed = loginSchema.safeParse(raw);
    if (!parsed.success) {
      return fail(
        'VALIDATION_FAILED',
        'Enter your e-mail and password.',
        toFieldErrors(parsed.error),
      );
    }

    const admin = await AdminService.login({
      email: parsed.data.email,
      password: parsed.data.password,
      context: await getRequestContext(),
    });

    return ok({
      // `redirectTo` was already narrowed to a local path by the schema, which
      // is what stops the login form becoming an open redirect.
      redirectTo: parsed.data.redirectTo ?? '/admin',
      mustChangePassword: admin.mustChangePassword,
      message: 'Signed in.',
    });
  });

  if (outcome.ok) {
    redirect(outcome.data.mustChangePassword ? '/admin/account?first=1' : outcome.data.redirectTo);
  }

  return outcome;
}

export async function logoutAction(): Promise<void> {
  await withResult('logoutAction', async () => {
    await AdminService.logout(await getRequestContext());
    return ok({});
  });

  redirect('/admin/login');
}

// --------------------------------------------------------------------------
// Account management
// --------------------------------------------------------------------------

export async function createAdminAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const raw = formDataToObject(formData);

  return withResult('createAdminAction', async () => {
    const current = await requireAdmin('admin:manage');
    await assertAdminCsrf(raw['csrfToken']);

    const parsed = createAdminSchema.safeParse(raw);
    if (!parsed.success) {
      return fail(
        'VALIDATION_FAILED',
        'Please correct the highlighted fields.',
        toFieldErrors(parsed.error),
      );
    }

    const created = await AdminService.createAdmin(parsed.data, {
      ...actorFrom(current),
      context: await getRequestContext(),
    });

    revalidatePath('/admin/admins');

    return ok({ message: `Administrator ${created.email} created.` });
  });
}

export async function updateAdminAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const raw = formDataToObject(formData);

  return withResult('updateAdminAction', async () => {
    const current = await requireAdmin('admin:manage');
    await assertAdminCsrf(raw['csrfToken']);

    const parsed = updateAdminSchema.safeParse(raw);
    if (!parsed.success) {
      return fail(
        'VALIDATION_FAILED',
        'Please correct the highlighted fields.',
        toFieldErrors(parsed.error),
      );
    }

    const updated = await AdminService.updateAdmin(parsed.data, {
      ...actorFrom(current),
      context: await getRequestContext(),
    });

    revalidatePath('/admin/admins');

    return ok({ message: `Administrator ${updated.email} updated.` });
  });
}

export async function resetAdminPasswordAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const raw = formDataToObject(formData);

  return withResult('resetAdminPasswordAction', async () => {
    const current = await requireAdmin('admin:manage');
    await assertAdminCsrf(raw['csrfToken']);

    const parsed = resetAdminPasswordSchema.safeParse(raw);
    if (!parsed.success) {
      return fail('VALIDATION_FAILED', 'Choose a stronger password.', toFieldErrors(parsed.error));
    }

    await AdminService.resetPassword(parsed.data, {
      ...actorFrom(current),
      context: await getRequestContext(),
    });

    revalidatePath('/admin/admins');

    return ok({ message: 'Password reset. Every session for that account was signed out.' });
  });
}

/**
 * Change your own password.
 *
 * On success every session for the account is revoked, including this one, so
 * the operator is redirected to the login page to sign in again. That is the
 * point: a password change that leaves old sessions alive protects nothing.
 */
export async function changeOwnPasswordAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const raw = formDataToObject(formData);

  const outcome = await withResult('changeOwnPasswordAction', async () => {
    const current = await requireAdmin();
    await assertAdminCsrf(raw['csrfToken']);

    const parsed = changePasswordSchema.safeParse(raw);
    if (!parsed.success) {
      return fail(
        'VALIDATION_FAILED',
        'Please correct the highlighted fields.',
        toFieldErrors(parsed.error),
      );
    }

    await AdminService.changeOwnPassword(
      {
        adminId: current.admin.id,
        currentPassword: parsed.data.currentPassword,
        newPassword: parsed.data.newPassword,
      },
      await getRequestContext(),
    );

    return ok({ message: 'Password changed.' });
  });

  if (outcome.ok) redirect('/admin/login?changed=1');

  return outcome;
}
