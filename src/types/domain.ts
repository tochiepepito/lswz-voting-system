/**
 * Domain enums, declared independently of the generated Prisma client.
 *
 * Why duplicate them? Because the pure business rules in `lib/voting-rules.ts`
 * and the React components are then free of any dependency on generated code:
 * unit tests run without `prisma generate`, and client bundles never pull in the
 * Prisma client. `types/prisma-parity.ts` fails the type-check if these ever
 * drift from `schema.prisma`.
 */

export type AdminRole = 'SUPER_ADMIN' | 'ADMIN' | 'AUDITOR';

export type EventStatus = 'DRAFT' | 'SCHEDULED' | 'ACTIVE' | 'CLOSED' | 'ARCHIVED';

export type VotingType = 'SINGLE_CHOICE' | 'MULTIPLE_CHOICE' | 'YES_NO';

export type ResultsVisibility = 'HIDDEN' | 'AFTER_VOTING' | 'WHILE_VOTING' | 'AFTER_CLOSE';

export type VoteStatus = 'VALID' | 'INVALIDATED';

export type IdentityMethod =
  | 'IGN_SELF_DECLARED'
  | 'DISCORD_OAUTH'
  | 'GAME_ACCOUNT'
  | 'VOTER_TOKEN'
  | 'ADMIN_VERIFIED';

export type AuditActorType = 'ADMIN' | 'VOTER' | 'SYSTEM';

export type AuditSeverity = 'INFO' | 'NOTICE' | 'WARNING' | 'CRITICAL';

export type RateLimitScope =
  | 'VOTE_SESSION'
  | 'VOTE_IP'
  | 'CLAIM_IP'
  | 'ADMIN_LOGIN_IP'
  | 'ADMIN_LOGIN_ACCOUNT';

export type AuditAction =
  | 'EVENT_CREATED'
  | 'EVENT_UPDATED'
  | 'EVENT_PUBLISHED'
  | 'EVENT_UNPUBLISHED'
  | 'EVENT_OPENED'
  | 'EVENT_CLOSED'
  | 'EVENT_ARCHIVED'
  | 'EVENT_DUPLICATED'
  | 'OPTION_CREATED'
  | 'OPTION_UPDATED'
  | 'OPTION_DEACTIVATED'
  | 'OPTION_DELETED'
  | 'OPTIONS_REORDERED'
  | 'VOTE_SUBMITTED'
  | 'VOTE_DUPLICATE_BLOCKED'
  | 'VOTE_SESSION_LIMIT_BLOCKED'
  | 'VOTE_REJECTED'
  | 'VOTE_FLAGGED_SUSPICIOUS'
  | 'VOTE_INVALIDATED'
  | 'VOTE_RESTORED'
  | 'VOTE_VOIDED_FOR_REVOTE'
  | 'VOTER_SESSION_CREATED'
  | 'VOTER_IDENTITY_CLAIMED'
  | 'VOTER_BLOCKED'
  | 'VOTER_UNBLOCKED'
  | 'VOTER_SESSION_BLOCKED'
  | 'RATE_LIMIT_TRIGGERED'
  | 'SUSPICIOUS_ACTIVITY_DETECTED'
  | 'CAPTCHA_FAILED'
  | 'ADMIN_LOGIN_SUCCEEDED'
  | 'ADMIN_LOGIN_FAILED'
  | 'ADMIN_LOGGED_OUT'
  | 'ADMIN_LOCKED_OUT'
  | 'ADMIN_CREATED'
  | 'ADMIN_UPDATED'
  | 'ADMIN_DEACTIVATED'
  | 'ADMIN_PASSWORD_CHANGED'
  | 'RESULTS_EXPORTED';

// --------------------------------------------------------------------------
// Display labels
// --------------------------------------------------------------------------

export const EVENT_STATUS_LABELS: Record<EventStatus, string> = {
  DRAFT: 'Draft',
  SCHEDULED: 'Scheduled',
  ACTIVE: 'Active',
  CLOSED: 'Closed',
  ARCHIVED: 'Archived',
};

export const VOTING_TYPE_LABELS: Record<VotingType, string> = {
  SINGLE_CHOICE: 'Single choice',
  MULTIPLE_CHOICE: 'Multiple choice',
  YES_NO: 'Yes / No',
};

export const RESULTS_VISIBILITY_LABELS: Record<ResultsVisibility, string> = {
  HIDDEN: 'Hidden from voters',
  AFTER_VOTING: 'Visible to a voter after they vote',
  WHILE_VOTING: 'Visible publicly while voting is open',
  AFTER_CLOSE: 'Visible publicly after voting closes',
};

export const ADMIN_ROLE_LABELS: Record<AdminRole, string> = {
  SUPER_ADMIN: 'Super administrator',
  ADMIN: 'Administrator',
  AUDITOR: 'Auditor (read-only)',
};

export const IDENTITY_METHOD_LABELS: Record<IdentityMethod, string> = {
  IGN_SELF_DECLARED: 'Self-declared IGN',
  DISCORD_OAUTH: 'Discord account',
  GAME_ACCOUNT: 'Game account',
  VOTER_TOKEN: 'Admin-issued voting code',
  ADMIN_VERIFIED: 'Verified by an administrator',
};

export const AUDIT_ACTION_LABELS: Record<AuditAction, string> = {
  EVENT_CREATED: 'Event created',
  EVENT_UPDATED: 'Event updated',
  EVENT_PUBLISHED: 'Event published',
  EVENT_UNPUBLISHED: 'Event unpublished',
  EVENT_OPENED: 'Voting opened',
  EVENT_CLOSED: 'Voting closed',
  EVENT_ARCHIVED: 'Event archived',
  EVENT_DUPLICATED: 'Event duplicated',
  OPTION_CREATED: 'Option created',
  OPTION_UPDATED: 'Option updated',
  OPTION_DEACTIVATED: 'Option deactivated',
  OPTION_DELETED: 'Option deleted',
  OPTIONS_REORDERED: 'Option order changed',
  VOTE_SUBMITTED: 'Vote submitted',
  VOTE_DUPLICATE_BLOCKED: 'Duplicate vote blocked',
  VOTE_SESSION_LIMIT_BLOCKED: 'Browser vote limit blocked',
  VOTE_REJECTED: 'Vote rejected',
  VOTE_FLAGGED_SUSPICIOUS: 'Vote flagged as suspicious',
  VOTE_INVALIDATED: 'Vote invalidated',
  VOTE_RESTORED: 'Vote restored',
  VOTE_VOIDED_FOR_REVOTE: 'Vote voided to allow a re-vote',
  VOTER_SESSION_CREATED: 'Voter session created',
  VOTER_IDENTITY_CLAIMED: 'IGN claimed for event',
  VOTER_BLOCKED: 'Voter blocked',
  VOTER_UNBLOCKED: 'Voter unblocked',
  VOTER_SESSION_BLOCKED: 'Browser session blocked',
  RATE_LIMIT_TRIGGERED: 'Rate limit triggered',
  SUSPICIOUS_ACTIVITY_DETECTED: 'Suspicious activity detected',
  CAPTCHA_FAILED: 'CAPTCHA failed',
  ADMIN_LOGIN_SUCCEEDED: 'Administrator signed in',
  ADMIN_LOGIN_FAILED: 'Failed sign-in attempt',
  ADMIN_LOGGED_OUT: 'Administrator signed out',
  ADMIN_LOCKED_OUT: 'Administrator account locked',
  ADMIN_CREATED: 'Administrator created',
  ADMIN_UPDATED: 'Administrator updated',
  ADMIN_DEACTIVATED: 'Administrator deactivated',
  ADMIN_PASSWORD_CHANGED: 'Administrator password changed',
  RESULTS_EXPORTED: 'Results exported',
};

/** Audit actions that belong on the security screen rather than the activity feed. */
export const SECURITY_AUDIT_ACTIONS: readonly AuditAction[] = [
  'VOTE_DUPLICATE_BLOCKED',
  'VOTE_SESSION_LIMIT_BLOCKED',
  'VOTE_REJECTED',
  'VOTE_FLAGGED_SUSPICIOUS',
  'RATE_LIMIT_TRIGGERED',
  'SUSPICIOUS_ACTIVITY_DETECTED',
  'CAPTCHA_FAILED',
  'ADMIN_LOGIN_FAILED',
  'ADMIN_LOCKED_OUT',
  'VOTER_BLOCKED',
  'VOTER_SESSION_BLOCKED',
];

// --------------------------------------------------------------------------
// Role capabilities
// --------------------------------------------------------------------------

/**
 * Permission set, resolved from a role on the server for every protected
 * action. The UI uses the same map to decide what to render, but rendering is
 * never the enforcement point - `requireAdmin(...)` is.
 */
export type Capability =
  | 'event:read'
  | 'event:write'
  | 'event:lifecycle'
  | 'option:write'
  | 'results:read'
  | 'results:export'
  | 'audit:read'
  | 'vote:moderate'
  | 'voter:moderate'
  | 'admin:manage';

const ALL_READ: readonly Capability[] = ['event:read', 'results:read', 'audit:read'];

export const ROLE_CAPABILITIES: Record<AdminRole, readonly Capability[]> = {
  SUPER_ADMIN: [
    ...ALL_READ,
    'event:write',
    'event:lifecycle',
    'option:write',
    'results:export',
    'vote:moderate',
    'voter:moderate',
    'admin:manage',
  ],
  ADMIN: [
    ...ALL_READ,
    'event:write',
    'event:lifecycle',
    'option:write',
    'results:export',
    'vote:moderate',
    'voter:moderate',
  ],
  AUDITOR: [...ALL_READ, 'results:export'],
};

export function roleHasCapability(role: AdminRole, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role].includes(capability);
}
