import { env } from '@/lib/env';
import { appError } from '@/lib/errors';
import {
  generateToken,
  getDecoyPasswordDigest,
  hashPassword,
  hashSessionToken,
  passwordNeedsRehash,
  verifyPassword,
} from '@/lib/crypto';
import {
  clearAdminSessionToken,
  deriveCsrfToken,
  readAdminSessionToken,
  writeAdminSessionToken,
} from '@/lib/cookies';
import type { RequestContext } from '@/lib/http';
import { isUniqueViolationOn } from '@/lib/prisma';
import {
  countActiveSuperAdmins,
  createAdmin as createAdminRow,
  createAdminSession,
  findAdminById,
  findAdminSessionByTokenHash,
  findAdminWithSecretByEmail,
  findAdminWithSecretById,
  listAdmins,
  recordLoginFailure,
  recordLoginSuccess,
  revokeAdminSession,
  revokeAllAdminSessions,
  setAdminPassword,
  touchAdminSession,
  updateAdmin as updateAdminRow,
  type AdminRow,
} from '../repositories/admin.repository';
import type { AdminRole, Capability } from '@/types/domain';
import { roleHasCapability } from '@/types/domain';
import * as AuditService from './audit.service';
import * as RateLimitService from './rate-limit.service';

/**
 * AdminService
 *
 * Authentication and account management for the administrative area.
 *
 * ANTI-ENUMERATION. Every failure path of `login()` costs roughly the same
 * wall-clock time and returns the identical INVALID_CREDENTIALS error. An
 * unknown e-mail is verified against a decoy scrypt digest so it burns the same
 * ~100ms as a real one; a disabled account is only reported as disabled AFTER
 * the password has been proven correct. Without both, the login form is an
 * oracle for "which e-mail addresses are administrators here".
 *
 * SESSION HANDLING. The cookie holds a 256-bit random token; the database holds
 * only its HMAC. A fresh token is minted on every login (no session fixation),
 * and password changes and deactivations revoke every outstanding session.
 */

export type AuthenticatedAdmin = {
  admin: AdminRow;
  sessionId: string;
  csrfToken: string;
};

const SESSION_TTL_MS = env.ADMIN_SESSION_TTL_HOURS * 60 * 60 * 1000;

// --------------------------------------------------------------------------
// Authentication
// --------------------------------------------------------------------------

export async function login(params: {
  email: string;
  password: string;
  context: RequestContext;
}): Promise<AdminRow> {
  const { email, password, context } = params;
  const now = new Date();

  // Two limits: one on the source address, one on the account being targeted.
  // The per-account limit is what stops a distributed attack from spreading a
  // password spray across many IPs against a single known administrator.
  await RateLimitService.enforce('ADMIN_LOGIN_IP', context.ip, {
    summary: 'Too many administrator sign-in attempts from one address.',
    ipHash: context.ipHash,
    userAgentHash: context.userAgentHash,
  });

  await RateLimitService.enforce('ADMIN_LOGIN_ACCOUNT', email, {
    summary: 'Too many sign-in attempts against one administrator account.',
    ipHash: context.ipHash,
    userAgentHash: context.userAgentHash,
  });

  const admin = await findAdminWithSecretByEmail(email);

  if (!admin) {
    // Spend the same time as a real verification before failing.
    await verifyPassword(password, await getDecoyPasswordDigest());

    await AuditService.safeWrite({
      action: 'ADMIN_LOGIN_FAILED',
      actorType: 'SYSTEM',
      actorLabel: email,
      ipHash: context.ipHash,
      userAgentHash: context.userAgentHash,
      summary: 'A sign-in was attempted for an e-mail with no administrator account.',
    });

    throw appError('INVALID_CREDENTIALS');
  }

  if (admin.lockedUntil && admin.lockedUntil > now) {
    throw appError('ACCOUNT_LOCKED', {
      retryAfterSeconds: Math.ceil((admin.lockedUntil.getTime() - now.getTime()) / 1000),
    });
  }

  const passwordMatches = await verifyPassword(password, admin.passwordHash);

  if (!passwordMatches) {
    const failure = await recordLoginFailure(
      admin.id,
      env.ADMIN_LOCKOUT_THRESHOLD,
      env.ADMIN_LOCKOUT_MINUTES,
      now,
    );

    await AuditService.safeWrite({
      action: failure.lockedUntil ? 'ADMIN_LOCKED_OUT' : 'ADMIN_LOGIN_FAILED',
      actorType: 'SYSTEM',
      actorLabel: admin.email,
      adminId: admin.id,
      ipHash: context.ipHash,
      userAgentHash: context.userAgentHash,
      summary: failure.lockedUntil
        ? `Account "${admin.email}" was locked after repeated failed sign-ins.`
        : `A failed sign-in attempt for "${admin.email}".`,
      metadata: { failedLoginCount: failure.failedLoginCount },
    });

    throw appError('INVALID_CREDENTIALS');
  }

  // Only now, with the password proven, is it safe to reveal account state.
  if (!admin.isActive) throw appError('ACCOUNT_DISABLED');

  // Transparently upgrade digests created under weaker parameters.
  if (passwordNeedsRehash(admin.passwordHash)) {
    await setAdminPassword(admin.id, await hashPassword(password), now).catch(() => undefined);
  }

  await recordLoginSuccess(admin.id, now);

  const token = generateToken(32);
  await createAdminSession({
    adminId: admin.id,
    tokenHash: hashSessionToken(token),
    ipHash: context.ipHash,
    userAgentHash: context.userAgentHash,
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
  });

  await writeAdminSessionToken(token);

  await AuditService.safeWrite({
    action: 'ADMIN_LOGIN_SUCCEEDED',
    actorType: 'ADMIN',
    actorLabel: admin.email,
    adminId: admin.id,
    ipHash: context.ipHash,
    userAgentHash: context.userAgentHash,
    summary: `"${admin.email}" signed in.`,
  });

  const { passwordHash: _passwordHash, ...safeAdmin } = admin;
  return safeAdmin;
}

export async function logout(context: RequestContext): Promise<void> {
  const token = await readAdminSessionToken();

  if (token) {
    const session = await findAdminSessionByTokenHash(hashSessionToken(token));
    await revokeAdminSession(hashSessionToken(token), new Date());

    if (session) {
      await AuditService.safeWrite({
        action: 'ADMIN_LOGGED_OUT',
        actorType: 'ADMIN',
        actorLabel: session.admin.email,
        adminId: session.adminId,
        ipHash: context.ipHash,
        summary: `"${session.admin.email}" signed out.`,
      });
    }
  }

  await clearAdminSessionToken();
}

/**
 * Resolve the current administrator from the session cookie.
 *
 * Returns null rather than throwing, so a signed-out visitor to an admin page
 * gets a redirect instead of an error. Every rejection reason - no cookie,
 * unknown token, revoked, expired, deactivated - collapses to the same null.
 */
export async function getCurrentAdmin(): Promise<AuthenticatedAdmin | null> {
  const token = await readAdminSessionToken();
  if (!token) return null;

  const session = await findAdminSessionByTokenHash(hashSessionToken(token));
  if (!session) return null;

  const now = new Date();
  if (session.revokedAt !== null) return null;
  if (session.expiresAt <= now) return null;
  if (!session.admin.isActive) return null;

  // Best-effort liveness stamp.
  void touchAdminSession(session.id, now).catch(() => undefined);

  return {
    admin: session.admin,
    sessionId: session.id,
    csrfToken: deriveCsrfToken(token),
  };
}

/** The CSRF token for the current admin session, if any. */
export async function getAdminCsrfToken(): Promise<string | null> {
  const token = await readAdminSessionToken();
  return token ? deriveCsrfToken(token) : null;
}

// --------------------------------------------------------------------------
// Account management
// --------------------------------------------------------------------------

export async function list(): Promise<AdminRow[]> {
  return listAdmins();
}

export async function getById(id: string): Promise<AdminRow | null> {
  return findAdminById(id);
}

export async function createAdmin(
  input: {
    email: string;
    displayName: string;
    password: string;
    role: AdminRole;
    mustChangePassword: boolean;
  },
  actor: { adminId: string; adminLabel: string; context: RequestContext },
): Promise<AdminRow> {
  try {
    const created = await createAdminRow({
      email: input.email,
      displayName: input.displayName,
      passwordHash: await hashPassword(input.password),
      role: input.role,
      mustChangePassword: input.mustChangePassword,
    });

    await AuditService.recordAdminAction({
      action: 'ADMIN_CREATED',
      summary: `Administrator "${created.email}" was created with the ${created.role} role.`,
      adminId: actor.adminId,
      adminLabel: actor.adminLabel,
      context: actor.context,
      metadata: { createdAdminId: created.id, role: created.role },
    });

    return created;
  } catch (error) {
    if (isUniqueViolationOn(error, 'email')) throw appError('EMAIL_IN_USE');
    throw error;
  }
}

/**
 * Update an administrator.
 *
 * Guards against the classic self-lockout: the last active super administrator
 * cannot be demoted or deactivated, because there would then be nobody able to
 * manage administrators at all.
 */
export async function updateAdmin(
  input: { adminId: string; displayName: string; role: AdminRole; isActive: boolean },
  actor: { adminId: string; adminLabel: string; context: RequestContext },
): Promise<AdminRow> {
  const target = await findAdminById(input.adminId);
  if (!target) throw appError('NOT_FOUND');

  const losingSuperAdmin =
    target.role === 'SUPER_ADMIN' && (input.role !== 'SUPER_ADMIN' || !input.isActive);

  if (losingSuperAdmin && (await countActiveSuperAdmins(target.id)) === 0) {
    throw appError('LAST_SUPER_ADMIN');
  }

  const updated = await updateAdminRow(input.adminId, {
    displayName: input.displayName,
    role: input.role,
    isActive: input.isActive,
  });

  // Deactivation must also end any session the account already holds.
  if (!input.isActive && target.isActive) {
    await revokeAllAdminSessions(input.adminId, new Date());
  }

  await AuditService.recordAdminAction({
    action: input.isActive ? 'ADMIN_UPDATED' : 'ADMIN_DEACTIVATED',
    summary: `Administrator "${updated.email}" was ${input.isActive ? 'updated' : 'deactivated'}.`,
    adminId: actor.adminId,
    adminLabel: actor.adminLabel,
    context: actor.context,
    metadata: { targetAdminId: updated.id, role: updated.role, isActive: updated.isActive },
  });

  return updated;
}

export async function changeOwnPassword(
  input: { adminId: string; currentPassword: string; newPassword: string },
  context: RequestContext,
): Promise<void> {
  const admin = await findAdminWithSecretById(input.adminId);
  if (!admin) throw appError('UNAUTHORIZED');

  if (!(await verifyPassword(input.currentPassword, admin.passwordHash))) {
    throw appError('INVALID_CREDENTIALS', {
      message: 'Your current password is not correct.',
      fieldErrors: { currentPassword: ['Your current password is not correct.'] },
    });
  }

  const now = new Date();
  await setAdminPassword(admin.id, await hashPassword(input.newPassword), now);

  // Every other session belonging to this account is now stale. Revoking them
  // all is the point of changing a password in the first place.
  await revokeAllAdminSessions(admin.id, now);
  await clearAdminSessionToken();

  await AuditService.recordAdminAction({
    action: 'ADMIN_PASSWORD_CHANGED',
    summary: `"${admin.email}" changed their password. All sessions were signed out.`,
    adminId: admin.id,
    adminLabel: admin.email,
    context,
  });
}

export async function resetPassword(
  input: { adminId: string; newPassword: string },
  actor: { adminId: string; adminLabel: string; context: RequestContext },
): Promise<void> {
  const target = await findAdminById(input.adminId);
  if (!target) throw appError('NOT_FOUND');

  const now = new Date();
  await setAdminPassword(target.id, await hashPassword(input.newPassword), now);
  await revokeAllAdminSessions(target.id, now);

  await AuditService.recordAdminAction({
    action: 'ADMIN_PASSWORD_CHANGED',
    summary: `The password for "${target.email}" was reset by an administrator.`,
    adminId: actor.adminId,
    adminLabel: actor.adminLabel,
    context: actor.context,
    metadata: { targetAdminId: target.id },
  });
}

// --------------------------------------------------------------------------
// Authorisation
// --------------------------------------------------------------------------

export function hasCapability(role: AdminRole, capability: Capability): boolean {
  return roleHasCapability(role, capability);
}
