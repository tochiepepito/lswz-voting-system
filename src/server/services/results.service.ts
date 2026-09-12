import { appError } from '@/lib/errors';
import { csvFilename, toCsv } from '@/lib/csv';
import { canPublicSeeResults, votingPhase } from '@/lib/voting-rules';
import { formatDateTimeUtc } from '@/lib/format';
import type { ExportFormat } from '@/schemas/event';
import type { EventStatus, VotingType } from '@/types/domain';
import {
  listEventsForStats,
  type EventWithOptions,
} from '../repositories/event.repository';
import { countBlockedVoters, countVotersWithBallots } from '../repositories/voter.repository';
import {
  countDistinctVoters,
  countInvalidatedVotes,
  countSuspiciousVotes,
  countValidVotes,
  listBallotsForExport,
  listVotesForAdmin,
  participationOverTime,
  tallyByOption,
  voteHistoryForVoters,
  voteStatsByEvent,
  votesPerIpHash,
  type ParticipationPoint,
} from '../repositories/vote.repository';

/**
 * ResultsService
 *
 * Computes every number shown on a results screen, and decides who is allowed
 * to see it.
 *
 * PERCENTAGES. Every percentage is a share of BALLOTS, never a share of
 * selections. In a multiple-choice event one ballot can pick three options, so
 * the selection counts legitimately sum to more than the ballot count, and
 * dividing by that sum would report a smaller number for every option than the
 * fraction of voters who actually chose it. "62% of voters picked Rule A" is the
 * statement an organiser needs; "23% of all selections were Rule A" is not.
 */

export type OptionResult = {
  optionId: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  isActive: boolean;
  votes: number;
  /** Share of counted ballots that included this option, 0-100. */
  percent: number;
};

export type EventResults = {
  eventId: string;
  title: string;
  totalBallots: number;
  totalSelections: number;
  distinctVoters: number;
  options: OptionResult[];
  /** Present only for administrators. */
  integrity?: {
    suspiciousVotes: number;
    invalidatedVotes: number;
    heavyNetworks: Array<{ ipHash: string; votes: number }>;
  };
  participation?: ParticipationPoint[];
};

function computeOptionResults(
  event: EventWithOptions,
  tally: Array<{ optionId: string; votes: number }>,
  totalBallots: number,
): OptionResult[] {
  const byOption = new Map(tally.map((row) => [row.optionId, row.votes]));

  return event.options
    .map((option) => {
      const votes = byOption.get(option.id) ?? 0;

      return {
        optionId: option.id,
        name: option.name,
        description: option.description,
        imageUrl: option.imageUrl,
        isActive: option.isActive,
        votes,
        percent: totalBallots > 0 ? (votes / totalBallots) * 100 : 0,
      };
    })
    .sort((a, b) => b.votes - a.votes || a.name.localeCompare(b.name));
}

/** Hourly buckets for short events, daily for long ones. */
function granularityFor(event: EventWithOptions): 'hour' | 'day' {
  const start = event.startsAt ?? event.createdAt;
  const end = event.endsAt ?? new Date();
  const hours = (end.getTime() - start.getTime()) / 3_600_000;

  return hours <= 72 ? 'hour' : 'day';
}

/** Core tally, with no visibility check. Callers must do that first. */
async function computeResults(
  event: EventWithOptions,
  options: { includeIntegrity: boolean; includeParticipation: boolean },
): Promise<EventResults> {
  const [tally, totalBallots, distinctVoters] = await Promise.all([
    tallyByOption(event.id),
    countValidVotes(event.id),
    countDistinctVoters(event.id),
  ]);

  const results: EventResults = {
    eventId: event.id,
    title: event.title,
    totalBallots,
    totalSelections: tally.reduce((sum, row) => sum + row.votes, 0),
    distinctVoters,
    options: computeOptionResults(event, tally, totalBallots),
  };

  if (options.includeParticipation) {
    results.participation = await participationOverTime(event.id, granularityFor(event));
  }

  if (options.includeIntegrity) {
    const [suspiciousVotes, invalidatedVotes, heavyNetworks] = await Promise.all([
      countSuspiciousVotes(event.id),
      countInvalidatedVotes(event.id),
      votesPerIpHash(event.id, Math.max(2, event.ipSoftLimit)),
    ]);

    results.integrity = { suspiciousVotes, invalidatedVotes, heavyNetworks };
  }

  return results;
}

/**
 * Results for a public viewer.
 *
 * Throws RESULTS_NOT_AVAILABLE unless the event's configured visibility permits
 * it right now. `hasVoted` is resolved server-side by the caller from the
 * session cookie - never accepted from the client, which would make
 * "visible after voting" a single fetch away from meaningless.
 */
export async function getPublicResults(
  event: EventWithOptions,
  hasVoted: boolean,
): Promise<EventResults> {
  const allowed = canPublicSeeResults({
    resultsVisibility: event.resultsVisibility,
    event,
    hasVoted,
  });

  if (!allowed) throw appError('RESULTS_NOT_AVAILABLE');

  return computeResults(event, { includeIntegrity: false, includeParticipation: false });
}

/** Whether a public viewer may see results, without computing them. */
export function isPublicResultsVisible(event: EventWithOptions, hasVoted: boolean): boolean {
  return canPublicSeeResults({
    resultsVisibility: event.resultsVisibility,
    event,
    hasVoted,
  });
}

/** Full results, including integrity signals. Administrators only. */
export async function getAdminResults(event: EventWithOptions): Promise<EventResults> {
  return computeResults(event, { includeIntegrity: true, includeParticipation: true });
}

export type ParticipationStats = {
  totalBallots: number;
  distinctVoters: number;
  suspiciousVotes: number;
  invalidatedVotes: number;
  phase: ReturnType<typeof votingPhase>;
};

export async function participationStats(event: EventWithOptions): Promise<ParticipationStats> {
  const [totalBallots, distinctVoters, suspiciousVotes, invalidatedVotes] = await Promise.all([
    countValidVotes(event.id),
    countDistinctVoters(event.id),
    countSuspiciousVotes(event.id),
    countInvalidatedVotes(event.id),
  ]);

  return {
    totalBallots,
    distinctVoters,
    suspiciousVotes,
    invalidatedVotes,
    phase: votingPhase(event),
  };
}

/**
 * Individual ballots for the moderation table.
 *
 * Administrators only: this is the one view that pairs an in-game name with the
 * options it chose, and it exists so a human can judge a flagged ballot. It is
 * never reachable from any public presenter.
 */
export async function listBallots(
  eventId: string,
  filters: { suspiciousOnly?: boolean; invalidatedOnly?: boolean; search?: string },
  pagination: { page: number; pageSize: number },
) {
  return listVotesForAdmin(eventId, filters, pagination);
}

// --------------------------------------------------------------------------
// Cross-event participation
// --------------------------------------------------------------------------

export type EventParticipationRow = {
  eventId: string;
  title: string;
  slug: string;
  status: EventStatus;
  votingType: VotingType;
  endsAt: Date | null;
  counted: number;
  invalidated: number;
  flagged: number;
  distinctSessions: number;
  lastBallotAt: Date | null;
  /** Counted ballots as a share of the busiest event, 0-100. For the bars. */
  relativeShare: number;
};

export type ParticipationOverview = {
  rows: EventParticipationRow[];
  totals: {
    /** Distinct identities that have ever cast a counted ballot anywhere. */
    knownVoters: number;
    blockedVoters: number;
    countedBallots: number;
    flaggedBallots: number;
    invalidatedBallots: number;
    eventsWithVotes: number;
  };
};

/**
 * Voting statistics broken down by event, for the Voters dashboard.
 *
 * Answers the question that page is really about: who is turning out, and where.
 * Events that have never received a ballot are included with zeros, because
 * "nobody voted in this one" is itself the finding an organiser needs.
 *
 * Note there is no "unique voters" column. `votes` is unique on
 * (eventId, voterId), so unique voters is always exactly the counted-ballot
 * figure; showing both would be the same number twice.
 */
export async function participationByEvent(): Promise<ParticipationOverview> {
  const [stats, events, knownVoters, blockedVoters] = await Promise.all([
    voteStatsByEvent(),
    listEventsForStats(),
    countVotersWithBallots(),
    countBlockedVoters(),
  ]);

  const statsByEvent = new Map(stats.map((row) => [row.eventId, row]));
  const busiest = Math.max(1, ...stats.map((row) => row.counted));

  const rows: EventParticipationRow[] = events
    .map((event) => {
      const stat = statsByEvent.get(event.id);

      return {
        eventId: event.id,
        title: event.title,
        slug: event.slug,
        status: event.status as EventStatus,
        votingType: event.votingType as VotingType,
        endsAt: event.endsAt,
        counted: stat?.counted ?? 0,
        invalidated: stat?.invalidated ?? 0,
        flagged: stat?.flagged ?? 0,
        distinctSessions: stat?.distinctSessions ?? 0,
        lastBallotAt: stat?.lastBallotAt ?? null,
        relativeShare: ((stat?.counted ?? 0) / busiest) * 100,
      };
    })
    // Busiest first: the elections with real turnout are what an organiser
    // opens this page to look at.
    .sort((a, b) => b.counted - a.counted || a.title.localeCompare(b.title));

  return {
    rows,
    totals: {
      knownVoters,
      blockedVoters,
      countedBallots: stats.reduce((sum, row) => sum + row.counted, 0),
      flaggedBallots: stats.reduce((sum, row) => sum + row.flagged, 0),
      invalidatedBallots: stats.reduce((sum, row) => sum + row.invalidated, 0),
      eventsWithVotes: stats.filter((row) => row.counted > 0).length,
    },
  };
}

/** Per-voter event participation, for the rows currently on screen. */
export async function participationForVoters(voterIds: readonly string[]) {
  const history = await voteHistoryForVoters(voterIds);

  const byVoter = new Map<string, typeof history>();
  for (const entry of history) {
    const existing = byVoter.get(entry.voterId);
    if (existing) existing.push(entry);
    else byVoter.set(entry.voterId, [entry]);
  }

  return byVoter;
}

// --------------------------------------------------------------------------
// Export
// --------------------------------------------------------------------------

export type CsvExport = { filename: string; content: string };

/**
 * Build a CSV export.
 *
 * Three shapes, because organisers need different things:
 *   summary      - one row per option. What gets pasted into a Discord announcement.
 *   ballots      - one row per ballot, with the IGN. The audit artefact.
 *   participants - one row per distinct IGN. The turnout list.
 *
 * All cell escaping, including spreadsheet formula neutralisation, happens in
 * `lib/csv.ts`.
 */
export async function exportResults(
  event: EventWithOptions,
  format: ExportFormat,
): Promise<CsvExport> {
  if (format === 'summary') {
    const results = await computeResults(event, {
      includeIntegrity: false,
      includeParticipation: false,
    });

    return {
      filename: csvFilename(`${event.slug}-summary`),
      content: toCsv(
        ['Option', 'Votes', 'Share of ballots (%)', 'Active'],
        results.options.map((option) => [
          option.name,
          option.votes,
          option.percent.toFixed(2),
          option.isActive,
        ]),
      ),
    };
  }

  const ballots = await listBallotsForExport(event.id);

  if (format === 'ballots') {
    return {
      filename: csvFilename(`${event.slug}-ballots`),
      content: toCsv(
        [
          'Receipt code',
          'In-game name',
          'Cast at (UTC)',
          'Status',
          'Selections',
          'Flagged',
          'Flag reasons',
          'Identity method',
        ],
        ballots.map((ballot) => [
          ballot.receiptCode,
          ballot.displayName,
          formatDateTimeUtc(ballot.castAt),
          ballot.status,
          ballot.selections.map((selection) => selection.name).join(' | '),
          ballot.isSuspicious,
          ballot.suspicionReasons.join(' | '),
          ballot.identityMethod,
        ]),
      ),
    };
  }

  // participants
  const seen = new Map<string, { name: string; castAt: Date; counted: boolean }>();
  for (const ballot of ballots) {
    if (!seen.has(ballot.displayName.toLowerCase())) {
      seen.set(ballot.displayName.toLowerCase(), {
        name: ballot.displayName,
        castAt: ballot.castAt,
        counted: ballot.status === 'VALID',
      });
    }
  }

  return {
    filename: csvFilename(`${event.slug}-participants`),
    content: toCsv(
      ['In-game name', 'First ballot (UTC)', 'Counted'],
      Array.from(seen.values()).map((participant) => [
        participant.name,
        formatDateTimeUtc(participant.castAt),
        participant.counted,
      ]),
    ),
  };
}
