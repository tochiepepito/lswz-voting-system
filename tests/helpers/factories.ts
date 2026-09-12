import { hashPassword } from '@/lib/crypto';
import { prisma } from '@/lib/prisma';
import type { RequestContext } from '@/lib/http';
import type { EventStatus, ResultsVisibility, VotingType } from '@/types/domain';
import { testCookieStore } from './next-headers-stub';

/** Fixture builders for the integration suite. */

const DAY = 24 * 60 * 60 * 1000;

export async function createAdmin(
  overrides: { email?: string; password?: string; role?: 'SUPER_ADMIN' | 'ADMIN' | 'AUDITOR' } = {},
) {
  const email = overrides.email ?? `admin-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;
  const password = overrides.password ?? 'integration-test-password';

  const admin = await prisma.admin.create({
    data: {
      email,
      displayName: 'Test Admin',
      passwordHash: await hashPassword(password),
      role: overrides.role ?? 'SUPER_ADMIN',
    },
    select: { id: true, email: true, role: true },
  });

  return { ...admin, password };
}

export type EventFixtureOptions = {
  adminId: string;
  votingType?: VotingType;
  status?: EventStatus;
  startsAt?: Date | null;
  endsAt?: Date | null;
  minSelections?: number;
  maxSelections?: number;
  maxVotesPerSession?: number;
  ipSoftLimit?: number;
  resultsVisibility?: ResultsVisibility;
  optionNames?: string[];
  slug?: string;
};

/** An event that is open for voting right now, unless told otherwise. */
export async function createEvent(options: EventFixtureOptions) {
  const slug = options.slug ?? `event-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const names = options.optionNames ?? ['PlayerOne', 'PlayerTwo', 'PlayerThree'];

  return prisma.votingEvent.create({
    data: {
      slug,
      title: `Test Event ${slug}`,
      description: 'An event created by the integration suite.',
      votingType: options.votingType ?? 'SINGLE_CHOICE',
      status: options.status ?? 'ACTIVE',
      minSelections: options.minSelections ?? 1,
      maxSelections: options.maxSelections ?? 1,
      startsAt: options.startsAt === undefined ? new Date(Date.now() - DAY) : options.startsAt,
      endsAt: options.endsAt === undefined ? new Date(Date.now() + DAY) : options.endsAt,
      resultsVisibility: options.resultsVisibility ?? 'AFTER_CLOSE',
      maxVotesPerSession: options.maxVotesPerSession ?? 1,
      ipSoftLimit: options.ipSoftLimit ?? 8,
      publishedAt: new Date(Date.now() - DAY),
      openedAt: new Date(Date.now() - DAY),
      createdById: options.adminId,
      options: {
        create: names.map((name, index) => ({ name, displayOrder: index, isActive: true })),
      },
    },
    include: { options: { orderBy: { displayOrder: 'asc' } } },
  });
}

/** A request context with a stable, fake client address. */
export function requestContext(ip = '203.0.113.10'): RequestContext {
  return {
    ip,
    ipHash: ip ? `hash-of-${ip}` : null,
    userAgent: 'IntegrationTest/1.0',
    userAgentHash: 'hash-of-ua',
  };
}

/**
 * Simulate switching to a different browser.
 *
 * Clearing the cookie jar is exactly what a new device looks like to the server:
 * no session token, so a brand-new VoterSession is created on the next claim.
 */
export function startFreshBrowser(): void {
  testCookieStore.reset();
}

/** Capture the current browser so a test can return to it later. */
export function captureBrowser(): Map<string, string> {
  return testCookieStore.snapshot();
}

export function restoreBrowser(snapshot: Map<string, string>): void {
  testCookieStore.restore(snapshot);
}

/** Read an audit log for assertions. */
export async function auditActions(eventId?: string): Promise<string[]> {
  const rows = await prisma.auditLog.findMany({
    where: eventId ? { eventId } : {},
    select: { action: true },
    orderBy: { createdAt: 'asc' },
  });

  return rows.map((row) => row.action);
}

export async function countVotes(eventId: string): Promise<number> {
  return prisma.vote.count({ where: { eventId, status: 'VALID' } });
}
