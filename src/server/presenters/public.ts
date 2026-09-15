import { hashBallotOrderSeed, seededShuffle } from '@/lib/crypto';
import { describeBallotRule, selectionBounds, votingPhase, type VotingPhase } from '@/lib/voting-rules';
import type { EventStatus, ResultsVisibility, VotingType } from '@/types/domain';
import type { EventWithOptions, OptionRow } from '../repositories/event.repository';
import type { EventResults } from '../services/results.service';

/**
 * Public presenters.
 *
 * The allow-list boundary between database rows and anything a voter's browser
 * can see. Building the DTO field by field - rather than spreading a row and
 * deleting the bits that look sensitive - means a new column added to
 * `voting_events` next year cannot appear in an API response by accident.
 *
 * Deliberately absent from every public payload:
 *   - internal ids for the event and for votes
 *   - `createdById` and the whole admin relation
 *   - `maxVotesPerSession`, `ipSoftLimit` (anti-abuse thresholds: publishing
 *     them tells an attacker exactly how far they can go)
 *   - lifecycle timestamps, audit data, vote-level metadata
 *
 * Option ids ARE published, because a ballot has to name what it is voting for.
 * They are opaque and, crucially, every submitted id is re-validated against the
 * event's own active options inside the vote transaction.
 */

export type PublicOption = {
  id: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
};

export type PublicEvent = {
  slug: string;
  title: string;
  description: string;
  instructions: string | null;
  votingType: VotingType;
  status: EventStatus;
  phase: VotingPhase;
  startsAt: string | null;
  endsAt: string | null;
  resultsVisibility: ResultsVisibility;
  minSelections: number;
  maxSelections: number;
  /** Ready-made instruction line, e.g. "Choose up to 3 options." */
  ballotRule: string;
  requiresCaptcha: boolean;
  options: PublicOption[];
};

export function toPublicOption(option: OptionRow): PublicOption {
  return {
    id: option.id,
    name: option.name,
    description: option.description,
    imageUrl: option.imageUrl,
  };
}

/**
 * @param voterId The identity voting in *this* event, when known. Pass it
 *   whenever one is available (the ballot page, the status API once an IGN is
 *   claimed) so `randomizeOptionOrder` can take effect. Omit it only where no
 *   voter is resolved yet - the event details page before any IGN is entered,
 *   for instance - where there is nothing to seed a stable order from anyway.
 */
export function toPublicEvent(
  event: EventWithOptions,
  now = new Date(),
  voterId: string | null = null,
): PublicEvent {
  const bounds = selectionBounds(event);
  const activeOptions = event.options.filter((option) => option.isActive);
  const orderedOptions =
    event.randomizeOptionOrder && voterId
      ? seededShuffle(activeOptions, hashBallotOrderSeed(event.id, voterId))
      : activeOptions;

  return {
    slug: event.slug,
    title: event.title,
    description: event.description,
    instructions: event.instructions,
    votingType: event.votingType,
    status: event.status,
    phase: votingPhase(event, now),
    startsAt: event.startsAt?.toISOString() ?? null,
    endsAt: event.endsAt?.toISOString() ?? null,
    resultsVisibility: event.resultsVisibility,
    minSelections: bounds.min,
    maxSelections: bounds.max,
    ballotRule: describeBallotRule(event, activeOptions.length),
    requiresCaptcha: event.requireCaptcha,
    // Deactivated options are dropped entirely rather than sent with a flag:
    // a client cannot render, or submit, what it never received.
    options: orderedOptions.map(toPublicOption),
  };
}

/** Summary card for the event list. No options, no ballot detail. */
export type PublicEventSummary = Pick<
  PublicEvent,
  'slug' | 'title' | 'description' | 'votingType' | 'status' | 'phase' | 'startsAt' | 'endsAt'
> & { optionCount: number };

export function toPublicEventSummary(
  event: EventWithOptions,
  now = new Date(),
): PublicEventSummary {
  return {
    slug: event.slug,
    title: event.title,
    description: event.description,
    votingType: event.votingType,
    status: event.status,
    phase: votingPhase(event, now),
    startsAt: event.startsAt?.toISOString() ?? null,
    endsAt: event.endsAt?.toISOString() ?? null,
    optionCount: event.options.filter((option) => option.isActive).length,
  };
}

/**
 * Results as a voter may see them.
 *
 * Integrity signals (flagged ballots, network concentration) and the
 * participation timeline are stripped: they are moderation tools, and exposing
 * them tells a would-be ballot-stuffer precisely which of their votes were
 * noticed.
 */
export type PublicResults = {
  totalBallots: number;
  distinctVoters: number;
  options: Array<{ id: string; name: string; votes: number; percent: number }>;
};

export function toPublicResults(results: EventResults): PublicResults {
  return {
    totalBallots: results.totalBallots,
    distinctVoters: results.distinctVoters,
    options: results.options.map((option) => ({
      id: option.optionId,
      name: option.name,
      votes: option.votes,
      percent: Number(option.percent.toFixed(2)),
    })),
  };
}

/**
 * The voter's own state for an event.
 *
 * `hasVoted` is computed on the server from the session cookie on every single
 * request. It is never cached, never stored in the cookie, and never accepted
 * from the client.
 */
export type PublicBallotState = {
  claimedName: string | null;
  hasVoted: boolean;
  receipt: { code: string; castAt: string; selections: string[] } | null;
  canSeeResults: boolean;
};
