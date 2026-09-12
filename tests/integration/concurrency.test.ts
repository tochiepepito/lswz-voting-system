import { beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '@/lib/errors';
import { generateReceiptCode } from '@/lib/crypto';
import { prisma } from '@/lib/prisma';
import { createVoteWithSelections } from '@/server/repositories/vote.repository';
import * as VoterService from '@/server/services/voter.service';
import * as VotingService from '@/server/services/voting.service';
import { hasTestDatabase } from '../setup-integration';
import { countVotes, createAdmin, createEvent, requestContext } from '../helpers/factories';

/**
 * Concurrency.
 *
 * The single most important property of this system: when one voter is allowed
 * one ballot, two simultaneous submissions must produce exactly one row.
 *
 * Note what these tests deliberately do NOT rely on. The application's
 * "have you already voted?" check is a fast path for a friendly message; under a
 * genuine race both requests pass it, because both read the table before either
 * writes. What actually holds the line is the PostgreSQL unique constraint on
 * `votes(eventId, voterId)`. These tests exist to prove that claim, so they
 * attack the constraint directly as well as through the service.
 */

describe.skipIf(!hasTestDatabase)('concurrent vote submission', () => {
  let adminId: string;

  beforeEach(async () => {
    const admin = await createAdmin();
    adminId = admin.id;
  });

  it('records exactly one ballot when the same voter submits twice at once', async () => {
    const event = await createEvent({ adminId, maxVotesPerSession: 5 });

    await VoterService.claimIdentity({ event, rawIgn: 'PlayerOne', context: requestContext() });

    // Both submissions are started before either is awaited, so they overlap.
    const results = await Promise.allSettled([
      VotingService.submitVote({
        event,
        optionIds: [event.options[0]!.id],
        context: requestContext(),
      }),
      VotingService.submitVote({
        event,
        optionIds: [event.options[1]!.id],
        context: requestContext(),
      }),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // The loser gets the ordinary, user-facing error - not a database message.
    const error = (rejected[0] as PromiseRejectedResult).reason;
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('ALREADY_VOTED');
    expect((error as AppError).message).toBe('You have already voted in this event.');

    expect(await countVotes(event.id)).toBe(1);

    // And the surviving ballot is complete: one vote, one selection.
    const votes = await prisma.vote.findMany({
      where: { eventId: event.id },
      include: { selections: true },
    });
    expect(votes).toHaveLength(1);
    expect(votes[0]!.selections).toHaveLength(1);
  });

  it('survives ten simultaneous submissions from one identity', async () => {
    const event = await createEvent({ adminId, maxVotesPerSession: 50 });

    await VoterService.claimIdentity({ event, rawIgn: 'PlayerOne', context: requestContext() });

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, index) =>
        VotingService.submitVote({
          event,
          optionIds: [event.options[index % event.options.length]!.id],
          context: requestContext(),
        }),
      ),
    );

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await countVotes(event.id)).toBe(1);

    // Every loser got a clean, user-safe rejection.
    for (const result of results.filter((entry) => entry.status === 'rejected')) {
      const reason = (result as PromiseRejectedResult).reason;
      expect(reason).toBeInstanceOf(AppError);
      expect(['ALREADY_VOTED', 'SESSION_VOTE_LIMIT']).toContain((reason as AppError).code);
    }
  });

  it('leaves no partial ballot behind when a racing insert loses', async () => {
    // The failing transaction must roll back its selection rows too, or the
    // tally would double-count one of the options.
    const event = await createEvent({ adminId, maxVotesPerSession: 5 });
    await VoterService.claimIdentity({ event, rawIgn: 'PlayerOne', context: requestContext() });

    await Promise.allSettled([
      VotingService.submitVote({
        event,
        optionIds: [event.options[0]!.id],
        context: requestContext(),
      }),
      VotingService.submitVote({
        event,
        optionIds: [event.options[1]!.id],
        context: requestContext(),
      }),
    ]);

    const selectionCount = await prisma.voteSelection.count();
    expect(selectionCount).toBe(1);

    // Every surviving selection belongs to a vote that still exists. (The FK is
    // NOT NULL with ON DELETE CASCADE, so a true orphan is not representable -
    // this asserts the rollback took the selection with it, not just the vote.)
    const selections = await prisma.voteSelection.findMany({ select: { voteId: true } });
    const voteIds = new Set(
      (await prisma.vote.findMany({ select: { id: true } })).map((vote) => vote.id),
    );

    expect(selections.every((selection) => voteIds.has(selection.voteId))).toBe(true);
  });

  it('enforces the constraint at the database level, below the service', async () => {
    // Bypass every application check and insert twice directly. This is the
    // proof that the guarantee is structural rather than procedural: even a bug
    // that skipped the service checks entirely cannot produce two ballots.
    const event = await createEvent({ adminId });

    const voter = await prisma.voter.create({
      data: {
        displayName: 'DirectInsert',
        normalizedName: 'directinsert',
        nameHash: 'deterministic-hash-for-this-test',
        confusableKey: 'directinsert',
      },
      select: { id: true },
    });

    const insert = () =>
      createVoteWithSelections({
        eventId: event.id,
        voterId: voter.id,
        sessionId: null,
        identityMethod: 'IGN_SELF_DECLARED',
        receiptCode: generateReceiptCode(),
        ipHash: null,
        userAgentHash: null,
        isSuspicious: false,
        suspicionReasons: [],
        optionIds: [event.options[0]!.id],
      });

    const results = await Promise.allSettled([insert(), insert()]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.vote.count({ where: { eventId: event.id } })).toBe(1);

    // The rejection really is the unique-constraint violation.
    const reason = (results.find((result) => result.status === 'rejected') as PromiseRejectedResult)
      .reason as { code?: string };
    expect(reason.code).toBe('P2002');
  });

  it('lets two different voters vote at the same time', async () => {
    // The constraint must not serialise unrelated voters into a single winner.
    const event = await createEvent({ adminId });

    const voters = await Promise.all(
      ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'].map((name) =>
        prisma.voter.create({
          data: {
            displayName: name,
            normalizedName: name.toLowerCase(),
            nameHash: `hash-${name.toLowerCase()}`,
            confusableKey: name.toLowerCase(),
          },
          select: { id: true },
        }),
      ),
    );

    const results = await Promise.allSettled(
      voters.map((voter, index) =>
        createVoteWithSelections({
          eventId: event.id,
          voterId: voter.id,
          sessionId: null,
          identityMethod: 'IGN_SELF_DECLARED',
          receiptCode: generateReceiptCode(),
          ipHash: null,
          userAgentHash: null,
          isSuspicious: false,
          suspicionReasons: [],
          optionIds: [event.options[index % event.options.length]!.id],
        }),
      ),
    );

    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    expect(await countVotes(event.id)).toBe(5);
  });

  it('records exactly one claim when one browser claims twice at once', async () => {
    // `EventIdentityClaim` has its own unique key on (eventId, sessionId); a
    // double-submit of the IGN form must not create two claims.
    const event = await createEvent({ adminId });

    const results = await Promise.allSettled([
      VoterService.claimIdentity({ event, rawIgn: 'PlayerOne', context: requestContext() }),
      VoterService.claimIdentity({ event, rawIgn: 'PlayerOne', context: requestContext() }),
    ]);

    // Both may legitimately succeed - the upsert is idempotent - but there must
    // be exactly one claim row and one voter.
    expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
    expect(await prisma.eventIdentityClaim.count({ where: { eventId: event.id } })).toBe(1);
    expect(await prisma.voter.count()).toBe(1);
  });

  it('counts a concurrent rate-limit burst exactly once per request', async () => {
    // The counter is incremented by the database, so parallel requests cannot
    // each read a stale value and write the same number back.
    const { consume } = await import('@/server/services/rate-limit.service');

    const decisions = await Promise.all(
      Array.from({ length: 20 }, () => consume('VOTE_IP', '203.0.113.99')),
    );

    expect(decisions).toHaveLength(20);

    const record = await prisma.rateLimitRecord.findFirstOrThrow({ where: { scope: 'VOTE_IP' } });
    expect(record.count).toBe(20);
  });
});
