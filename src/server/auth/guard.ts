import { redirect } from 'next/navigation';
import { appError } from '@/lib/errors';
import { isValidCsrfToken, readAdminSessionToken, readVoterSessionToken } from '@/lib/cookies';
import { assertTrustedOriginFromContext } from '@/lib/http';
import type { Capability } from '@/types/domain';
import * as AdminService from '../services/admin.service';

/**
 * Authorisation guards.
 *
 * THE RULE: every Server Action and every Route Handler that reads or changes
 * admin data begins with one of these calls. Hiding a button in the UI is a
 * courtesy to the operator, never a control - an admin route reached directly
 * by URL, or an action invoked by a hand-crafted POST, hits exactly the same
 * guard as one reached by clicking.
 */

export type AdminActor = {
  adminId: string;
  adminLabel: string;
  role: Awaited<ReturnType<typeof AdminService.getCurrentAdmin>> extends null
    ? never
    : NonNullable<Awaited<ReturnType<typeof AdminService.getCurrentAdmin>>>['admin']['role'];
};

/**
 * Require an authenticated administrator inside a Server Action or Route
 * Handler. Throws an AppError, which the caller converts into a 401/403.
 */
export async function requireAdmin(capability?: Capability) {
  const current = await AdminService.getCurrentAdmin();
  if (!current) throw appError('UNAUTHORIZED');

  if (capability && !AdminService.hasCapability(current.admin.role, capability)) {
    throw appError('FORBIDDEN');
  }

  return current;
}

/**
 * Require an administrator inside a Server Component, redirecting to the login
 * page instead of throwing. `returnTo` is echoed back so the operator lands
 * where they were going.
 */
export async function requireAdminPage(capability?: Capability, returnTo?: string) {
  const current = await AdminService.getCurrentAdmin();

  if (!current) {
    const target = returnTo ? `/admin/login?next=${encodeURIComponent(returnTo)}` : '/admin/login';
    redirect(target);
  }

  if (capability && !AdminService.hasCapability(current.admin.role, capability)) {
    redirect('/admin?denied=1');
  }

  return current;
}

/** Actor shape passed into services for audit attribution. */
export function actorFrom(current: NonNullable<Awaited<ReturnType<typeof requireAdmin>>>) {
  return { adminId: current.admin.id, adminLabel: current.admin.email };
}

// --------------------------------------------------------------------------
// CSRF
// --------------------------------------------------------------------------

/**
 * Full CSRF check for an administrative mutation: same-origin, then a valid
 * synchroniser token bound to this session.
 *
 * Next.js already applies its own origin check to Server Actions. This is a
 * second, independent layer that does not depend on framework internals staying
 * the way they are.
 */
export async function assertAdminCsrf(submittedToken: unknown): Promise<void> {
  await assertTrustedOriginFromContext();

  const sessionToken = await readAdminSessionToken();
  if (!isValidCsrfToken(sessionToken, typeof submittedToken === 'string' ? submittedToken : null)) {
    throw appError('CSRF_FAILED');
  }
}

/** The same check for a voter-facing mutation. */
export async function assertVoterCsrf(submittedToken: unknown): Promise<void> {
  await assertTrustedOriginFromContext();

  const sessionToken = await readVoterSessionToken();

  // A voter with no session yet cannot have a token. That is legitimate on the
  // very first IGN submission, and the origin check above still applies.
  if (!sessionToken) return;

  if (!isValidCsrfToken(sessionToken, typeof submittedToken === 'string' ? submittedToken : null)) {
    throw appError('CSRF_FAILED');
  }
}
