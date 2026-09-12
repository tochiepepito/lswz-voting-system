import type { Prisma } from '@prisma/client';
import { prisma, type DbClient } from '@/lib/prisma';
import type { AuditAction, AuditActorType, AuditSeverity } from '@/types/domain';

/** Data access for the audit trail. */

export const auditSelect = {
  id: true,
  action: true,
  severity: true,
  actorType: true,
  actorLabel: true,
  adminId: true,
  eventId: true,
  voterId: true,
  voterSessionId: true,
  ipHash: true,
  summary: true,
  metadata: true,
  createdAt: true,
} satisfies Prisma.AuditLogSelect;

export type AuditRow = Prisma.AuditLogGetPayload<{ select: typeof auditSelect }>;

export type AuditEntry = {
  action: AuditAction;
  severity: AuditSeverity;
  actorType: AuditActorType;
  actorLabel?: string | null;
  adminId?: string | null;
  eventId?: string | null;
  voterId?: string | null;
  voterSessionId?: string | null;
  ipHash?: string | null;
  userAgentHash?: string | null;
  summary: string;
  metadata?: Prisma.InputJsonValue;
};

export async function appendAudit(entry: AuditEntry, db: DbClient = prisma): Promise<void> {
  await db.auditLog.create({
    data: {
      action: entry.action,
      severity: entry.severity,
      actorType: entry.actorType,
      actorLabel: entry.actorLabel ?? null,
      adminId: entry.adminId ?? null,
      eventId: entry.eventId ?? null,
      voterId: entry.voterId ?? null,
      voterSessionId: entry.voterSessionId ?? null,
      ipHash: entry.ipHash ?? null,
      userAgentHash: entry.userAgentHash ?? null,
      summary: entry.summary,
      ...(entry.metadata === undefined ? {} : { metadata: entry.metadata }),
    },
  });
}

export type AuditFilters = {
  eventId?: string;
  actions?: AuditAction[];
  severity?: AuditSeverity;
  voterId?: string;
  since?: Date;
};

function buildWhere(filters: AuditFilters): Prisma.AuditLogWhereInput {
  return {
    ...(filters.eventId ? { eventId: filters.eventId } : {}),
    ...(filters.actions && filters.actions.length > 0 ? { action: { in: filters.actions } } : {}),
    ...(filters.severity ? { severity: filters.severity } : {}),
    ...(filters.voterId ? { voterId: filters.voterId } : {}),
    ...(filters.since ? { createdAt: { gte: filters.since } } : {}),
  };
}

export async function listAudit(
  filters: AuditFilters,
  pagination: { page: number; pageSize: number },
  db: DbClient = prisma,
): Promise<{ items: AuditRow[]; total: number }> {
  const where = buildWhere(filters);

  const [items, total] = await Promise.all([
    db.auditLog.findMany({
      where,
      select: auditSelect,
      orderBy: { createdAt: 'desc' },
      skip: (pagination.page - 1) * pagination.pageSize,
      take: pagination.pageSize,
    }),
    db.auditLog.count({ where }),
  ]);

  return { items, total };
}

export async function countAuditByAction(
  filters: AuditFilters,
  db: DbClient = prisma,
): Promise<Array<{ action: AuditAction; count: number }>> {
  const rows = await db.auditLog.groupBy({
    by: ['action'],
    where: buildWhere(filters),
    _count: { _all: true },
  });

  return rows
    .map((row) => ({ action: row.action as AuditAction, count: row._count._all }))
    .sort((a, b) => b.count - a.count);
}

/** Counts for the security dashboard tiles. */
export async function countAuditActions(
  actions: AuditAction[],
  since: Date,
  eventId?: string,
  db: DbClient = prisma,
): Promise<number> {
  return db.auditLog.count({
    where: {
      action: { in: actions },
      createdAt: { gte: since },
      ...(eventId ? { eventId } : {}),
    },
  });
}
