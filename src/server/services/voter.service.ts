import { env } from '@/lib/env';
import { appError } from '@/lib/errors';
import { generateToken, hashNormalizedIgn, hashSessionToken } from '@/lib/crypto';
import {
  clearVoterSessionToken,
  deriveCsrfToken,
  readVoterSessionToken,
  writeVoterSessionToken,
} from '@/lib/cookies';
import type { RequestContext } from '@/lib/http';
import { IGN_REJECTION_MESSAGES, normalizeIgn } from '@/lib/ign';
import { prisma, type DbClient } from '@/lib/prisma';
import { assertVotingOpen } from '@/lib/voting-rules';
import type { EventCore } from '../repositories/event.repository';
import {
  countDistinctClaimedVoters,
  countSessionsClaimingVoter,
  createVoterSession,
  findClaim,
  findVoterSessionByTokenHash,
  incrementSessionCounters,
  listVotersForAdmin,
  setVoterBlocked,
  setVoterSessionBlocked,
  touchVoterSession,
  upsertClaim,
  upsertVoter,
  type VoterRow,
  type VoterSessionRow,
} from '../repositories/voter.repository';
import { findVoteByEventAndVoter } from '../repositories/vote.repository';
import * as AuditService from './audit.service';
import * as CaptchaService from './captcha.service';
import * as RateLimitService from './rate-limit.service';

/**
 * VoterService
 *
 * Owns the login-free identity model:
 *
 *   1. A browser gets an opaque, HTTP-only session cookie the first time it
 *      does anything. The cookie is a random token and nothing else - no IGN,
 *      no event, no "has voted" flag. Everything is looked up server-side.
 *
 *   2. Entering an IGN creates an EventIdentityClaim binding that session to a
 *      normalised identity, FOR ONE EVENT. Re-entering a different name before
 *      voting replaces the claim and is recorded in the audit log.
 *
 *   3. The claim carries an `identityMethod`. Today it is always
 *      IGN_SELF_DECLARED. Adding Discord or game-account verification later
 *      means issuing a claim with a different method - the vote path, the
 *      tallies and the audit trail are untouched.
 *
 * WHAT THIS IS NOT: authentication. An IGN is a name a player types, and any
 * player can type someone else's. See `docs/SECURITY.md`.
 */

export type ResolvedVoterSession = {
  session: VoterSessionRow;
  /** Raw cookie token. Needed to derive the CSRF token; never rendered. */
  token: string;
  csrfToken: string;
};

const SESSION_TTL_MS = env.VOTER_SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;

/**
 * Load the session named by the request cookie.
 *
 * Returns null for a missing, unknown or expired cookie - all three are the
 * same thing from the voter's point of view (they need to enter their name
 * again) and distinguishing them would leak whether a token ever existed.
 */
export async function readSession(): Promise<ResolvedVoterSession | null> {
  const token = await readVoterSessionToken();
  if (!token) return null;

  const session = await findVoterSessionByTokenHash(hashSessionToken(token));
  if (!session) return null;

  if (session.expiresAt <= new Date()) return null;

  return { session, token, csrfToken: deriveCsrfToken(token) };
}

/** Load a session and refuse if it has been blocked by a moderator. */
export async function requireActiveSession(): Promise<ResolvedVoterSession> {
  const resolved = await readSession();
  if (!resolved) throw appError('SESSION_REQUIRED');
  if (resolved.session.isBlocked) throw appError('SESSION_BLOCKED');

  return resolved;
}

/**
 * Return the caller's session, creating one if necessary.
 *
 * Only callable from a Server Action or Route Handler, because it writes a
 * cookie. Server Components read with `readSession()` instead.
 */
export async function ensureSession(
  context: RequestContext,
  db: DbClient = prisma,
): Promise<ResolvedVoterSession & { created: boolean }> {
  const existing = await readSession();

  if (existing) {
    if (existing.session.isBlocked) throw appError('SESSION_BLOCKED');

    // Cheap liveness stamp; failure here must not break a vote.
    await touchVoterSession(existing.session.id, new Date(), db).catch(() => undefined);

    return { ...existing, created: false };
  }

  const token = generateToken(32);
  const session = await createVoterSession(
    {
      tokenHash: hashSessionToken(token),
      ipHash: context.ipHash,
      userAgentHash: context.userAgentHash,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    },
    db,
  );

  await writeVoterSessionToken(token);

  await AuditService.recordVoterAction(
    {
      action: 'VOTER_SESSION_CREATED',
      summary: 'A new anonymous voting session was created.',
      sessionId: session.id,
      context,
    },
    db,
  );

  return { session, token, csrfToken: deriveCsrfToken(token), created: true };
}

/** Drop the cookie. Used when a session turns out to be unusable. */
export async function forgetSession(): Promise<void> {
  await clearVoterSessionToken();
}

// --------------------------------------------------------------------------
// Identity claims
// --------------------------------------------------------------------------

export type ClaimResult = {
  voter: VoterRow;
  session: VoterSessionRow;
  csrfToken: string;
  /** True when this identity has already cast a ballot in this event. */
  alreadyVoted: boolean;
};

/**
 * Step 2 of the voter flow: bind an IGN to this browser for one event.
 *
 * Ordering matters and is deliberate:
 *   rate limit -> normalise -> captcha -> session -> block checks -> claim
 *
 * The rate limit comes first so a script cannot use the endpoint to probe which
 * IGNs exist. The block checks come after normalisation so a blocked player
 * cannot slip through by changing capitalisation.
 */
export async function claimIdentity(params: {
  event: EventCore;
  rawIgn: unknown;
  context: RequestContext;
  captchaToken?: string | undefined;
}): Promise<ClaimResult> {
  const { event, rawIgn, context, captchaToken } = params;

  assertVotingOpen(event);

  await RateLimitService.enforce('CLAIM_IP', context.ip, {
    summary: 'Too many in-game name submissions from one address.',
    eventId: event.id,
    ipHash: context.ipHash,
    userAgentHash: context.userAgentHash,
  });

  const normalization = normalizeIgn(rawIgn);
  if (!normalization.ok) {
    throw appError(normalization.reason === 'EMPTY' ? 'IGN_REQUIRED' : 'IGN_INVALID', {
      message: IGN_REJECTION_MESSAGES[normalization.reason],
      fieldErrors: { ign: [IGN_REJECTION_MESSAGES[normalization.reason]] },
    });
  }

  const { displayName, normalizedName, confusableKey } = normalization.value;

  const captcha = await CaptchaService.enforce(event, captchaToken, context.ip);

  const resolved = await ensureSession(context);
  const now = new Date();

  const voter = await upsertVoter(
    { displayName, normalizedName, nameHash: hashNormalizedIgn(normalizedName), confusableKey },
    now,
  );

  if (voter.isBlocked) {
    await AuditService.recordVoterAction({
      action: 'VOTE_REJECTED',
      summary: `A blocked in-game name attempted to join "${event.title}".`,
      eventId: event.id,
      voterId: voter.id,
      sessionId: resolved.session.id,
      voterLabel: voter.displayName,
      context,
    });

    throw appError('VOTER_BLOCKED');
  }

  await upsertClaim({
    eventId: event.id,
    sessionId: resolved.session.id,
    voterId: voter.id,
    identityMethod: 'IGN_SELF_DECLARED',
  });

  await incrementSessionCounters(resolved.session.id, { claims: 1 }).catch(() => undefined);

  await AuditService.recordVoterAction({
    action: 'VOTER_IDENTITY_CLAIMED',
    summary: `"${displayName}" joined "${event.title}".`,
    eventId: event.id,
    voterId: voter.id,
    sessionId: resolved.session.id,
    voterLabel: displayName,
    context,
    metadata: { captchaFailedOpen: captcha.failedOpen },
  });

  await flagIdentityAnomalies({
    event,
    voter,
    sessionId: resolved.session.id,
    context,
  });

  const existingVote = await findVoteByEventAndVoter(event.id, voter.id);

  return {
    voter,
    session: resolved.session,
    csrfToken: resolved.csrfToken,
    alreadyVoted: existingVote !== null && existingVote.status === 'VALID',
  };
}

/**
 * Heuristics that produce a moderator signal, never a block.
 *
 * Both patterns here have entirely innocent explanations - a shared family PC,
 * two siblings in the same guild - so automatically refusing them would
 * disenfranchise real players. They are recorded for a human to judge.
 */
async function flagIdentityAnomalies(params: {
  event: EventCore;
  voter: VoterRow;
  sessionId: string;
  context: RequestContext;
}): Promise<void> {
  const { event, voter, sessionId, context } = params;

  const [namesFromThisBrowser, browsersForThisName] = await Promise.all([
    countDistinctClaimedVoters(event.id, sessionId),
    countSessionsClaimingVoter(event.id, voter.id),
  ]);

  if (namesFromThisBrowser > 1) {
    await AuditService.recordVoterAction({
      action: 'SUSPICIOUS_ACTIVITY_DETECTED',
      summary: `One browser has used ${namesFromThisBrowser} different in-game names in "${event.title}".`,
      eventId: event.id,
      voterId: voter.id,
      sessionId,
      voterLabel: voter.displayName,
      context,
      metadata: { pattern: 'MULTIPLE_NAMES_ONE_BROWSER', distinctNames: namesFromThisBrowser },
    });
  }

  if (browsersForThisName > 1) {
    await AuditService.recordVoterAction({
      action: 'SUSPICIOUS_ACTIVITY_DETECTED',
      summary: `"${voter.displayName}" has been claimed from ${browsersForThisName} different browsers in "${event.title}".`,
      eventId: event.id,
      voterId: voter.id,
      sessionId,
      voterLabel: voter.displayName,
      context,
      metadata: { pattern: 'ONE_NAME_MANY_BROWSERS', distinctSessions: browsersForThisName },
    });
  }
}

/** The identity this browser claimed for this event, if any. */
export async function getClaimedVoter(
  eventId: string,
  sessionId: string,
  db: DbClient = prisma,
): Promise<VoterRow | null> {
  const claim = await findClaim(eventId, sessionId, db);
  return claim?.voter ?? null;
}

/** The claim row itself, including which identity method established it. */
export async function getClaim(eventId: string, sessionId: string, db: DbClient = prisma) {
  return findClaim(eventId, sessionId, db);
}

// --------------------------------------------------------------------------
// Moderation (admin-driven)
// --------------------------------------------------------------------------

export async function setBlocked(
  voterId: string,
  blocked: boolean,
  reason: string | null,
): Promise<VoterRow> {
  return setVoterBlocked(voterId, blocked, reason);
}

/** Voter directory for the admin screen. Administrators only. */
export async function listForAdmin(
  filters: { search?: string; blockedOnly?: boolean },
  pagination: { page: number; pageSize: number },
) {
  return listVotersForAdmin(filters, pagination);
}

export async function setSessionBlocked(
  sessionId: string,
  blocked: boolean,
  reason: string | null,
): Promise<VoterSessionRow> {
  return setVoterSessionBlocked(sessionId, blocked, reason, new Date());
}
