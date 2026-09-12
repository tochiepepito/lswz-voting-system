import { appError, isAppError } from '@/lib/errors';
import { generateReceiptCode } from '@/lib/crypto';
import type { RequestContext } from '@/lib/http';
import { isUniqueViolationOn, prisma } from '@/lib/prisma';
import { assertVotingOpen, validateSelections } from '@/lib/voting-rules';
import {
  findEventCoreById,
  findSelectableOptionIds,
  type EventCore,
} from '../repositories/event.repository';
import {
  findConfusableSiblingsInEvent,
  incrementSessionCounters,
  type VoterRow,
} from '../repositories/voter.repository';
import {
  countVotesByIp,
  countVotesBySession,
  createVoteWithSelections,
  deleteVote,
  findVoteByEventAndVoter,
  findVoteDetail,
  invalidateVote as invalidateVoteRow,
  restoreVote as restoreVoteRow,
} from '../repositories/vote.repository';
import * as AuditService from './audit.service';
import * as CaptchaService from './captcha.service';
import * as RateLimitService from './rate-limit.service';
import * as VoterService from './voter.service';

/**
 * VotingService
 *
 * The one place a ballot can be cast. Everything the browser sent is treated as
 * a suggestion: the event, its status, its schedule, the selectable options,
 * the voter's identity and whether they have already voted are all re-read from
 * the database inside the transaction that writes the vote.
 *
 * THE ORDER OF CHECKS (and why)
 *
 *   1. event exists, is open            - cheap, and rejects most bad requests
 *   2. session + claim resolved         - establishes *who*, server-side only
 *   3. voter / session block checks     - moderator decisions outrank everything
 *   4. rate limits                      - before any expensive work
 *   5. captcha                          - network call, so last of the pre-checks
 *   6. TRANSACTION
 *        re-read event and re-assert    - the event may have closed in step 5
 *        read selectable options        - from rows, never from the request
 *        validate the selection         - min/max/duplicates/membership
 *        has this identity voted?       - before the browser limit, so the
 *                                         voter gets the accurate message
 *        per-browser vote limit         - catches a DIFFERENT name, same device
 *        compute suspicion signals
 *        INSERT vote + selections       - one atomic statement group
 *        INSERT audit row               - inside the same transaction
 *
 * If the insert violates `votes(eventId, voterId)`, the identity has already
 * voted. That constraint - not any check above it - is the actual guarantee.
 * Two simultaneous submissions both pass every application check; exactly one
 * survives the INSERT.
 *
 * AUDIT ROWS AND ROLLBACK. A successful ballot writes its audit row inside the
 * transaction, so a vote that cannot be recorded is not a vote. A REFUSED
 * ballot must do the opposite and write from the catch block: the throw that
 * refuses it would roll back the record of the refusal, leaving the security
 * dashboard silently under-reporting every block.
 */

export type SubmitVoteParams = {
  event: EventCore;
  optionIds: readonly string[];
  context: RequestContext;
  captchaToken?: string | undefined;
};

export type VoteReceipt = {
  receiptCode: string;
  displayName: string;
  castAt: Date;
  optionNames: string[];
};

/** Reasons a stored vote can carry. Rendered to admins, never to voters. */
export const SUSPICION_REASONS = {
  IP_SOFT_LIMIT: 'Many votes from the same network',
  CONFUSABLE_NAME: 'Name closely resembles another voter in this event',
  SHARED_BROWSER: 'More than one ballot cast from this browser',
  IMMEDIATE_SUBMISSION: 'Ballot submitted unusually quickly after arriving',
} as const;

export type SuspicionReason = keyof typeof SUSPICION_REASONS;

/** A ballot submitted under this many milliseconds after the session was born. */
const FAST_SUBMISSION_MS = 2500;

export async function submitVote(params: SubmitVoteParams): Promise<VoteReceipt> {
  const { event, optionIds, context, captchaToken } = params;

  // --- 1. Event must be open, by the clock and by its status. ---
  assertVotingOpen(event);

  // --- 2. Who is this, according to the server? ---
  const resolved = await VoterService.requireActiveSession();
  const claim = await VoterService.getClaim(event.id, resolved.session.id);

  if (!claim) throw appError('SESSION_REQUIRED');

  const voter: VoterRow = claim.voter;

  // --- 3. Moderator decisions. ---
  if (voter.isBlocked) throw appError('VOTER_BLOCKED');

  // --- 4. Rate limits, cheapest identifier first. ---
  await RateLimitService.enforce('VOTE_SESSION', resolved.session.id, {
    summary: `Too many vote submissions from one browser in "${event.title}".`,
    eventId: event.id,
    voterId: voter.id,
    sessionId: resolved.session.id,
    ipHash: context.ipHash,
    userAgentHash: context.userAgentHash,
  });

  await RateLimitService.enforce('VOTE_IP', context.ip, {
    summary: `Too many vote submissions from one address in "${event.title}".`,
    eventId: event.id,
    voterId: voter.id,
    sessionId: resolved.session.id,
    ipHash: context.ipHash,
    userAgentHash: context.userAgentHash,
  });

  // --- 5. Human check, when the event asks for one. ---
  const captcha = await CaptchaService.enforce(event, captchaToken, context.ip);

  // --- 6. The transaction. ---
  const receipt = await castBallot({
    event,
    voter,
    sessionId: resolved.session.id,
    sessionCreatedAt: resolved.session.createdAt,
    optionIds,
    context,
    captchaFailedOpen: captcha.failedOpen,
  });

  await incrementSessionCounters(resolved.session.id, { votes: 1 }).catch(() => undefined);

  if (RateLimitService.shouldPrune()) {
    void RateLimitService.pruneExpired().catch(() => undefined);
  }

  return receipt;
}

type CastBallotParams = {
  event: EventCore;
  voter: VoterRow;
  sessionId: string;
  sessionCreatedAt: Date;
  optionIds: readonly string[];
  context: RequestContext;
  captchaFailedOpen: boolean;
};

async function castBallot(params: CastBallotParams): Promise<VoteReceipt> {
  const { event, voter, sessionId, optionIds, context } = params;

  // A receipt-code collision is astronomically unlikely (60 bits), but it is a
  // unique column, so the insert is retried rather than surfacing as an error
  // the voter cannot act on.
  const MAX_ATTEMPTS = 3;

  /*
   * Detail captured inside the transaction for an audit row written after it
   * rolls back.
   *
   * Anything a refusal needs to record has to survive the rollback, so it is
   * carried out here rather than written to the database inside the failing
   * transaction - where it would be discarded along with everything else.
   */
  let sessionLimitDetail: { existingVotes: number; limit: number } | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        // Re-read the event *inside* the transaction. Between the check at the
        // top of submitVote and here, an administrator may have closed voting,
        // or the end time may simply have passed.
        const current = await findEventCoreById(event.id, tx);
        if (!current) throw appError('EVENT_NOT_FOUND');
        assertVotingOpen(current);

        // Selectable options come from rows scoped to THIS event. This is what
        // makes it impossible to vote for another event's option by id.
        const selectableIds = await findSelectableOptionIds(current.id, tx);
        const selections = validateSelections(current, optionIds, selectableIds);

        /*
         * Has THIS identity already voted here?
         *
         * The INSERT below would fail on the unique constraint anyway, so this
         * changes no outcome - but it must come BEFORE the per-browser limit, or
         * a voter pressing submit twice in one browser is told "a vote was
         * already cast from this browser" when the accurate and far more useful
         * answer is "you have already voted". The browser limit exists to catch a
         * *different* name voting from the same device.
         *
         * Any status counts: an invalidated ballot still occupies the slot.
         */
        const existingBallot = await findVoteByEventAndVoter(current.id, voter.id, tx);
        if (existingBallot) throw appError('ALREADY_VOTED');

        // Per-browser ballot limit (configurable per event; 1 by default).
        //
        // The audit row for a refusal is NOT written here: throwing rolls the
        // transaction back, which would destroy it. It is written from the catch
        // block below, outside the transaction, exactly like the duplicate case.
        const votesFromThisBrowser = await countVotesBySession(current.id, sessionId, tx);
        if (votesFromThisBrowser >= current.maxVotesPerSession) {
          // Captured for the audit row the catch block writes after rollback.
          sessionLimitDetail = {
            existingVotes: votesFromThisBrowser,
            limit: current.maxVotesPerSession,
          };
          throw appError('SESSION_VOTE_LIMIT');
        }

        const suspicion = await evaluateSuspicion({ ...params, event: current, tx });

        const vote = await createVoteWithSelections(
          {
            eventId: current.id,
            voterId: voter.id,
            sessionId,
            identityMethod: 'IGN_SELF_DECLARED',
            receiptCode: generateReceiptCode(),
            ipHash: context.ipHash,
            userAgentHash: context.userAgentHash,
            isSuspicious: suspicion.reasons.length > 0,
            suspicionReasons: suspicion.reasons,
            optionIds: selections,
          },
          tx,
        );

        // Audit inside the transaction: a vote that could not be recorded in
        // the audit trail is rolled back rather than kept silently.
        await AuditService.write(
          {
            action: 'VOTE_SUBMITTED',
            actorType: 'VOTER',
            actorLabel: voter.displayName,
            eventId: current.id,
            voterId: voter.id,
            voterSessionId: sessionId,
            ipHash: context.ipHash,
            userAgentHash: context.userAgentHash,
            summary: `"${voter.displayName}" voted in "${current.title}".`,
            metadata: {
              receiptCode: vote.receiptCode,
              selectionCount: selections.length,
              suspicious: suspicion.reasons.length > 0,
              suspicionReasons: suspicion.reasons,
              captchaFailedOpen: params.captchaFailedOpen,
            },
          },
          tx,
        );

        if (suspicion.reasons.length > 0) {
          await AuditService.write(
            {
              action: 'VOTE_FLAGGED_SUSPICIOUS',
              actorType: 'SYSTEM',
              eventId: current.id,
              voterId: voter.id,
              voterSessionId: sessionId,
              ipHash: context.ipHash,
              summary: `A ballot in "${current.title}" was flagged for review.`,
              metadata: { reasons: suspicion.reasons, detail: suspicion.detail },
            },
            tx,
          );
        }

        const optionNames = await tx.votingOption.findMany({
          where: { id: { in: selections } },
          select: { name: true },
          orderBy: { displayOrder: 'asc' },
        });

        return {
          receiptCode: vote.receiptCode,
          displayName: voter.displayName,
          castAt: vote.castAt,
          optionNames: optionNames.map((option) => option.name),
        };
      });
    } catch (error) {
      /*
       * Every audit row for a REFUSED ballot is written here, outside the
       * transaction. Writing one inside would be pointless: the throw that
       * refuses the ballot also rolls back the record of the refusal, so the
       * security dashboard would silently under-report every block.
       */

      // The duplicate-vote guarantee. Reached either by the fast-path check
      // inside the transaction or - under a genuine race, where both requests
      // passed that check - by MySQL rejecting the second INSERT.
      const isDuplicate =
        isUniqueViolationOn(error, 'eventId', 'voterId') ||
        (isAppError(error) && error.code === 'ALREADY_VOTED');

      if (isDuplicate) {
        await AuditService.recordVoterAction({
          action: 'VOTE_DUPLICATE_BLOCKED',
          summary: `A second ballot for "${voter.displayName}" in "${event.title}" was refused.`,
          eventId: event.id,
          voterId: voter.id,
          sessionId,
          voterLabel: voter.displayName,
          context,
        });

        throw appError('ALREADY_VOTED');
      }

      if (isAppError(error) && error.code === 'SESSION_VOTE_LIMIT') {
        await AuditService.recordVoterAction({
          action: 'VOTE_SESSION_LIMIT_BLOCKED',
          summary: `A further ballot from a browser that already voted in "${event.title}" was refused.`,
          eventId: event.id,
          voterId: voter.id,
          sessionId,
          voterLabel: voter.displayName,
          context,
          ...(sessionLimitDetail ? { metadata: sessionLimitDetail } : {}),
        });

        throw error;
      }

      if (isUniqueViolationOn(error, 'receiptCode') && attempt < MAX_ATTEMPTS) {
        continue;
      }

      throw error;
    }
  }

  // Unreachable: the loop either returns or throws.
  throw appError('INTERNAL');
}

type SuspicionOutcome = {
  reasons: SuspicionReason[];
  /** JSON-safe by construction, because it is written straight into audit metadata. */
  detail: Record<string, string | number | string[]>;
};

/**
 * Score a ballot for review. Never blocks - every signal here has a legitimate
 * explanation, and an election that silently drops real votes is worse than one
 * that flags a few honest ones for a moderator to clear.
 */
async function evaluateSuspicion(
  params: CastBallotParams & { tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0] },
): Promise<SuspicionOutcome> {
  const { event, voter, sessionId, sessionCreatedAt, context, tx } = params;

  const reasons: SuspicionReason[] = [];
  const detail: Record<string, string | number | string[]> = {};

  if (context.ipHash && event.ipSoftLimit > 0) {
    const votesFromIp = await countVotesByIp(event.id, context.ipHash, tx);
    if (votesFromIp >= event.ipSoftLimit) {
      reasons.push('IP_SOFT_LIMIT');
      detail['votesFromSameNetwork'] = votesFromIp;
    }
  }

  const siblings = await findConfusableSiblingsInEvent(
    event.id,
    voter.confusableKey,
    voter.id,
    tx,
  );
  if (siblings.length > 0) {
    reasons.push('CONFUSABLE_NAME');
    detail['similarNames'] = siblings.map((sibling) => sibling.displayName);
  }

  const votesFromBrowser = await countVotesBySession(event.id, sessionId, tx);
  if (votesFromBrowser > 0) {
    reasons.push('SHARED_BROWSER');
    detail['previousVotesFromBrowser'] = votesFromBrowser;
  }

  if (Date.now() - sessionCreatedAt.getTime() < FAST_SUBMISSION_MS) {
    reasons.push('IMMEDIATE_SUBMISSION');
  }

  return { reasons, detail };
}

// --------------------------------------------------------------------------
// Voter-facing reads
// --------------------------------------------------------------------------

/**
 * Whether the identity claimed by this browser has already voted.
 *
 * The server answers this, always. The client is never trusted with it, and the
 * ballot page calls this on every render rather than caching it.
 */
export async function hasVoted(eventId: string, voterId: string): Promise<boolean> {
  const vote = await findVoteByEventAndVoter(eventId, voterId);
  return vote !== null && vote.status === 'VALID';
}

/** Receipt for the confirmation screen. Returns null when no ballot exists. */
export async function getReceiptForSession(
  eventId: string,
  sessionId: string,
): Promise<VoteReceipt | null> {
  const claim = await VoterService.getClaim(eventId, sessionId);
  if (!claim) return null;

  const vote = await findVoteByEventAndVoter(eventId, claim.voterId);
  if (!vote) return null;

  const detail = await findVoteDetail(vote.id);
  if (!detail) return null;

  return {
    receiptCode: detail.receiptCode,
    displayName: detail.voter.displayName,
    castAt: detail.castAt,
    optionNames: detail.selections.map((selection) => selection.option.name),
  };
}

// --------------------------------------------------------------------------
// Moderation
// --------------------------------------------------------------------------

/**
 * Exclude a vote from every tally while keeping the row.
 * Reversible, and the preferred action: it destroys nothing.
 */
export async function invalidate(params: {
  voteId: string;
  adminId: string;
  adminLabel: string;
  reason: string;
  context: RequestContext;
}): Promise<void> {
  const detail = await findVoteDetail(params.voteId);
  if (!detail) throw appError('NOT_FOUND');

  const updated = await invalidateVoteRow(params.voteId, params.adminId, params.reason, new Date());
  if (updated === 0) throw appError('CONFLICT', { message: 'That vote is already invalidated.' });

  await AuditService.recordAdminAction({
    action: 'VOTE_INVALIDATED',
    summary: `A ballot by "${detail.voter.displayName}" in "${detail.event.title}" was invalidated.`,
    adminId: params.adminId,
    adminLabel: params.adminLabel,
    eventId: detail.event.id,
    voterId: detail.voter.id,
    context: params.context,
    metadata: { receiptCode: detail.receiptCode, reason: params.reason },
  });
}

export async function restore(params: {
  voteId: string;
  adminId: string;
  adminLabel: string;
  context: RequestContext;
}): Promise<void> {
  const detail = await findVoteDetail(params.voteId);
  if (!detail) throw appError('NOT_FOUND');

  const updated = await restoreVoteRow(params.voteId);
  if (updated === 0) throw appError('CONFLICT', { message: 'That vote is already counted.' });

  await AuditService.recordAdminAction({
    action: 'VOTE_RESTORED',
    summary: `A ballot by "${detail.voter.displayName}" in "${detail.event.title}" was restored.`,
    adminId: params.adminId,
    adminLabel: params.adminLabel,
    eventId: detail.event.id,
    voterId: detail.voter.id,
    context: params.context,
    metadata: { receiptCode: detail.receiptCode },
  });
}

/**
 * Delete a ballot so its owner can vote again.
 *
 * The full content of the ballot is written to the audit log first, inside the
 * same transaction as the delete, so the history survives even though the row
 * does not. This is the only operation in the system that removes a vote, and it
 * exists because `votes(eventId, voterId)` is a plain unique constraint: an
 * invalidated row still occupies the slot.
 */
export async function voidForRevote(params: {
  voteId: string;
  adminId: string;
  adminLabel: string;
  reason: string;
  context: RequestContext;
}): Promise<void> {
  const detail = await findVoteDetail(params.voteId);
  if (!detail) throw appError('NOT_FOUND');

  await prisma.$transaction(async (tx) => {
    await AuditService.write(
      {
        action: 'VOTE_VOIDED_FOR_REVOTE',
        actorType: 'ADMIN',
        actorLabel: params.adminLabel,
        adminId: params.adminId,
        eventId: detail.event.id,
        voterId: detail.voter.id,
        ipHash: params.context.ipHash,
        summary: `A ballot by "${detail.voter.displayName}" in "${detail.event.title}" was voided so they can vote again.`,
        metadata: {
          receiptCode: detail.receiptCode,
          reason: params.reason,
          castAt: detail.castAt.toISOString(),
          // The ballot itself, preserved before the row is removed.
          selections: detail.selections.map((selection) => selection.option.name),
          wasSuspicious: detail.isSuspicious,
          suspicionReasons: detail.suspicionReasons,
        },
      },
      tx,
    );

    await deleteVote(params.voteId, tx);
  });
}
