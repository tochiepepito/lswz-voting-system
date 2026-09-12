import { appError } from './errors';
import type { EventStatus, ResultsVisibility, VotingType } from '@/types/domain';

/**
 * Pure voting rules.
 *
 * Every decision about "may this vote be cast, and is this ballot well formed"
 * lives here as a side-effect-free function over plain data. The service layer
 * calls into it; the UI calls the same functions to render labels and disabled
 * states. One definition, two consumers, no drift - and the whole ruleset is
 * exhaustively unit-testable without a database.
 */

export type BallotPolicy = {
  votingType: VotingType;
  minSelections: number;
  maxSelections: number;
};

export type EventTiming = {
  status: EventStatus;
  startsAt: Date | null;
  endsAt: Date | null;
};

/** Where an event sits relative to its own schedule, from a voter's point of view. */
export type VotingPhase =
  | 'NOT_PUBLISHED'
  | 'UPCOMING'
  | 'OPEN'
  | 'ENDED';

// --------------------------------------------------------------------------
// Selection bounds
// --------------------------------------------------------------------------

/**
 * Resolve the real selection bounds for an event.
 *
 * SINGLE_CHOICE and YES_NO are always exactly one selection regardless of what
 * is stored, so a bad row or a stale admin edit can never widen a single-choice
 * election into a multi-pick one.
 */
export function selectionBounds(policy: BallotPolicy): { min: number; max: number } {
  if (policy.votingType === 'SINGLE_CHOICE' || policy.votingType === 'YES_NO') {
    return { min: 1, max: 1 };
  }

  const max = Math.max(1, Math.floor(policy.maxSelections));
  const min = Math.min(Math.max(1, Math.floor(policy.minSelections)), max);

  return { min, max };
}

/** Human-readable ballot instruction, e.g. "Choose ONE candidate." */
export function describeBallotRule(policy: BallotPolicy, optionCount?: number): string {
  const { min, max } = selectionBounds(policy);

  if (policy.votingType === 'YES_NO') return 'Choose Yes or No.';
  if (policy.votingType === 'SINGLE_CHOICE') return 'Choose ONE option.';

  if (min === max) {
    return `Choose exactly ${max} ${max === 1 ? 'option' : 'options'}.`;
  }

  const ceiling = optionCount !== undefined ? Math.min(max, optionCount) : max;

  if (min <= 1) return `Choose up to ${ceiling} options.`;

  return `Choose between ${min} and ${ceiling} options.`;
}

// --------------------------------------------------------------------------
// Timing
// --------------------------------------------------------------------------

/**
 * Current phase of an event.
 *
 * The stored status and the clock are both authoritative: an event left in
 * ACTIVE past its `endsAt` is ENDED for voting purposes even before a scheduled
 * job gets round to writing CLOSED. That means a missed cron run can never
 * accidentally extend an election.
 */
export function votingPhase(event: EventTiming, now: Date = new Date()): VotingPhase {
  switch (event.status) {
    case 'DRAFT':
      return 'NOT_PUBLISHED';

    case 'CLOSED':
    case 'ARCHIVED':
      return 'ENDED';

    case 'SCHEDULED':
      // A scheduled event whose window has already opened is treated as open,
      // so voters are never blocked purely because a job has not run yet.
      if (event.startsAt && event.startsAt > now) return 'UPCOMING';
      if (event.endsAt && event.endsAt <= now) return 'ENDED';
      return event.startsAt ? 'OPEN' : 'UPCOMING';

    case 'ACTIVE':
      if (event.startsAt && event.startsAt > now) return 'UPCOMING';
      if (event.endsAt && event.endsAt <= now) return 'ENDED';
      return 'OPEN';

    default: {
      // Exhaustiveness guard: adding a status without handling it fails the build.
      const unreachable: never = event.status;
      return unreachable;
    }
  }
}

export function isVotingOpen(event: EventTiming, now: Date = new Date()): boolean {
  return votingPhase(event, now) === 'OPEN';
}

/**
 * Throw the precise, user-facing reason that voting is not open.
 * Returns normally when voting is open.
 */
export function assertVotingOpen(event: EventTiming, now: Date = new Date()): void {
  switch (votingPhase(event, now)) {
    case 'OPEN':
      return;
    case 'UPCOMING':
      throw appError('EVENT_NOT_STARTED');
    case 'ENDED':
      throw appError('EVENT_ENDED');
    case 'NOT_PUBLISHED':
      throw appError('EVENT_NOT_ACTIVE');
  }
}

/**
 * Status an event *should* hold given the clock, or null when it already
 * matches. Used by the lazy reconciliation that runs on event reads, so
 * SCHEDULED becomes ACTIVE and ACTIVE becomes CLOSED without a cron dependency.
 */
export function reconciledStatus(event: EventTiming, now: Date = new Date()): EventStatus | null {
  if (event.status === 'SCHEDULED' && event.startsAt && event.startsAt <= now) {
    // Straight to CLOSED if the whole window elapsed while nobody looked.
    if (event.endsAt && event.endsAt <= now) return 'CLOSED';
    return 'ACTIVE';
  }

  if (event.status === 'ACTIVE' && event.endsAt && event.endsAt <= now) {
    return 'CLOSED';
  }

  return null;
}

// --------------------------------------------------------------------------
// Ballot validation
// --------------------------------------------------------------------------

/**
 * Validate a submitted set of option IDs against the ballot policy and the set
 * of options that are genuinely selectable.
 *
 * `availableOptionIds` must be the ACTIVE options belonging to THIS event, read
 * from the database inside the vote transaction. Passing anything client-derived
 * here would let a crafted request vote for another event's options.
 *
 * Returns the de-duplicated, validated selection.
 */
export function validateSelections(
  policy: BallotPolicy,
  submittedOptionIds: readonly string[],
  availableOptionIds: readonly string[],
): string[] {
  const unique = Array.from(new Set(submittedOptionIds));

  if (unique.length !== submittedOptionIds.length) {
    throw appError('DUPLICATE_SELECTION');
  }

  const { min, max } = selectionBounds(policy);

  if (unique.length < min) {
    throw appError('TOO_FEW_SELECTIONS', {
      message:
        min === 1
          ? 'Please choose an option before submitting your vote.'
          : `Please choose at least ${min} options before submitting your vote.`,
    });
  }

  if (unique.length > max) {
    throw appError('TOO_MANY_SELECTIONS', {
      message:
        max === 1
          ? 'Only one option can be selected for this vote.'
          : `You can select at most ${max} options for this vote.`,
    });
  }

  const available = new Set(availableOptionIds);
  for (const optionId of unique) {
    if (!available.has(optionId)) {
      // Deliberately the same error whether the option belongs to another event,
      // was deactivated, or never existed: a prober learns nothing either way.
      throw appError('OPTION_UNAVAILABLE');
    }
  }

  return unique;
}

// --------------------------------------------------------------------------
// Results visibility
// --------------------------------------------------------------------------

export type ResultsVisibilityInput = {
  resultsVisibility: ResultsVisibility;
  event: EventTiming;
  /** Whether the requesting voter has cast a vote in this event. */
  hasVoted: boolean;
  now?: Date;
};

/**
 * Whether a *public* (non-admin) viewer may see the tally.
 * Administrators always can, and never route through this function.
 */
export function canPublicSeeResults({
  resultsVisibility,
  event,
  hasVoted,
  now = new Date(),
}: ResultsVisibilityInput): boolean {
  const phase = votingPhase(event, now);

  // Nothing about an unpublished event is public, whatever its visibility says.
  if (phase === 'NOT_PUBLISHED') return false;

  switch (resultsVisibility) {
    case 'HIDDEN':
      return false;
    case 'WHILE_VOTING':
      return true;
    case 'AFTER_VOTING':
      return hasVoted || phase === 'ENDED';
    case 'AFTER_CLOSE':
      return phase === 'ENDED';
    default: {
      const unreachable: never = resultsVisibility;
      return unreachable;
    }
  }
}

/** Why results are not shown, for an empty-state message. */
export function resultsUnavailableReason(
  resultsVisibility: ResultsVisibility,
  phase: VotingPhase,
): string {
  if (resultsVisibility === 'HIDDEN') {
    return 'Results for this event are not published publicly.';
  }
  if (resultsVisibility === 'AFTER_VOTING') {
    return 'Results become visible to you once you have cast your vote.';
  }
  if (resultsVisibility === 'AFTER_CLOSE' && phase !== 'ENDED') {
    return 'Results will be published when voting closes.';
  }
  return 'Results are not available yet.';
}
