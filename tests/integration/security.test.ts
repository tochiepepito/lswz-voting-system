import { beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '@/lib/errors';
import { prisma } from '@/lib/prisma';
import * as AdminService from '@/server/services/admin.service';
import * as EventService from '@/server/services/event.service';
import * as RateLimitService from '@/server/services/rate-limit.service';
import * as ResultsService from '@/server/services/results.service';
import * as VoterService from '@/server/services/voter.service';
import * as VotingService from '@/server/services/voting.service';
import { roleHasCapability } from '@/types/domain';
import { hasTestDatabase } from '../setup-integration';
import { testCookieStore } from '../helpers/next-headers-stub';
import {
  auditActions,
  countVotes,
  createAdmin,
  createEvent,
  requestContext,
  startFreshBrowser,
} from '../helpers/factories';

/** Security behaviour of the real services against a real database. */

async function expectCode(promise: Promise<unknown>, code: string): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error, `expected an AppError, got ${String(error)}`).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    return error as AppError;
  }

  throw new Error(`expected a rejection with code ${code}, but it resolved`);
}

describe.skipIf(!hasTestDatabase)('administrator authentication', () => {
  it('signs in with correct credentials and issues a hashed session', async () => {
    const admin = await createAdmin({ email: 'boss@test.local' });

    const result = await AdminService.login({
      email: 'boss@test.local',
      password: admin.password,
      context: requestContext(),
    });

    expect(result.email).toBe('boss@test.local');
    // The digest must never ride along on a returned admin object.
    expect(result).not.toHaveProperty('passwordHash');

    const session = await prisma.adminSession.findFirstOrThrow();
    expect(session.adminId).toBe(admin.id);

    // The cookie holds a raw token; the database holds only its HMAC.
    const cookie = testCookieStore.get('gev_admin');
    expect(cookie?.value).toBeTruthy();
    expect(session.tokenHash).not.toBe(cookie?.value);
    expect(session.tokenHash).toMatch(/^[0-9a-f]{64}$/);

    expect(await auditActions()).toContain('ADMIN_LOGIN_SUCCEEDED');
  });

  it('rejects a wrong password with an indistinguishable error', async () => {
    const admin = await createAdmin({ email: 'boss@test.local' });

    const wrongPassword = await expectCode(
      AdminService.login({
        email: 'boss@test.local',
        password: 'not the right password',
        context: requestContext(),
      }),
      'INVALID_CREDENTIALS',
    );

    const unknownEmail = await expectCode(
      AdminService.login({
        email: 'nobody@test.local',
        password: admin.password,
        context: requestContext(),
      }),
      'INVALID_CREDENTIALS',
    );

    // Identical message: the form is not an account-enumeration oracle.
    expect(wrongPassword.message).toBe(unknownEmail.message);
    expect(wrongPassword.status).toBe(unknownEmail.status);

    expect(await prisma.adminSession.count()).toBe(0);
    expect(await auditActions()).toContain('ADMIN_LOGIN_FAILED');
  });

  it('locks an account after repeated failures and keeps the lock after a correct password', async () => {
    const admin = await createAdmin({ email: 'target@test.local' });

    // The lockout threshold defaults to 8.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await expectCode(
        AdminService.login({
          email: 'target@test.local',
          password: `wrong-${attempt}`,
          context: requestContext(),
        }),
        'INVALID_CREDENTIALS',
      );
    }

    const locked = await prisma.admin.findUniqueOrThrow({
      where: { id: admin.id },
      select: { lockedUntil: true },
    });
    expect(locked.lockedUntil).not.toBeNull();
    expect(locked.lockedUntil!.getTime()).toBeGreaterThan(Date.now());

    // Even the correct password is refused while the lock stands.
    const error = await expectCode(
      AdminService.login({
        email: 'target@test.local',
        password: admin.password,
        context: requestContext(),
      }),
      'ACCOUNT_LOCKED',
    );
    expect(error.retryAfterSeconds).toBeGreaterThan(0);

    expect(await auditActions()).toContain('ADMIN_LOCKED_OUT');
  });

  it('refuses a deactivated account only after the password is proven', async () => {
    const admin = await createAdmin({ email: 'retired@test.local' });
    await prisma.admin.update({ where: { id: admin.id }, data: { isActive: false } });

    // Wrong password on a disabled account looks like any other bad credential.
    await expectCode(
      AdminService.login({
        email: 'retired@test.local',
        password: 'wrong',
        context: requestContext(),
      }),
      'INVALID_CREDENTIALS',
    );

    // Only a correct password reveals that the account is disabled.
    await expectCode(
      AdminService.login({
        email: 'retired@test.local',
        password: admin.password,
        context: requestContext(),
      }),
      'ACCOUNT_DISABLED',
    );
  });

  it('resolves no administrator from a forged or unknown cookie', async () => {
    await createAdmin();

    testCookieStore.set('gev_admin', 'a-token-that-was-never-issued');
    expect(await AdminService.getCurrentAdmin()).toBeNull();

    testCookieStore.reset();
    expect(await AdminService.getCurrentAdmin()).toBeNull();
  });

  it('stops accepting a session once it is revoked', async () => {
    const admin = await createAdmin({ email: 'boss@test.local' });

    await AdminService.login({
      email: 'boss@test.local',
      password: admin.password,
      context: requestContext(),
    });

    expect(await AdminService.getCurrentAdmin()).not.toBeNull();

    await prisma.adminSession.updateMany({ data: { revokedAt: new Date() } });
    expect(await AdminService.getCurrentAdmin()).toBeNull();
  });

  it('stops accepting a session once it expires', async () => {
    const admin = await createAdmin({ email: 'boss@test.local' });

    await AdminService.login({
      email: 'boss@test.local',
      password: admin.password,
      context: requestContext(),
    });

    await prisma.adminSession.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await AdminService.getCurrentAdmin()).toBeNull();
  });

  it('revokes every session when the password changes', async () => {
    const admin = await createAdmin({ email: 'boss@test.local' });

    await AdminService.login({
      email: 'boss@test.local',
      password: admin.password,
      context: requestContext(),
    });

    await AdminService.changeOwnPassword(
      {
        adminId: admin.id,
        currentPassword: admin.password,
        newPassword: 'a brand new long passphrase',
      },
      requestContext(),
    );

    // A password change that left old sessions alive would protect nothing.
    const live = await prisma.adminSession.count({ where: { revokedAt: null } });
    expect(live).toBe(0);
    expect(await AdminService.getCurrentAdmin()).toBeNull();

    // And the new password works.
    await expect(
      AdminService.login({
        email: 'boss@test.local',
        password: 'a brand new long passphrase',
        context: requestContext(),
      }),
    ).resolves.toMatchObject({ email: 'boss@test.local' });
  });

  it('rejects a password change with the wrong current password', async () => {
    const admin = await createAdmin();

    await expectCode(
      AdminService.changeOwnPassword(
        { adminId: admin.id, currentPassword: 'wrong', newPassword: 'another long passphrase' },
        requestContext(),
      ),
      'INVALID_CREDENTIALS',
    );
  });

  it('refuses to strip the last active super administrator', async () => {
    const admin = await createAdmin({ role: 'SUPER_ADMIN' });

    await expectCode(
      AdminService.updateAdmin(
        { adminId: admin.id, displayName: 'Test Admin', role: 'AUDITOR', isActive: true },
        { adminId: admin.id, adminLabel: admin.email, context: requestContext() },
      ),
      'LAST_SUPER_ADMIN',
    );

    await expectCode(
      AdminService.updateAdmin(
        { adminId: admin.id, displayName: 'Test Admin', role: 'SUPER_ADMIN', isActive: false },
        { adminId: admin.id, adminLabel: admin.email, context: requestContext() },
      ),
      'LAST_SUPER_ADMIN',
    );
  });

  it('signs out an administrator the moment they are deactivated', async () => {
    const keeper = await createAdmin({ role: 'SUPER_ADMIN' });
    const victim = await createAdmin({ email: 'victim@test.local', role: 'ADMIN' });

    await AdminService.login({
      email: 'victim@test.local',
      password: victim.password,
      context: requestContext(),
    });
    expect(await AdminService.getCurrentAdmin()).not.toBeNull();

    await AdminService.updateAdmin(
      { adminId: victim.id, displayName: 'Victim', role: 'ADMIN', isActive: false },
      { adminId: keeper.id, adminLabel: keeper.email, context: requestContext() },
    );

    expect(await AdminService.getCurrentAdmin()).toBeNull();
  });

  it('rejects an e-mail that is already taken', async () => {
    const keeper = await createAdmin({ role: 'SUPER_ADMIN' });

    await AdminService.createAdmin(
      {
        email: 'dup@test.local',
        displayName: 'First',
        password: 'a long enough passphrase',
        role: 'ADMIN',
        mustChangePassword: false,
      },
      { adminId: keeper.id, adminLabel: keeper.email, context: requestContext() },
    );

    await expectCode(
      AdminService.createAdmin(
        {
          email: 'dup@test.local',
          displayName: 'Second',
          password: 'another long passphrase',
          role: 'ADMIN',
          mustChangePassword: false,
        },
        { adminId: keeper.id, adminLabel: keeper.email, context: requestContext() },
      ),
      'EMAIL_IN_USE',
    );
  });
});

describe.skipIf(!hasTestDatabase)('role capabilities', () => {
  it('gives an auditor read access but no write access', () => {
    // The capability map is what every guard consults, so it is asserted
    // directly rather than through the UI.
    expect(roleHasCapability('AUDITOR', 'results:read')).toBe(true);
    expect(roleHasCapability('AUDITOR', 'audit:read')).toBe(true);

    expect(roleHasCapability('AUDITOR', 'event:write')).toBe(false);
    expect(roleHasCapability('AUDITOR', 'event:lifecycle')).toBe(false);
    expect(roleHasCapability('AUDITOR', 'vote:moderate')).toBe(false);
    expect(roleHasCapability('AUDITOR', 'admin:manage')).toBe(false);
  });

  it('withholds administrator management from a plain administrator', () => {
    expect(roleHasCapability('ADMIN', 'event:write')).toBe(true);
    expect(roleHasCapability('ADMIN', 'vote:moderate')).toBe(true);
    expect(roleHasCapability('ADMIN', 'admin:manage')).toBe(false);

    expect(roleHasCapability('SUPER_ADMIN', 'admin:manage')).toBe(true);
  });
});

describe.skipIf(!hasTestDatabase)('rate limiting', () => {
  it('allows requests up to the limit and refuses the rest', async () => {
    const limit = RateLimitService.RATE_LIMIT_RULES.VOTE_IP.limit;

    const decisions = [];
    for (let attempt = 0; attempt < limit + 3; attempt += 1) {
      decisions.push(await RateLimitService.consume('VOTE_IP', '203.0.113.55'));
    }

    expect(decisions.slice(0, limit).every((decision) => decision.allowed)).toBe(true);
    expect(decisions.slice(limit).every((decision) => !decision.allowed)).toBe(true);

    const refused = decisions[limit]!;
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('counts identifiers independently', async () => {
    await RateLimitService.consume('VOTE_IP', '203.0.113.1');
    await RateLimitService.consume('VOTE_IP', '203.0.113.2');

    expect(await prisma.rateLimitRecord.count({ where: { scope: 'VOTE_IP' } })).toBe(2);
  });

  it('counts scopes independently for the same identifier', async () => {
    await RateLimitService.consume('VOTE_IP', '203.0.113.1');
    await RateLimitService.consume('CLAIM_IP', '203.0.113.1');

    const records = await prisma.rateLimitRecord.findMany({ select: { scope: true } });
    expect(records.map((record) => record.scope).sort()).toEqual(['CLAIM_IP', 'VOTE_IP']);
  });

  it('skips the limit, rather than denying, when no identifier is available', async () => {
    // A deployment behind a misconfigured proxy has no client IP. Refusing every
    // such request would take the whole election offline.
    const decision = await RateLimitService.consume('VOTE_IP', null);

    expect(decision.allowed).toBe(true);
    expect(decision.skipped).toBe(true);
    expect(await prisma.rateLimitRecord.count()).toBe(0);
  });

  it('throws and audits when enforce() exceeds the limit', async () => {
    const limit = RateLimitService.RATE_LIMIT_RULES.CLAIM_IP.limit;

    for (let attempt = 0; attempt < limit; attempt += 1) {
      await RateLimitService.enforce('CLAIM_IP', '203.0.113.77', { summary: 'test' });
    }

    const error = await expectCode(
      RateLimitService.enforce('CLAIM_IP', '203.0.113.77', { summary: 'burst detected' }),
      'RATE_LIMITED',
    );

    expect(error.retryAfterSeconds).toBeGreaterThan(0);
    expect(error.message).toBe('Too many voting attempts. Please try again later.');

    expect(await auditActions()).toContain('RATE_LIMIT_TRIGGERED');

    // The refusal is recorded for the security dashboard.
    const record = await prisma.rateLimitRecord.findFirstOrThrow({ where: { scope: 'CLAIM_IP' } });
    expect(record.blockedCount).toBeGreaterThan(0);
  });

  it('never stores a raw identifier', async () => {
    await RateLimitService.consume('VOTE_IP', '203.0.113.123');

    const record = await prisma.rateLimitRecord.findFirstOrThrow();

    expect(record.identifierHash).not.toContain('203.0.113.123');
    expect(record.bucketKey).not.toContain('203.0.113.123');
    expect(record.identifierHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe.skipIf(!hasTestDatabase)('results visibility is server-enforced', () => {
  let adminId: string;

  beforeEach(async () => {
    const admin = await createAdmin();
    adminId = admin.id;
  });

  it('refuses a hidden tally to the public even after voting closes', async () => {
    const event = await createEvent({
      adminId,
      resultsVisibility: 'HIDDEN',
      status: 'CLOSED',
      endsAt: new Date(Date.now() - 1000),
    });

    await expectCode(ResultsService.getPublicResults(event, true), 'RESULTS_NOT_AVAILABLE');

    // An administrator can always see it.
    await expect(ResultsService.getAdminResults(event)).resolves.toMatchObject({ totalBallots: 0 });
  });

  it('withholds an AFTER_VOTING tally until this voter has actually voted', async () => {
    const event = await createEvent({ adminId, resultsVisibility: 'AFTER_VOTING' });

    // `hasVoted` is resolved by the caller from the session, never from input.
    await expectCode(ResultsService.getPublicResults(event, false), 'RESULTS_NOT_AVAILABLE');
    await expect(ResultsService.getPublicResults(event, true)).resolves.toBeTruthy();
  });

  it('withholds an AFTER_CLOSE tally while voting is open', async () => {
    const open = await createEvent({ adminId, resultsVisibility: 'AFTER_CLOSE' });
    await expectCode(ResultsService.getPublicResults(open, true), 'RESULTS_NOT_AVAILABLE');

    const closed = { ...open, status: 'CLOSED' as const, endsAt: new Date(Date.now() - 1000) };
    await expect(ResultsService.getPublicResults(closed, false)).resolves.toBeTruthy();
  });

  it('counts percentages against ballots, not selections', async () => {
    const event = await createEvent({
      adminId,
      votingType: 'MULTIPLE_CHOICE',
      minSelections: 1,
      maxSelections: 3,
      maxVotesPerSession: 10,
      optionNames: ['Rule A', 'Rule B', 'Rule C'],
      resultsVisibility: 'WHILE_VOTING',
    });

    // Two ballots, each picking two options: 4 selections, 2 ballots.
    for (const name of ['PlayerOne', 'PlayerTwo']) {
      startFreshBrowser();
      await VoterService.claimIdentity({ event, rawIgn: name, context: requestContext() });
      await VotingService.submitVote({
        event,
        optionIds: [event.options[0]!.id, event.options[1]!.id],
        context: requestContext(),
      });
    }

    const results = await ResultsService.getPublicResults(event, true);

    expect(results.totalBallots).toBe(2);
    expect(results.totalSelections).toBe(4);

    // Both voters picked Rule A, so it is 100% of ballots - not 50% of selections.
    const ruleA = results.options.find((option) => option.name === 'Rule A');
    expect(ruleA?.votes).toBe(2);
    expect(ruleA?.percent).toBeCloseTo(100, 5);
  });

  it('excludes an invalidated ballot from the tally', async () => {
    const event = await createEvent({ adminId, resultsVisibility: 'WHILE_VOTING' });

    await VoterService.claimIdentity({ event, rawIgn: 'PlayerOne', context: requestContext() });
    await VotingService.submitVote({
      event,
      optionIds: [event.options[0]!.id],
      context: requestContext(),
    });

    let results = await ResultsService.getPublicResults(event, true);
    expect(results.totalBallots).toBe(1);

    const vote = await prisma.vote.findFirstOrThrow();
    await VotingService.invalidate({
      voteId: vote.id,
      adminId,
      adminLabel: 'admin@test.local',
      reason: 'Duplicate',
      context: requestContext(),
    });

    // Tallies are always derived, never a stored counter, so this is immediate.
    results = await ResultsService.getPublicResults(event, true);
    expect(results.totalBallots).toBe(0);
    expect(results.options.every((option) => option.votes === 0)).toBe(true);
  });
});

describe.skipIf(!hasTestDatabase)('hostile input against live queries', () => {
  let adminId: string;

  beforeEach(async () => {
    const admin = await createAdmin();
    adminId = admin.id;
  });

  it('treats injection payloads in a search box as literal text', async () => {
    await createEvent({ adminId, slug: 'safe-event' });

    for (const payload of [
      "'; DROP TABLE voting_events; --",
      "' OR 1=1 --",
      "%' OR slug LIKE '%",
      '\\',
    ]) {
      // Prisma parameterises every query, so this is a search for a literal
      // string that happens to contain punctuation.
      const result = await EventService.listForAdmin(
        { search: payload },
        { page: 1, pageSize: 10 },
      );

      expect(result.items).toHaveLength(0);
    }

    // The table is still there, with its row.
    expect(await prisma.votingEvent.count()).toBe(1);
  });

  it('stores an XSS payload in an admin-entered field verbatim, without executing anything', async () => {
    // Storage is not the defence - React escaping is. What matters here is that
    // the value round-trips unchanged rather than being silently mangled, and
    // that it is never interpreted on the way in.
    const payload = '<script>alert("xss")</script>';

    const event = await EventService.createEvent(
      {
        title: payload,
        slug: null,
        description: payload,
        instructions: null,
        votingType: 'SINGLE_CHOICE',
        minSelections: 1,
        maxSelections: 1,
        startsAt: null,
        endsAt: null,
        resultsVisibility: 'AFTER_CLOSE',
        maxVotesPerSession: 1,
        ipSoftLimit: 8,
        requireCaptcha: false,
        options: [
          { name: 'A', description: null, imageUrl: null, displayOrder: 0, isActive: true },
          { name: 'B', description: null, imageUrl: null, displayOrder: 1, isActive: true },
        ],
      },
      { adminId, adminLabel: 'admin@test.local', context: requestContext() },
    );

    expect(event.title).toBe(payload);
    // The slug derived from it is inert.
    expect(event.slug).toMatch(/^[a-z0-9-]+$/);
    expect(event.slug).not.toContain('<');
  });

  it('rejects an IGN containing markup before it reaches the database', async () => {
    const event = await createEvent({ adminId });

    await expectCode(
      VoterService.claimIdentity({
        event,
        rawIgn: '<img src=x onerror=alert(1)>',
        context: requestContext(),
      }),
      'IGN_INVALID',
    );

    expect(await prisma.voter.count()).toBe(0);
  });

  it('keeps an event in DRAFT invisible to the public', async () => {
    const draft = await createEvent({ adminId, status: 'DRAFT', slug: 'secret-draft' });
    await prisma.votingEvent.update({ where: { id: draft.id }, data: { publishedAt: null } });

    expect(await EventService.getPublicEventBySlug('secret-draft')).toBeNull();
    expect(await EventService.listPublicEvents()).toHaveLength(0);

    // And an administrator can still see it.
    expect(await EventService.getEventForAdmin(draft.id)).not.toBeNull();
  });

  it('refuses to open an event with fewer than two active options', async () => {
    const event = await createEvent({ adminId, status: 'DRAFT', optionNames: ['Only One'] });

    await expectCode(
      EventService.applyLifecycleAction(event.id, 'open', {
        adminId,
        adminLabel: 'admin@test.local',
        context: requestContext(),
      }),
      'CONFLICT',
    );
  });

  it('locks the ballot rules once a vote exists', async () => {
    const event = await createEvent({ adminId });

    await VoterService.claimIdentity({ event, rawIgn: 'PlayerOne', context: requestContext() });
    await VotingService.submitVote({
      event,
      optionIds: [event.options[0]!.id],
      context: requestContext(),
    });

    // Widening a single-choice election after voting started would retroactively
    // change the rules the existing ballot was cast under.
    await expectCode(
      EventService.updateEvent(
        {
          id: event.id,
          title: event.title,
          slug: event.slug,
          description: event.description,
          instructions: null,
          votingType: 'MULTIPLE_CHOICE',
          minSelections: 1,
          maxSelections: 3,
          startsAt: event.startsAt,
          endsAt: event.endsAt,
          resultsVisibility: event.resultsVisibility,
          maxVotesPerSession: event.maxVotesPerSession,
          ipSoftLimit: event.ipSoftLimit,
          requireCaptcha: false,
        },
        { adminId, adminLabel: 'admin@test.local', context: requestContext() },
      ),
      'EVENT_NOT_EDITABLE',
    );

    // But the title and description stay editable, so typos can still be fixed.
    await expect(
      EventService.updateEvent(
        {
          id: event.id,
          title: 'A corrected title',
          slug: event.slug,
          description: event.description,
          instructions: null,
          votingType: event.votingType,
          minSelections: event.minSelections,
          maxSelections: event.maxSelections,
          startsAt: event.startsAt,
          endsAt: event.endsAt,
          resultsVisibility: event.resultsVisibility,
          maxVotesPerSession: event.maxVotesPerSession,
          ipSoftLimit: event.ipSoftLimit,
          requireCaptcha: false,
        },
        { adminId, adminLabel: 'admin@test.local', context: requestContext() },
      ),
    ).resolves.toMatchObject({ title: 'A corrected title' });
  });

  it('refuses to delete an option that already has votes', async () => {
    const event = await createEvent({ adminId });
    const option = event.options[0]!;

    await VoterService.claimIdentity({ event, rawIgn: 'PlayerOne', context: requestContext() });
    await VotingService.submitVote({ event, optionIds: [option.id], context: requestContext() });

    await expectCode(
      EventService.removeOption(event.id, option.id, {
        adminId,
        adminLabel: 'admin@test.local',
        context: requestContext(),
      }),
      'CONFLICT',
    );

    // The ballot still resolves to a named option.
    expect(await countVotes(event.id)).toBe(1);
  });

  it('never writes a raw IP address into any table', async () => {
    const event = await createEvent({ adminId });

    await VoterService.claimIdentity({
      event,
      rawIgn: 'PlayerOne',
      context: { ...requestContext('198.51.100.200'), ipHash: 'hashed-198-51-100-200' },
    });
    await VotingService.submitVote({
      event,
      optionIds: [event.options[0]!.id],
      context: { ...requestContext('198.51.100.200'), ipHash: 'hashed-198-51-100-200' },
    });

    const dump = JSON.stringify([
      await prisma.vote.findMany(),
      await prisma.voterSession.findMany(),
      await prisma.auditLog.findMany(),
    ]);

    expect(dump).not.toContain('198.51.100.200');
  });
});
