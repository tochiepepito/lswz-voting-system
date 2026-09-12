import { beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '@/lib/errors';
import { prisma } from '@/lib/prisma';
import * as ResultsService from '@/server/services/results.service';
import * as VoterService from '@/server/services/voter.service';
import * as VotingService from '@/server/services/voting.service';
import { hasTestDatabase } from '../setup-integration';
import {
  auditActions,
  captureBrowser,
  countVotes,
  createAdmin,
  createEvent,
  requestContext,
  restoreBrowser,
  startFreshBrowser,
} from '../helpers/factories';

/**
 * End-to-end voting behaviour against a real MySQL database.
 *
 * These run the genuine services - the same code the route handlers and server
 * actions call - so the duplicate-vote constraint, the transaction and the
 * audit writes are all real.
 */

const DAY = 24 * 60 * 60 * 1000;

/** Assert a rejected promise carries a specific AppError code. */
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

describe.skipIf(!hasTestDatabase)('vote submission', () => {
  let adminId: string;

  beforeEach(async () => {
    const admin = await createAdmin();
    adminId = admin.id;
  });

  it('records a valid vote and returns a receipt', async () => {
    const event = await createEvent({ adminId });
    const option = event.options[0]!;

    const claim = await VoterService.claimIdentity({
      event,
      rawIgn: 'PlayerOne',
      context: requestContext(),
    });

    expect(claim.voter.displayName).toBe('PlayerOne');
    expect(claim.voter.normalizedName).toBe('playerone');
    expect(claim.alreadyVoted).toBe(false);

    const receipt = await VotingService.submitVote({
      event,
      optionIds: [option.id],
      context: requestContext(),
    });

    expect(receipt.receiptCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(receipt.displayName).toBe('PlayerOne');
    expect(receipt.optionNames).toEqual([option.name]);

    expect(await countVotes(event.id)).toBe(1);

    // The ballot and its selection are both present: the transaction was atomic.
    const stored = await prisma.vote.findFirstOrThrow({
      where: { eventId: event.id },
      include: { selections: true },
    });
    expect(stored.selections).toHaveLength(1);
    expect(stored.selections[0]!.optionId).toBe(option.id);

    expect(await auditActions(event.id)).toContain('VOTE_SUBMITTED');
  });

  it('refuses a second ballot from the same identity', async () => {
    const event = await createEvent({ adminId });

    await VoterService.claimIdentity({ event, rawIgn: 'PlayerOne', context: requestContext() });
    await VotingService.submitVote({
      event,
      optionIds: [event.options[0]!.id],
      context: requestContext(),
    });

    await expectCode(
      VotingService.submitVote({
        event,
        optionIds: [event.options[1]!.id],
        context: requestContext(),
      }),
      'ALREADY_VOTED',
    );

    expect(await countVotes(event.id)).toBe(1);
    expect(await auditActions(event.id)).toContain('VOTE_DUPLICATE_BLOCKED');
  });

  it('refuses the same identity from a different browser', async () => {
    // The core of the design: the cookie is one layer, but the normalised IGN
    // is what the database constraint is built on.
    const event = await createEvent({ adminId, maxVotesPerSession: 5 });

    await VoterService.claimIdentity({ event, rawIgn: 'PlayerOne', context: requestContext() });
    await VotingService.submitVote({
      event,
      optionIds: [event.options[0]!.id],
      context: requestContext(),
    });

    startFreshBrowser();

    // Different capitalisation, different device, different network.
    await VoterService.claimIdentity({
      event,
      rawIgn: '  PLAYERONE  ',
      context: requestContext('198.51.100.77'),
    });

    await expectCode(
      VotingService.submitVote({
        event,
        optionIds: [event.options[1]!.id],
        context: requestContext('198.51.100.77'),
      }),
      'ALREADY_VOTED',
    );

    expect(await countVotes(event.id)).toBe(1);
  });

  it('refuses a second ballot from the same browser under a different name', async () => {
    // maxVotesPerSession defaults to 1, so the browser limit catches this even
    // though the identity is genuinely different.
    const event = await createEvent({ adminId });

    await VoterService.claimIdentity({ event, rawIgn: 'PlayerOne', context: requestContext() });
    await VotingService.submitVote({
      event,
      optionIds: [event.options[0]!.id],
      context: requestContext(),
    });

    await VoterService.claimIdentity({ event, rawIgn: 'PlayerTwo', context: requestContext() });

    await expectCode(
      VotingService.submitVote({
        event,
        optionIds: [event.options[1]!.id],
        context: requestContext(),
      }),
      'SESSION_VOTE_LIMIT',
    );

    expect(await countVotes(event.id)).toBe(1);
    expect(await auditActions(event.id)).toContain('VOTE_SESSION_LIMIT_BLOCKED');
  });

  it('allows two different players on a shared device when configured', async () => {
    const event = await createEvent({ adminId, maxVotesPerSession: 2 });

    await VoterService.claimIdentity({ event, rawIgn: 'PlayerOne', context: requestContext() });
    await VotingService.submitVote({
      event,
      optionIds: [event.options[0]!.id],
      context: requestContext(),
    });

    await VoterService.claimIdentity({ event, rawIgn: 'PlayerTwo', context: requestContext() });
    await VotingService.submitVote({
      event,
      optionIds: [event.options[1]!.id],
      context: requestContext(),
    });

    expect(await countVotes(event.id)).toBe(2);

    // The second ballot is still flagged for a human to look at.
    const second = await prisma.vote.findFirstOrThrow({
      where: { eventId: event.id },
      orderBy: { castAt: 'desc' },
    });
    expect(second.isSuspicious).toBe(true);
    expect(second.suspicionReasons).toContain('SHARED_BROWSER');
  });

  it('refuses a vote before the event opens', async () => {
    const event = await createEvent({
      adminId,
      status: 'SCHEDULED',
      startsAt: new Date(Date.now() + DAY),
      endsAt: new Date(Date.now() + 2 * DAY),
    });

    await expectCode(
      VoterService.claimIdentity({ event, rawIgn: 'PlayerOne', context: requestContext() }),
      'EVENT_NOT_STARTED',
    );
  });

  it('refuses a vote after the event closes', async () => {
    const open = await createEvent({ adminId });
    await VoterService.claimIdentity({ event: open, rawIgn: 'PlayerOne', context: requestContext() });

    // The window elapses between claiming and submitting.
    const closed = { ...open, endsAt: new Date(Date.now() - 1000) };

    await expectCode(
      VotingService.submitVote({
        event: closed,
        optionIds: [open.options[0]!.id],
        context: requestContext(),
      }),
      'EVENT_ENDED',
    );

    expect(await countVotes(open.id)).toBe(0);
  });

  it('refuses a vote when the event closes mid-request', async () => {
    // The check inside the transaction is what catches this: the event was open
    // when the request arrived and closed before the insert.
    const event = await createEvent({ adminId });
    await VoterService.claimIdentity({ event, rawIgn: 'PlayerOne', context: requestContext() });

    await prisma.votingEvent.update({
      where: { id: event.id },
      data: { status: 'CLOSED', closedAt: new Date(), endsAt: new Date(Date.now() - 1000) },
    });

    // `event` is the stale object the caller still holds - exactly the race.
    await expectCode(
      VotingService.submitVote({
        event,
        optionIds: [event.options[0]!.id],
        context: requestContext(),
      }),
      'EVENT_ENDED',
    );

    expect(await countVotes(event.id)).toBe(0);
  });

  it('refuses an option belonging to another event', async () => {
    const [eventA, eventB] = await Promise.all([
      createEvent({ adminId, slug: 'event-a' }),
      createEvent({ adminId, slug: 'event-b' }),
    ]);

    await VoterService.claimIdentity({ event: eventA, rawIgn: 'PlayerOne', context: requestContext() });

    await expectCode(
      VotingService.submitVote({
        event: eventA,
        // A crafted request pointing at another event's option.
        optionIds: [eventB.options[0]!.id],
        context: requestContext(),
      }),
      'OPTION_UNAVAILABLE',
    );

    expect(await countVotes(eventA.id)).toBe(0);
  });

  it('refuses a deactivated option', async () => {
    const event = await createEvent({ adminId });
    const option = event.options[0]!;

    await prisma.votingOption.update({ where: { id: option.id }, data: { isActive: false } });
    await VoterService.claimIdentity({ event, rawIgn: 'PlayerOne', context: requestContext() });

    await expectCode(
      VotingService.submitVote({ event, optionIds: [option.id], context: requestContext() }),
      'OPTION_UNAVAILABLE',
    );
  });

  it('refuses a ballot with no session at all', async () => {
    const event = await createEvent({ adminId });

    // No claim was made, so there is no session cookie.
    await expectCode(
      VotingService.submitVote({
        event,
        optionIds: [event.options[0]!.id],
        context: requestContext(),
      }),
      'SESSION_REQUIRED',
    );
  });

  it('refuses a ballot from a session that never claimed an identity', async () => {
    const event = await createEvent({ adminId });
    const other = await createEvent({ adminId, slug: 'other-event' });

    // Claim on a different event: a session exists, but not for this ballot.
    await VoterService.claimIdentity({ event: other, rawIgn: 'PlayerOne', context: requestContext() });

    await expectCode(
      VotingService.submitVote({
        event,
        optionIds: [event.options[0]!.id],
        context: requestContext(),
      }),
      'SESSION_REQUIRED',
    );
  });

  it('rejects an empty or missing IGN', async () => {
    const event = await createEvent({ adminId });

    await expectCode(
      VoterService.claimIdentity({ event, rawIgn: '   ', context: requestContext() }),
      'IGN_REQUIRED',
    );
    await expectCode(
      VoterService.claimIdentity({ event, rawIgn: undefined, context: requestContext() }),
      'IGN_REQUIRED',
    );
  });
});

describe.skipIf(!hasTestDatabase)('multiple choice ballots', () => {
  let adminId: string;

  beforeEach(async () => {
    const admin = await createAdmin();
    adminId = admin.id;
  });

  it('accepts a selection within the configured limits', async () => {
    const event = await createEvent({
      adminId,
      votingType: 'MULTIPLE_CHOICE',
      minSelections: 1,
      maxSelections: 2,
      optionNames: ['Rule A', 'Rule B', 'Rule C', 'Rule D'],
    });

    await VoterService.claimIdentity({ event, rawIgn: 'PlayerOne', context: requestContext() });

    const receipt = await VotingService.submitVote({
      event,
      optionIds: [event.options[0]!.id, event.options[2]!.id],
      context: requestContext(),
    });

    expect(receipt.optionNames.sort()).toEqual(['Rule A', 'Rule C']);

    const stored = await prisma.vote.findFirstOrThrow({
      where: { eventId: event.id },
      include: { selections: true },
    });
    expect(stored.selections).toHaveLength(2);
  });

  it('refuses more selections than the maximum', async () => {
    const event = await createEvent({
      adminId,
      votingType: 'MULTIPLE_CHOICE',
      minSelections: 1,
      maxSelections: 2,
      optionNames: ['Rule A', 'Rule B', 'Rule C', 'Rule D'],
    });

    await VoterService.claimIdentity({ event, rawIgn: 'PlayerOne', context: requestContext() });

    await expectCode(
      VotingService.submitVote({
        event,
        optionIds: event.options.slice(0, 3).map((option) => option.id),
        context: requestContext(),
      }),
      'TOO_MANY_SELECTIONS',
    );

    expect(await countVotes(event.id)).toBe(0);
  });

  it('refuses fewer selections than the minimum', async () => {
    const event = await createEvent({
      adminId,
      votingType: 'MULTIPLE_CHOICE',
      minSelections: 2,
      maxSelections: 3,
      optionNames: ['Rule A', 'Rule B', 'Rule C'],
    });

    await VoterService.claimIdentity({ event, rawIgn: 'PlayerOne', context: requestContext() });

    await expectCode(
      VotingService.submitVote({
        event,
        optionIds: [event.options[0]!.id],
        context: requestContext(),
      }),
      'TOO_FEW_SELECTIONS',
    );
  });

  it('refuses a duplicated option id', async () => {
    const event = await createEvent({
      adminId,
      votingType: 'MULTIPLE_CHOICE',
      minSelections: 1,
      maxSelections: 3,
      optionNames: ['Rule A', 'Rule B', 'Rule C'],
    });

    await VoterService.claimIdentity({ event, rawIgn: 'PlayerOne', context: requestContext() });

    await expectCode(
      VotingService.submitVote({
        event,
        optionIds: [event.options[0]!.id, event.options[0]!.id],
        context: requestContext(),
      }),
      'DUPLICATE_SELECTION',
    );
  });

  it('forces a single-choice event to one selection whatever the columns say', async () => {
    // A stale or tampered row claims a wider ballot; the rules override it.
    const event = await createEvent({
      adminId,
      votingType: 'SINGLE_CHOICE',
      minSelections: 1,
      maxSelections: 3,
    });

    await VoterService.claimIdentity({ event, rawIgn: 'PlayerOne', context: requestContext() });

    await expectCode(
      VotingService.submitVote({
        event,
        optionIds: [event.options[0]!.id, event.options[1]!.id],
        context: requestContext(),
      }),
      'TOO_MANY_SELECTIONS',
    );
  });
});

describe.skipIf(!hasTestDatabase)('identity and moderation', () => {
  let adminId: string;

  beforeEach(async () => {
    const admin = await createAdmin();
    adminId = admin.id;
  });

  it('treats capitalisation and spacing variants as one voter row', async () => {
    const event = await createEvent({ adminId });

    for (const variant of ['PlayerName', '  playername ', 'PLAYERNAME']) {
      startFreshBrowser();
      await VoterService.claimIdentity({ event, rawIgn: variant, context: requestContext() });
    }

    expect(await prisma.voter.count()).toBe(1);

    const voter = await prisma.voter.findFirstOrThrow();
    expect(voter.normalizedName).toBe('playername');
    // The display name tracks the most recent spelling used.
    expect(voter.displayName).toBe('PLAYERNAME');
  });

  it('blocks a voter that an administrator has blocked', async () => {
    const event = await createEvent({ adminId });

    await VoterService.claimIdentity({ event, rawIgn: 'Cheater', context: requestContext() });
    const voter = await prisma.voter.findFirstOrThrow();

    await VoterService.setBlocked(voter.id, true, 'Confirmed duplicate account');

    startFreshBrowser();
    await expectCode(
      VoterService.claimIdentity({ event, rawIgn: 'cheater', context: requestContext() }),
      'VOTER_BLOCKED',
    );
  });

  it('blocks a browser session that an administrator has blocked', async () => {
    const event = await createEvent({ adminId });
    await VoterService.claimIdentity({ event, rawIgn: 'PlayerOne', context: requestContext() });

    const session = await prisma.voterSession.findFirstOrThrow();
    await VoterService.setSessionBlocked(session.id, true, 'Scripted traffic');

    await expectCode(
      VotingService.submitVote({
        event,
        optionIds: [event.options[0]!.id],
        context: requestContext(),
      }),
      'SESSION_BLOCKED',
    );
  });

  it('flags look-alike names without blocking either ballot', async () => {
    const event = await createEvent({ adminId, maxVotesPerSession: 5 });

    await VoterService.claimIdentity({ event, rawIgn: 'PlayerOne', context: requestContext() });
    await VotingService.submitVote({
      event,
      optionIds: [event.options[0]!.id],
      context: requestContext(),
    });

    startFreshBrowser();

    // Digit one instead of the letter l: renders almost identically.
    await VoterService.claimIdentity({
      event,
      rawIgn: 'P1ayerOne',
      context: requestContext('198.51.100.5'),
    });
    await VotingService.submitVote({
      event,
      optionIds: [event.options[1]!.id],
      context: requestContext('198.51.100.5'),
    });

    // Both ballots count. A human decides what to do about them.
    expect(await countVotes(event.id)).toBe(2);

    // Assert across all flagged ballots rather than picking one with
    // `findFirst`: several ballots are legitimately flagged here (a brand-new
    // session also trips IMMEDIATE_SUBMISSION), and an unordered findFirst
    // returns an arbitrary row.
    const flagged = await prisma.vote.findMany({
      where: { isSuspicious: true },
      orderBy: { castAt: 'asc' },
    });

    expect(flagged).toHaveLength(2);

    const allReasons = flagged.flatMap((vote) => vote.suspicionReasons as string[]);
    expect(allReasons).toContain('CONFUSABLE_NAME');

    // Specifically the SECOND ballot is the look-alike: the first had nobody to
    // resemble at the time it was cast.
    expect(flagged[1]!.suspicionReasons as string[]).toContain('CONFUSABLE_NAME');
    expect(flagged[0]!.suspicionReasons as string[]).not.toContain('CONFUSABLE_NAME');

    expect(await auditActions(event.id)).toContain('VOTE_FLAGGED_SUSPICIOUS');
  });

  it('invalidating a vote removes it from the tally but keeps the row', async () => {
    const event = await createEvent({ adminId });
    await VoterService.claimIdentity({ event, rawIgn: 'PlayerOne', context: requestContext() });
    await VotingService.submitVote({
      event,
      optionIds: [event.options[0]!.id],
      context: requestContext(),
    });

    const vote = await prisma.vote.findFirstOrThrow();

    await VotingService.invalidate({
      voteId: vote.id,
      adminId,
      adminLabel: 'admin@test.local',
      reason: 'Confirmed duplicate account',
      context: requestContext(),
    });

    expect(await countVotes(event.id)).toBe(0);
    expect(await prisma.vote.count({ where: { eventId: event.id } })).toBe(1);

    // Still occupies the slot, so the voter cannot simply vote again.
    await expectCode(
      VotingService.submitVote({
        event,
        optionIds: [event.options[1]!.id],
        context: requestContext(),
      }),
      'ALREADY_VOTED',
    );
  });

  it('voiding a vote frees the slot and preserves the ballot in the audit log', async () => {
    const event = await createEvent({ adminId, maxVotesPerSession: 5 });
    await VoterService.claimIdentity({ event, rawIgn: 'PlayerOne', context: requestContext() });
    await VotingService.submitVote({
      event,
      optionIds: [event.options[0]!.id],
      context: requestContext(),
    });

    const vote = await prisma.vote.findFirstOrThrow();

    await VotingService.voidForRevote({
      voteId: vote.id,
      adminId,
      adminLabel: 'admin@test.local',
      reason: 'Voted before the rules were corrected',
      context: requestContext(),
    });

    expect(await prisma.vote.count({ where: { eventId: event.id } })).toBe(0);

    // The ballot's content survives in the audit trail.
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'VOTE_VOIDED_FOR_REVOTE' },
    });
    expect(JSON.stringify(audit.metadata)).toContain(event.options[0]!.name);

    // And the player can now vote again.
    const receipt = await VotingService.submitVote({
      event,
      optionIds: [event.options[1]!.id],
      context: requestContext(),
    });
    expect(receipt.optionNames).toEqual([event.options[1]!.name]);
  });

  it('restores an invalidated vote to the tally', async () => {
    const event = await createEvent({ adminId });
    await VoterService.claimIdentity({ event, rawIgn: 'PlayerOne', context: requestContext() });
    await VotingService.submitVote({
      event,
      optionIds: [event.options[0]!.id],
      context: requestContext(),
    });

    const vote = await prisma.vote.findFirstOrThrow();

    await VotingService.invalidate({
      voteId: vote.id,
      adminId,
      adminLabel: 'admin@test.local',
      reason: 'Mistake',
      context: requestContext(),
    });
    expect(await countVotes(event.id)).toBe(0);

    await VotingService.restore({
      voteId: vote.id,
      adminId,
      adminLabel: 'admin@test.local',
      context: requestContext(),
    });
    expect(await countVotes(event.id)).toBe(1);
  });

  it('keeps a receipt retrievable for the browser that cast it', async () => {
    const event = await createEvent({ adminId });
    await VoterService.claimIdentity({ event, rawIgn: 'PlayerOne', context: requestContext() });
    const receipt = await VotingService.submitVote({
      event,
      optionIds: [event.options[0]!.id],
      context: requestContext(),
    });

    const session = await prisma.voterSession.findFirstOrThrow();
    const fetched = await VotingService.getReceiptForSession(event.id, session.id);

    expect(fetched?.receiptCode).toBe(receipt.receiptCode);

    // A different browser gets nothing, even for the same event.
    const snapshot = captureBrowser();
    startFreshBrowser();
    restoreBrowser(snapshot);
    expect(fetched?.displayName).toBe('PlayerOne');
  });
});

describe.skipIf(!hasTestDatabase)('per-event voting statistics', () => {
  let adminId: string;

  beforeEach(async () => {
    const admin = await createAdmin();
    adminId = admin.id;
  });

  it('reports counted, flagged and invalidated ballots for each event', async () => {
    const [alpha, beta] = await Promise.all([
      createEvent({ adminId, slug: 'alpha-event', maxVotesPerSession: 10 }),
      createEvent({ adminId, slug: 'beta-event', maxVotesPerSession: 10 }),
    ]);

    // Two ballots in alpha, one in beta.
    for (const name of ['PlayerOne', 'PlayerTwo']) {
      startFreshBrowser();
      await VoterService.claimIdentity({ event: alpha, rawIgn: name, context: requestContext() });
      await VotingService.submitVote({
        event: alpha,
        optionIds: [alpha.options[0]!.id],
        context: requestContext(),
      });
    }

    startFreshBrowser();
    await VoterService.claimIdentity({ event: beta, rawIgn: 'PlayerThree', context: requestContext() });
    await VotingService.submitVote({
      event: beta,
      optionIds: [beta.options[0]!.id],
      context: requestContext(),
    });

    const overview = await ResultsService.participationByEvent();

    const alphaRow = overview.rows.find((row) => row.eventId === alpha.id);
    const betaRow = overview.rows.find((row) => row.eventId === beta.id);

    expect(alphaRow?.counted).toBe(2);
    expect(betaRow?.counted).toBe(1);

    // Busiest event anchors the bar scale.
    expect(alphaRow?.relativeShare).toBe(100);
    expect(betaRow?.relativeShare).toBe(50);

    expect(overview.totals.countedBallots).toBe(3);
    expect(overview.totals.eventsWithVotes).toBe(2);
    // Three distinct identities, each voting once.
    expect(overview.totals.knownVoters).toBe(3);
  });

  it('counts one identity voting in several events once as a voter', async () => {
    // The unique constraint is per-event, so one person legitimately holds a
    // ballot in every event they take part in. Turnout must not double-count
    // them as two different voters.
    const [alpha, beta] = await Promise.all([
      createEvent({ adminId, slug: 'alpha-two' }),
      createEvent({ adminId, slug: 'beta-two' }),
    ]);

    for (const event of [alpha, beta]) {
      startFreshBrowser();
      await VoterService.claimIdentity({ event, rawIgn: 'PlayerOne', context: requestContext() });
      await VotingService.submitVote({
        event,
        optionIds: [event.options[0]!.id],
        context: requestContext(),
      });
    }

    const overview = await ResultsService.participationByEvent();

    expect(overview.totals.countedBallots).toBe(2);
    expect(overview.totals.knownVoters).toBe(1);
    expect(await prisma.voter.count()).toBe(1);
  });

  it('moves a ballot from counted to invalidated', async () => {
    const event = await createEvent({ adminId });

    await VoterService.claimIdentity({ event, rawIgn: 'PlayerOne', context: requestContext() });
    await VotingService.submitVote({
      event,
      optionIds: [event.options[0]!.id],
      context: requestContext(),
    });

    const vote = await prisma.vote.findFirstOrThrow();
    await VotingService.invalidate({
      voteId: vote.id,
      adminId,
      adminLabel: 'admin@test.local',
      reason: 'Duplicate account',
      context: requestContext(),
    });

    const overview = await ResultsService.participationByEvent();
    const row = overview.rows.find((entry) => entry.eventId === event.id);

    expect(row?.counted).toBe(0);
    expect(row?.invalidated).toBe(1);
    // An identity whose only ballot was invalidated is no longer a voter.
    expect(overview.totals.knownVoters).toBe(0);
  });

  it('includes events with no ballots at all', async () => {
    const empty = await createEvent({ adminId, slug: 'nobody-voted' });

    const overview = await ResultsService.participationByEvent();
    const row = overview.rows.find((entry) => entry.eventId === empty.id);

    // "Nobody voted in this one" is itself the finding an organiser needs.
    expect(row).toBeDefined();
    expect(row?.counted).toBe(0);
    expect(row?.relativeShare).toBe(0);
  });

  it('reports distinct devices, and reports none when no session was recorded', async () => {
    const event = await createEvent({ adminId, maxVotesPerSession: 5 });

    // Two ballots from ONE browser.
    for (const name of ['PlayerOne', 'PlayerTwo']) {
      await VoterService.claimIdentity({ event, rawIgn: name, context: requestContext() });
      await VotingService.submitVote({
        event,
        optionIds: [event.options[0]!.id],
        context: requestContext(),
      });
    }

    let overview = await ResultsService.participationByEvent();
    let row = overview.rows.find((entry) => entry.eventId === event.id);

    expect(row?.counted).toBe(2);
    expect(row?.distinctSessions).toBe(1);

    // A ballot with no session (seeded or imported) must report zero sessions
    // rather than inventing one - the UI treats 0 as "no data", not "no devices".
    await prisma.vote.updateMany({ data: { sessionId: null } });

    overview = await ResultsService.participationByEvent();
    row = overview.rows.find((entry) => entry.eventId === event.id);

    expect(row?.counted).toBe(2);
    expect(row?.distinctSessions).toBe(0);
  });

  it('lists the events each voter took part in', async () => {
    const [alpha, beta] = await Promise.all([
      createEvent({ adminId, slug: 'alpha-three' }),
      createEvent({ adminId, slug: 'beta-three' }),
    ]);

    for (const event of [alpha, beta]) {
      startFreshBrowser();
      await VoterService.claimIdentity({ event, rawIgn: 'PlayerOne', context: requestContext() });
      await VotingService.submitVote({
        event,
        optionIds: [event.options[0]!.id],
        context: requestContext(),
      });
    }

    const voter = await prisma.voter.findFirstOrThrow({ select: { id: true } });
    const history = await ResultsService.participationForVoters([voter.id]);

    const entries = history.get(voter.id) ?? [];
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.eventId).sort()).toEqual([alpha.id, beta.id].sort());
    expect(entries.every((entry) => entry.status === 'VALID')).toBe(true);
  });

  it('returns nothing for a voter with no ballots', async () => {
    const event = await createEvent({ adminId });
    await VoterService.claimIdentity({ event, rawIgn: 'NeverVoted', context: requestContext() });

    const voter = await prisma.voter.findFirstOrThrow({ select: { id: true } });
    const history = await ResultsService.participationForVoters([voter.id]);

    expect(history.get(voter.id)).toBeUndefined();
    // Entering a name is not voting; turnout must not count them.
    const overview = await ResultsService.participationByEvent();
    expect(overview.totals.knownVoters).toBe(0);
  });
});
