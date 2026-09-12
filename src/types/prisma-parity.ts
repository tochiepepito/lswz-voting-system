import type { $Enums } from '@prisma/client';
import type * as Domain from './domain';

/**
 * Compile-time parity check between the hand-written domain unions in
 * `types/domain.ts` and the enums Prisma generates from `schema.prisma`.
 *
 * WHY THIS FILE EXISTS
 *
 * `types/domain.ts` declares the enums independently so that the pure rules in
 * `lib/voting-rules.ts`, the React components and the unit suite need no
 * dependency on generated code. The cost of that independence is the risk of
 * drift: add a member to `schema.prisma` and forget `domain.ts`, and the two
 * quietly disagree.
 *
 * This file removes the risk. Each assertion below is a *bidirectional*
 * assignability check, so it fails `npm run typecheck` if either side gains or
 * loses a member. It emits nothing at runtime - every export is a type.
 *
 * If the build points here, the fix is to bring `types/domain.ts` back in line
 * with the schema (and usually to add a label for the new member in the
 * corresponding `*_LABELS` record, which is a `Record<Enum, string>` and will
 * fail on its own if a member is missing).
 */

/** Resolves to `true` only when A and B are mutually assignable. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

/** Fails to compile unless the parameter resolves to `true`. */
type Assert<T extends true> = T;

export type AdminRoleParity = Assert<Exact<Domain.AdminRole, $Enums.AdminRole>>;
export type EventStatusParity = Assert<Exact<Domain.EventStatus, $Enums.EventStatus>>;
export type VotingTypeParity = Assert<Exact<Domain.VotingType, $Enums.VotingType>>;
export type ResultsVisibilityParity = Assert<
  Exact<Domain.ResultsVisibility, $Enums.ResultsVisibility>
>;
export type VoteStatusParity = Assert<Exact<Domain.VoteStatus, $Enums.VoteStatus>>;
export type IdentityMethodParity = Assert<Exact<Domain.IdentityMethod, $Enums.IdentityMethod>>;
export type AuditActorTypeParity = Assert<Exact<Domain.AuditActorType, $Enums.AuditActorType>>;
export type AuditSeverityParity = Assert<Exact<Domain.AuditSeverity, $Enums.AuditSeverity>>;
export type AuditActionParity = Assert<Exact<Domain.AuditAction, $Enums.AuditAction>>;
export type RateLimitScopeParity = Assert<Exact<Domain.RateLimitScope, $Enums.RateLimitScope>>;
