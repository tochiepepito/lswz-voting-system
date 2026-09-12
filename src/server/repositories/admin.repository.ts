import type { Prisma } from '@prisma/client';
import { prisma, type DbClient } from '@/lib/prisma';
import type { AdminRole } from '@/types/domain';

/**
 * Data access for administrator accounts and their sessions.
 *
 * `passwordHash` is deliberately absent from the default select shape and only
 * reachable through `findAdminWithSecretByEmail`. That makes it a visible,
 * greppable decision every time the digest is loaded, instead of something that
 * quietly rides along in every admin query and ends up serialised into a page.
 */

export const adminSelect = {
  id: true,
  email: true,
  displayName: true,
  role: true,
  isActive: true,
  mustChangePassword: true,
  lastLoginAt: true,
  lockedUntil: true,
  failedLoginCount: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.AdminSelect;

export type AdminRow = Prisma.AdminGetPayload<{ select: typeof adminSelect }>;

/** Admin row *including* the password digest. Authentication path only. */
export type AdminWithSecret = AdminRow & { passwordHash: string };

export async function findAdminWithSecretByEmail(
  email: string,
  db: DbClient = prisma,
): Promise<AdminWithSecret | null> {
  return db.admin.findUnique({
    where: { email },
    select: { ...adminSelect, passwordHash: true },
  });
}

export async function findAdminWithSecretById(
  id: string,
  db: DbClient = prisma,
): Promise<AdminWithSecret | null> {
  return db.admin.findUnique({ where: { id }, select: { ...adminSelect, passwordHash: true } });
}

export async function findAdminById(id: string, db: DbClient = prisma): Promise<AdminRow | null> {
  return db.admin.findUnique({ where: { id }, select: adminSelect });
}

export async function listAdmins(db: DbClient = prisma): Promise<AdminRow[]> {
  return db.admin.findMany({ select: adminSelect, orderBy: [{ isActive: 'desc' }, { email: 'asc' }] });
}

export async function createAdmin(
  data: {
    email: string;
    displayName: string;
    passwordHash: string;
    role: AdminRole;
    mustChangePassword: boolean;
  },
  db: DbClient = prisma,
): Promise<AdminRow> {
  return db.admin.create({ data, select: adminSelect });
}

export async function updateAdmin(
  id: string,
  data: { displayName?: string; role?: AdminRole; isActive?: boolean },
  db: DbClient = prisma,
): Promise<AdminRow> {
  return db.admin.update({ where: { id }, data, select: adminSelect });
}

export async function setAdminPassword(
  id: string,
  passwordHash: string,
  now: Date,
  db: DbClient = prisma,
): Promise<void> {
  await db.admin.update({
    where: { id },
    data: {
      passwordHash,
      passwordChangedAt: now,
      mustChangePassword: false,
      failedLoginCount: 0,
      lockedUntil: null,
    },
  });
}

/**
 * Count of accounts that can still manage administrators.
 * Guards the "do not lock yourself out" rule when demoting or deactivating.
 */
export async function countActiveSuperAdmins(
  excludeId?: string,
  db: DbClient = prisma,
): Promise<number> {
  return db.admin.count({
    where: {
      role: 'SUPER_ADMIN',
      isActive: true,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
  });
}

export async function recordLoginSuccess(
  id: string,
  now: Date,
  db: DbClient = prisma,
): Promise<void> {
  await db.admin.update({
    where: { id },
    data: { lastLoginAt: now, failedLoginCount: 0, lockedUntil: null },
  });
}

/**
 * Increment the failure counter, locking the account once the threshold is hit.
 *
 * Returns the new counter and the lock expiry so the service can audit the
 * transition from "failed" to "locked" exactly once.
 */
export async function recordLoginFailure(
  id: string,
  threshold: number,
  lockoutMinutes: number,
  now: Date,
  db: DbClient = prisma,
): Promise<{ failedLoginCount: number; lockedUntil: Date | null }> {
  const updated = await db.admin.update({
    where: { id },
    data: { failedLoginCount: { increment: 1 } },
    select: { failedLoginCount: true, lockedUntil: true },
  });

  if (updated.failedLoginCount < threshold) return updated;

  const lockedUntil = new Date(now.getTime() + lockoutMinutes * 60_000);

  await db.admin.update({
    where: { id },
    data: { lockedUntil, failedLoginCount: 0 },
  });

  return { failedLoginCount: updated.failedLoginCount, lockedUntil };
}

// --------------------------------------------------------------------------
// Admin sessions
// --------------------------------------------------------------------------

export type AdminSessionWithAdmin = {
  id: string;
  adminId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
  admin: AdminRow;
};

export async function createAdminSession(
  data: {
    adminId: string;
    tokenHash: string;
    ipHash: string | null;
    userAgentHash: string | null;
    expiresAt: Date;
  },
  db: DbClient = prisma,
): Promise<{ id: string }> {
  return db.adminSession.create({ data, select: { id: true } });
}

export async function findAdminSessionByTokenHash(
  tokenHash: string,
  db: DbClient = prisma,
): Promise<AdminSessionWithAdmin | null> {
  return db.adminSession.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      adminId: true,
      expiresAt: true,
      revokedAt: true,
      createdAt: true,
      admin: { select: adminSelect },
    },
  });
}

export async function touchAdminSession(
  id: string,
  now: Date,
  db: DbClient = prisma,
): Promise<void> {
  await db.adminSession.update({ where: { id }, data: { lastSeenAt: now } });
}

export async function revokeAdminSession(
  tokenHash: string,
  now: Date,
  db: DbClient = prisma,
): Promise<void> {
  await db.adminSession.updateMany({
    where: { tokenHash, revokedAt: null },
    data: { revokedAt: now },
  });
}

/**
 * Revoke every session belonging to an admin.
 *
 * Called on password change and on deactivation: without it, a compromised
 * session survives the very action taken to shut it down.
 */
export async function revokeAllAdminSessions(
  adminId: string,
  now: Date,
  db: DbClient = prisma,
): Promise<number> {
  const result = await db.adminSession.updateMany({
    where: { adminId, revokedAt: null },
    data: { revokedAt: now },
  });

  return result.count;
}

export async function deleteExpiredAdminSessions(
  now: Date,
  db: DbClient = prisma,
): Promise<number> {
  const result = await db.adminSession.deleteMany({ where: { expiresAt: { lt: now } } });
  return result.count;
}
