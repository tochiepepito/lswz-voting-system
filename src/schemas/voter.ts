import { z } from 'zod';
import { IGN_MAX_LENGTH, IGN_MIN_LENGTH } from '@/lib/ign';
import { idSchema, stringArrayField } from './common';

/**
 * Voter-facing request schemas.
 *
 * Note what is NOT here: no voter id, no "hasVoted" flag, no event status, no
 * vote count, no session id. Every one of those is derived on the server from
 * the session cookie and the database. The browser can only say which event it
 * means and which options it picked - everything else would be a value the
 * client could lie about.
 */

/** Raw IGN as typed. Normalisation and deep validation happen in `lib/ign.ts`. */
export const ignFieldSchema = z
  .string({
    required_error: 'Please enter your in-game name.',
    invalid_type_error: 'Please enter your in-game name.',
  })
  // Generous upper bound here; `normalizeIgn` applies the real limit after
  // stripping invisible characters, so padding cannot smuggle a longer name.
  .max(IGN_MAX_LENGTH * 4, 'That in-game name is too long.');

/**
 * Step 2 of the voter flow: claim an identity for an event.
 * The event is addressed by slug, exactly as it appears in the URL.
 */
export const claimIdentitySchema = z.object({
  ign: ignFieldSchema,
  /** Cloudflare Turnstile response, when the event requires a challenge. */
  captchaToken: z.string().max(4096).optional(),
});

export type ClaimIdentityInput = z.infer<typeof claimIdentitySchema>;

/**
 * Step 3: submit the ballot.
 *
 * `optionIds` is checked for shape only. Whether those options exist, are
 * active, belong to this event, and satisfy the min/max selection rules is
 * decided server-side inside the vote transaction against freshly read rows.
 */
export const submitVoteSchema = z.object({
  optionIds: z.preprocess(
    (value) => {
      if (value === undefined || value === null || value === '') return [];
      return Array.isArray(value) ? value : [value];
    },
    z
      .array(idSchema)
      // A hard ceiling independent of the event's own max, so a crafted request
      // cannot make the server validate a hundred thousand ids.
      .max(64, 'Too many options were selected.'),
  ),
  captchaToken: z.string().max(4096).optional(),
});

export type SubmitVoteInput = z.infer<typeof submitVoteSchema>;

/** Voter-facing form payload for the IGN step (server action). */
export const claimIdentityFormSchema = claimIdentitySchema.extend({
  eventSlug: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9-]+$/, 'Invalid event.'),
  csrfToken: z.string().min(1).max(256).optional(),
});

/** Voter-facing form payload for the ballot (server action). */
export const submitVoteFormSchema = z.object({
  eventSlug: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9-]+$/, 'Invalid event.'),
  optionIds: stringArrayField.pipe(z.array(idSchema).max(64, 'Too many options were selected.')),
  captchaToken: z.string().max(4096).optional(),
  csrfToken: z.string().min(1).max(256).optional(),
});

export const IGN_HELP_TEXT = `Between ${IGN_MIN_LENGTH} and ${IGN_MAX_LENGTH} characters. Enter it exactly as it appears in game.`;
