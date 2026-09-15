import { z } from 'zod';
import { SLUG_MAX_LENGTH, SLUG_MIN_LENGTH, SLUG_PATTERN } from '@/lib/slug';
import {
  checkboxField,
  idSchema,
  intField,
  optionalDateField,
  optionalImageUrlField,
  optionalTextField,
  textField,
} from './common';

/** Admin-facing schemas for events and ballot options. */

export const votingTypeSchema = z.enum(['SINGLE_CHOICE', 'MULTIPLE_CHOICE', 'YES_NO'], {
  errorMap: () => ({ message: 'Choose a voting type.' }),
});

export const resultsVisibilitySchema = z.enum(
  ['HIDDEN', 'AFTER_VOTING', 'WHILE_VOTING', 'AFTER_CLOSE'],
  { errorMap: () => ({ message: 'Choose when results become visible.' }) },
);

export const eventStatusSchema = z.enum(['DRAFT', 'SCHEDULED', 'ACTIVE', 'CLOSED', 'ARCHIVED']);

export const optionalSlugSchema = z.preprocess(
  (value) => {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string') return value;
    const trimmed = value.trim().toLowerCase();
    return trimmed === '' ? null : trimmed;
  },
  z
    .string()
    .min(SLUG_MIN_LENGTH, `The URL slug must be at least ${SLUG_MIN_LENGTH} characters.`)
    .max(SLUG_MAX_LENGTH, `The URL slug cannot be longer than ${SLUG_MAX_LENGTH} characters.`)
    .regex(SLUG_PATTERN, 'Use lowercase letters, numbers and single hyphens only.')
    .nullable(),
);

// --------------------------------------------------------------------------
// Options
// --------------------------------------------------------------------------

export const optionInputSchema = z.object({
  /** Present when editing an existing option, absent when creating one. */
  id: idSchema.optional(),
  name: textField({ max: 120, label: 'Option name' }),
  description: optionalTextField({ max: 1000, label: 'Option description' }),
  imageUrl: optionalImageUrlField,
  displayOrder: intField({ min: 0, max: 9999, label: 'Display order' }).default(0),
  /**
   * NO `.default(true)` here, deliberately.
   *
   * An unchecked HTML checkbox submits nothing at all, so `isActive` arrives as
   * `undefined` precisely when the operator has just UNTICKED it. A default of
   * `true` would turn that into "active" and silently discard the change -
   * making it impossible to withdraw an option through the UI.
   *
   * `checkboxField` already maps `undefined` to `false`, which is the correct
   * reading of an absent checkbox. Forms that mean "active" say so explicitly.
   */
  isActive: checkboxField,
});

export type OptionInput = z.infer<typeof optionInputSchema>;

export const createOptionSchema = optionInputSchema.omit({ id: true }).extend({
  eventId: idSchema,
});

export const updateOptionSchema = optionInputSchema.extend({
  id: idSchema,
  eventId: idSchema,
});

export const optionIdSchema = z.object({
  eventId: idSchema,
  optionId: idSchema,
});

export const reorderOptionsSchema = z.object({
  eventId: idSchema,
  /** Option ids in their new display order. */
  orderedOptionIds: z.array(idSchema).min(1).max(200),
});

/**
 * No client-supplied ordering here on purpose: the new order is randomised
 * server-side, so nothing about *how* to shuffle is trusted from the request.
 */
export const shuffleOptionsSchema = z.object({
  eventId: idSchema,
});

// --------------------------------------------------------------------------
// Events
// --------------------------------------------------------------------------

const eventFieldsSchema = z.object({
  title: textField({ min: 3, max: 140, label: 'Title' }),
  slug: optionalSlugSchema,
  description: textField({ min: 1, max: 4000, label: 'Description' }),
  instructions: optionalTextField({ max: 4000, label: 'Instructions' }),
  votingType: votingTypeSchema,
  minSelections: intField({ min: 1, max: 100, label: 'Minimum selections' }).default(1),
  maxSelections: intField({ min: 1, max: 100, label: 'Maximum selections' }).default(1),
  startsAt: optionalDateField,
  endsAt: optionalDateField,
  resultsVisibility: resultsVisibilitySchema.default('AFTER_CLOSE'),
  maxVotesPerSession: intField({ min: 1, max: 50, label: 'Votes per browser' }).default(1),
  ipSoftLimit: intField({ min: 0, max: 10_000, label: 'IP flagging threshold' }).default(8),
  requireCaptcha: checkboxField.default(false),
  randomizeOptionOrder: checkboxField.default(false),
});

/**
 * Cross-field rules that a per-field schema cannot express.
 *
 * Applied to both create and update so the two paths cannot drift - an update
 * that skipped these would be a way to widen a single-choice election after the
 * fact.
 */
function applyEventRules<T extends z.ZodTypeAny>(schema: T) {
  return schema.superRefine((value: z.infer<T>, ctx: z.RefinementCtx) => {
    const event = value as z.infer<typeof eventFieldsSchema> & { options?: unknown[] };

    if (event.startsAt && event.endsAt && event.endsAt <= event.startsAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endsAt'],
        message: 'Voting must close after it opens.',
      });
    }

    if (event.votingType === 'MULTIPLE_CHOICE') {
      if (event.maxSelections < event.minSelections) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['maxSelections'],
          message: 'Maximum selections cannot be lower than minimum selections.',
        });
      }

      if (Array.isArray(event.options) && event.options.length > 0) {
        if (event.minSelections > event.options.length) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['minSelections'],
            message: 'Minimum selections cannot exceed the number of options.',
          });
        }
      }
    }

    if (Array.isArray(event.options)) {
      const names = event.options
        .map((option) =>
          typeof option === 'object' && option !== null && 'name' in option
            ? String((option as { name: unknown }).name).trim().toLowerCase()
            : '',
        )
        .filter(Boolean);

      const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
      if (duplicates.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['options'],
          message: 'Each option must have a distinct name.',
        });
      }
    }
  });
}

/**
 * Create an event, with its options in the same submission.
 *
 * YES_NO events carry no options in the payload: the server generates the Yes
 * and No rows itself, so the two cannot be renamed into something misleading or
 * accidentally reduced to a single choice.
 */
export const createEventSchema = applyEventRules(
  eventFieldsSchema.extend({
    options: z.array(optionInputSchema.omit({ id: true })).max(200).default([]),
  }),
).superRefine((value, ctx) => {
  if (value.votingType !== 'YES_NO' && value.options.length < 2) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['options'],
      message: 'Add at least two options before saving.',
    });
  }
});

export type CreateEventInput = z.infer<typeof createEventSchema>;

/** Update an event. Options are managed through their own endpoints. */
export const updateEventSchema = applyEventRules(
  eventFieldsSchema.extend({ id: idSchema }),
);

export type UpdateEventInput = z.infer<typeof updateEventSchema>;

// --------------------------------------------------------------------------
// Lifecycle & moderation
// --------------------------------------------------------------------------

export const eventLifecycleActionSchema = z.enum([
  'publish',
  'unpublish',
  'open',
  'close',
  'archive',
]);

export type EventLifecycleAction = z.infer<typeof eventLifecycleActionSchema>;

export const eventLifecycleSchema = z.object({
  eventId: idSchema,
  action: eventLifecycleActionSchema,
});

export const duplicateEventSchema = z.object({
  eventId: idSchema,
  title: textField({ min: 3, max: 140, label: 'Title' }),
});

export const invalidateVoteSchema = z.object({
  voteId: idSchema,
  reason: textField({ min: 3, max: 500, label: 'Reason' }),
  /**
   * When true the vote row is removed after its content is captured in the
   * audit log, which frees the (event, voter) unique slot so the voter can cast
   * a corrected ballot. When false the row is kept and merely excluded from
   * tallies.
   */
  allowRevote: checkboxField.default(false),
});

export const restoreVoteSchema = z.object({
  voteId: idSchema,
});

export const moderateVoterSchema = z.object({
  voterId: idSchema,
  blocked: checkboxField,
  reason: optionalTextField({ max: 500, label: 'Reason' }),
});

export const moderateSessionSchema = z.object({
  sessionId: idSchema,
  blocked: checkboxField,
  reason: optionalTextField({ max: 500, label: 'Reason' }),
});

export const auditQuerySchema = z.object({
  eventId: idSchema.optional(),
  action: z.string().max(64).optional(),
  severity: z.enum(['INFO', 'NOTICE', 'WARNING', 'CRITICAL']).optional(),
  securityOnly: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export const exportFormatSchema = z.enum(['summary', 'ballots', 'participants']);
export type ExportFormat = z.infer<typeof exportFormatSchema>;
