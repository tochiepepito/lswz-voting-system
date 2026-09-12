import { describe, expect, it } from 'vitest';
import { AppError } from '@/lib/errors';
import {
  assertVotingOpen,
  canPublicSeeResults,
  describeBallotRule,
  isVotingOpen,
  reconciledStatus,
  selectionBounds,
  validateSelections,
  votingPhase,
  type BallotPolicy,
  type EventTiming,
} from '@/lib/voting-rules';
import type { ResultsVisibility } from '@/types/domain';

/**
 * The voting rules decide who may vote, on what, and who sees the result. They
 * are pure, so every branch is testable without a database - which is the whole
 * reason they were factored out of the services.
 */

const NOW = new Date('2026-09-16T12:00:00Z');
const BEFORE = new Date('2026-09-15T20:00:00Z');
const AFTER = new Date('2026-09-17T20:00:00Z');

function timing(overrides: Partial<EventTiming> = {}): EventTiming {
  return { status: 'ACTIVE', startsAt: BEFORE, endsAt: AFTER, ...overrides };
}

function policy(overrides: Partial<BallotPolicy> = {}): BallotPolicy {
  return { votingType: 'SINGLE_CHOICE', minSelections: 1, maxSelections: 1, ...overrides };
}

/** Assert that a call throws an AppError with a specific code. */
function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    return;
  }
  throw new Error(`expected a throw with code ${code}, but nothing was thrown`);
}

describe('selectionBounds', () => {
  it('forces single-choice and yes/no to exactly one selection', () => {
    // Even if the stored columns say otherwise - a bad row or a stale edit must
    // not be able to widen a single-choice election.
    expect(selectionBounds(policy({ minSelections: 3, maxSelections: 9 }))).toEqual({
      min: 1,
      max: 1,
    });
    expect(
      selectionBounds(policy({ votingType: 'YES_NO', minSelections: 2, maxSelections: 5 })),
    ).toEqual({ min: 1, max: 1 });
  });

  it('honours configured bounds for multiple choice', () => {
    expect(
      selectionBounds(policy({ votingType: 'MULTIPLE_CHOICE', minSelections: 2, maxSelections: 4 })),
    ).toEqual({ min: 2, max: 4 });
  });

  it('clamps a minimum that exceeds the maximum', () => {
    expect(
      selectionBounds(policy({ votingType: 'MULTIPLE_CHOICE', minSelections: 9, maxSelections: 3 })),
    ).toEqual({ min: 3, max: 3 });
  });

  it('never returns a maximum below one', () => {
    expect(
      selectionBounds(policy({ votingType: 'MULTIPLE_CHOICE', minSelections: 0, maxSelections: 0 })),
    ).toEqual({ min: 1, max: 1 });
  });
});

describe('describeBallotRule', () => {
  it('describes each voting type in the voter is own words', () => {
    expect(describeBallotRule(policy())).toBe('Choose ONE option.');
    expect(describeBallotRule(policy({ votingType: 'YES_NO' }))).toBe('Choose Yes or No.');
    expect(
      describeBallotRule(policy({ votingType: 'MULTIPLE_CHOICE', minSelections: 1, maxSelections: 3 })),
    ).toBe('Choose up to 3 options.');
    expect(
      describeBallotRule(policy({ votingType: 'MULTIPLE_CHOICE', minSelections: 2, maxSelections: 4 })),
    ).toBe('Choose between 2 and 4 options.');
    expect(
      describeBallotRule(policy({ votingType: 'MULTIPLE_CHOICE', minSelections: 3, maxSelections: 3 })),
    ).toBe('Choose exactly 3 options.');
  });

  it('caps the stated maximum at the number of options that actually exist', () => {
    expect(
      describeBallotRule(
        policy({ votingType: 'MULTIPLE_CHOICE', minSelections: 1, maxSelections: 5 }),
        2,
      ),
    ).toBe('Choose up to 2 options.');
  });
});

describe('votingPhase - the clock is authoritative', () => {
  it('reports OPEN inside the window', () => {
    expect(votingPhase(timing(), NOW)).toBe('OPEN');
    expect(isVotingOpen(timing(), NOW)).toBe(true);
  });

  it('reports UPCOMING before the start time', () => {
    expect(votingPhase(timing({ startsAt: AFTER, endsAt: null }), NOW)).toBe('UPCOMING');
  });

  it('reports ENDED after the end time even while the row still says ACTIVE', () => {
    // The critical case: a missed scheduled job must never extend an election.
    expect(votingPhase(timing({ endsAt: BEFORE }), NOW)).toBe('ENDED');
    expect(isVotingOpen(timing({ endsAt: BEFORE }), NOW)).toBe(false);
  });

  it('treats a SCHEDULED event whose start has passed as open', () => {
    // Equally: a missed job must not block voters out of a live election.
    expect(votingPhase(timing({ status: 'SCHEDULED' }), NOW)).toBe('OPEN');
  });

  it('treats a SCHEDULED event with no start time as upcoming', () => {
    expect(votingPhase(timing({ status: 'SCHEDULED', startsAt: null }), NOW)).toBe('UPCOMING');
  });

  it('never opens a draft or a closed event', () => {
    expect(votingPhase(timing({ status: 'DRAFT' }), NOW)).toBe('NOT_PUBLISHED');
    expect(votingPhase(timing({ status: 'CLOSED' }), NOW)).toBe('ENDED');
    expect(votingPhase(timing({ status: 'ARCHIVED' }), NOW)).toBe('ENDED');
  });

  it('treats the exact end instant as closed', () => {
    // A ballot submitted at precisely the deadline is late.
    expect(votingPhase(timing({ endsAt: NOW }), NOW)).toBe('ENDED');
  });

  it('treats the exact start instant as open', () => {
    expect(votingPhase(timing({ startsAt: NOW }), NOW)).toBe('OPEN');
  });
});

describe('assertVotingOpen', () => {
  it('passes silently when voting is open', () => {
    expect(() => assertVotingOpen(timing(), NOW)).not.toThrow();
  });

  it('reports the precise reason voting is unavailable', () => {
    expectCode(() => assertVotingOpen(timing({ startsAt: AFTER }), NOW), 'EVENT_NOT_STARTED');
    expectCode(() => assertVotingOpen(timing({ endsAt: BEFORE }), NOW), 'EVENT_ENDED');
    expectCode(() => assertVotingOpen(timing({ status: 'CLOSED' }), NOW), 'EVENT_ENDED');
    expectCode(() => assertVotingOpen(timing({ status: 'DRAFT' }), NOW), 'EVENT_NOT_ACTIVE');
  });
});

describe('reconciledStatus', () => {
  it('promotes a scheduled event whose start time has arrived', () => {
    expect(reconciledStatus(timing({ status: 'SCHEDULED' }), NOW)).toBe('ACTIVE');
  });

  it('closes an active event whose end time has passed', () => {
    expect(reconciledStatus(timing({ endsAt: BEFORE }), NOW)).toBe('CLOSED');
  });

  it('jumps straight to CLOSED when the whole window elapsed unattended', () => {
    expect(
      reconciledStatus(
        timing({ status: 'SCHEDULED', startsAt: new Date('2026-01-01'), endsAt: BEFORE }),
        NOW,
      ),
    ).toBe('CLOSED');
  });

  it('returns null when the stored status is already correct', () => {
    expect(reconciledStatus(timing(), NOW)).toBeNull();
    expect(reconciledStatus(timing({ status: 'DRAFT' }), NOW)).toBeNull();
    expect(reconciledStatus(timing({ status: 'CLOSED' }), NOW)).toBeNull();
  });
});

describe('validateSelections', () => {
  const available = ['opt-a', 'opt-b', 'opt-c'];

  it('accepts a valid single choice', () => {
    expect(validateSelections(policy(), ['opt-b'], available)).toEqual(['opt-b']);
  });

  it('rejects an empty ballot', () => {
    expectCode(() => validateSelections(policy(), [], available), 'TOO_FEW_SELECTIONS');
  });

  it('rejects more selections than the type allows', () => {
    // A crafted request sending two option ids to a single-choice election.
    expectCode(
      () => validateSelections(policy(), ['opt-a', 'opt-b'], available),
      'TOO_MANY_SELECTIONS',
    );
  });

  it('rejects a repeated option rather than silently de-duplicating it', () => {
    // Quietly collapsing this would let a ballot look valid when it was not.
    expectCode(
      () =>
        validateSelections(
          policy({ votingType: 'MULTIPLE_CHOICE', maxSelections: 3 }),
          ['opt-a', 'opt-a'],
          available,
        ),
      'DUPLICATE_SELECTION',
    );
  });

  it('rejects an option that does not belong to this event', () => {
    // The core request-tampering defence: ids are checked against rows read for
    // THIS event, so another event's option id is simply unavailable.
    expectCode(
      () => validateSelections(policy(), ['other-event-option'], available),
      'OPTION_UNAVAILABLE',
    );
  });

  it('rejects a deactivated option', () => {
    // A deactivated option is absent from `available`, so it fails identically
    // to one that never existed - a prober learns nothing from the difference.
    expectCode(() => validateSelections(policy(), ['opt-d'], available), 'OPTION_UNAVAILABLE');
  });

  it('enforces multiple-choice minimum and maximum', () => {
    const multi = policy({ votingType: 'MULTIPLE_CHOICE', minSelections: 2, maxSelections: 3 });

    expect(validateSelections(multi, ['opt-a', 'opt-b'], available)).toEqual(['opt-a', 'opt-b']);
    expect(validateSelections(multi, available, available)).toEqual(available);

    expectCode(() => validateSelections(multi, ['opt-a'], available), 'TOO_FEW_SELECTIONS');
    expectCode(
      () => validateSelections(multi, [...available, 'opt-d'], available),
      'TOO_MANY_SELECTIONS',
    );
  });

  it('rejects injection payloads in place of an option id', () => {
    for (const payload of ["'; DELETE FROM votes; --", '<script>', '../../etc/passwd', '*']) {
      expectCode(() => validateSelections(policy(), [payload], available), 'OPTION_UNAVAILABLE');
    }
  });
});

describe('canPublicSeeResults', () => {
  const cases: Array<{
    visibility: ResultsVisibility;
    status: EventTiming['status'];
    endsAt: Date | null;
    hasVoted: boolean;
    expected: boolean;
    why: string;
  }> = [
    { visibility: 'HIDDEN', status: 'CLOSED', endsAt: BEFORE, hasVoted: true, expected: false, why: 'hidden stays hidden even after close' },
    { visibility: 'WHILE_VOTING', status: 'ACTIVE', endsAt: AFTER, hasVoted: false, expected: true, why: 'live tally is public' },
    { visibility: 'AFTER_VOTING', status: 'ACTIVE', endsAt: AFTER, hasVoted: false, expected: false, why: 'not yet voted' },
    { visibility: 'AFTER_VOTING', status: 'ACTIVE', endsAt: AFTER, hasVoted: true, expected: true, why: 'voted, so unlocked' },
    { visibility: 'AFTER_VOTING', status: 'CLOSED', endsAt: BEFORE, hasVoted: false, expected: true, why: 'closed unlocks it for everyone' },
    { visibility: 'AFTER_CLOSE', status: 'ACTIVE', endsAt: AFTER, hasVoted: true, expected: false, why: 'voting still open' },
    { visibility: 'AFTER_CLOSE', status: 'CLOSED', endsAt: BEFORE, hasVoted: false, expected: true, why: 'closed' },
    { visibility: 'WHILE_VOTING', status: 'DRAFT', endsAt: AFTER, hasVoted: false, expected: false, why: 'drafts are never public' },
  ];

  for (const testCase of cases) {
    it(`${testCase.visibility} / ${testCase.status} / voted=${testCase.hasVoted} -> ${testCase.expected} (${testCase.why})`, () => {
      expect(
        canPublicSeeResults({
          resultsVisibility: testCase.visibility,
          event: timing({ status: testCase.status, endsAt: testCase.endsAt }),
          hasVoted: testCase.hasVoted,
          now: NOW,
        }),
      ).toBe(testCase.expected);
    });
  }

  it('unlocks AFTER_CLOSE by the clock, not only by the stored status', () => {
    // The row still says ACTIVE, but the end time has passed.
    expect(
      canPublicSeeResults({
        resultsVisibility: 'AFTER_CLOSE',
        event: timing({ status: 'ACTIVE', endsAt: BEFORE }),
        hasVoted: false,
        now: NOW,
      }),
    ).toBe(true);
  });
});
