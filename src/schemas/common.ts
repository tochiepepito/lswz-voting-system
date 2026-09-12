import { z } from 'zod';

/**
 * Shared primitives for every validation schema.
 *
 * Design rule: schemas are the *only* place untrusted input becomes typed data.
 * Nothing downstream of a `.parse()` re-checks shape, and nothing upstream of it
 * is allowed to reach a repository.
 */

/**
 * Database identifier. Deliberately a shape check rather than a strict cuid
 * matcher: it rejects the injection and traversal payloads that matter while
 * staying valid if the id strategy ever changes to uuid or cuid2.
 */
export const idSchema = z
  .string()
  .trim()
  .min(8, 'Invalid identifier.')
  .max(64, 'Invalid identifier.')
  .regex(/^[A-Za-z0-9_-]+$/, 'Invalid identifier.');

/** Trimmed, length-bounded text with a field-specific message. */
export function textField(options: {
  min?: number;
  max: number;
  label: string;
}) {
  const { min = 1, max, label } = options;

  return z
    .string({ required_error: `${label} is required.`, invalid_type_error: `${label} is required.` })
    .trim()
    .min(min, min === 1 ? `${label} is required.` : `${label} must be at least ${min} characters.`)
    .max(max, `${label} cannot be longer than ${max} characters.`);
}

/** Optional text: empty string and null both collapse to null. */
export function optionalTextField(options: { max: number; label: string }) {
  return z.preprocess(
    (value) => {
      if (value === null || value === undefined) return null;
      if (typeof value !== 'string') return value;
      const trimmed = value.trim();
      return trimmed === '' ? null : trimmed;
    },
    z
      .string()
      .max(options.max, `${options.label} cannot be longer than ${options.max} characters.`)
      .nullable(),
  );
}

/**
 * A date that may be absent. Accepts a Date, an ISO string, or "" / null.
 *
 * Admin forms submit ISO strings produced in the browser from a
 * `datetime-local` input, so the operator's own timezone is preserved rather
 * than being silently reinterpreted as UTC on the server.
 */
export const optionalDateField = z.preprocess(
  (value) => {
    if (value === null || value === undefined || value === '') return null;
    if (value instanceof Date) return value;
    if (typeof value === 'string') {
      const parsed = new Date(value);
      // Leave unparseable strings alone so z.date() produces the error.
      return Number.isNaN(parsed.getTime()) ? value : parsed;
    }
    return value;
  },
  z.date({ invalid_type_error: 'Enter a valid date and time.' }).nullable(),
);

/** Integer from a form string or a JSON number. */
export function intField(options: { min: number; max: number; label: string }) {
  return z.preprocess(
    (value) => (value === '' || value === null || value === undefined ? undefined : value),
    z.coerce
      .number({ invalid_type_error: `${options.label} must be a number.` })
      .int(`${options.label} must be a whole number.`)
      .min(options.min, `${options.label} must be at least ${options.min}.`)
      .max(options.max, `${options.label} cannot be more than ${options.max}.`),
  );
}

/**
 * Checkbox value. An unchecked HTML checkbox submits nothing at all, so
 * `undefined` must mean false rather than "missing".
 */
export const checkboxField = z.preprocess((value) => {
  if (value === undefined || value === null || value === '') return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return ['on', 'true', '1', 'yes'].includes(value.toLowerCase());
  return Boolean(value);
}, z.boolean());

/**
 * Optional image URL for a candidate avatar.
 *
 * Restricted to absolute http(s): a `javascript:` or `data:` URL rendered into
 * an `<img src>` is a stored-XSS vector, and this is admin-supplied text.
 */
export const optionalImageUrlField = z.preprocess(
  (value) => {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  },
  z
    .string()
    .max(2048, 'Image URL is too long.')
    .refine((value) => {
      try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
      } catch {
        return false;
      }
    }, 'Enter a full http:// or https:// image URL.')
    .nullable(),
);

/** Pagination for admin listings. */
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export type Pagination = z.infer<typeof paginationSchema>;

/**
 * Flatten a Zod error into the `Record<field, string[]>` shape that forms and
 * `AppError.fieldErrors` both use.
 */
export function toFieldErrors(error: z.ZodError): Record<string, string[]> {
  const result: Record<string, string[]> = {};

  for (const issue of error.issues) {
    // Join nested paths so `options.0.name` stays addressable by the form.
    const key = issue.path.length > 0 ? issue.path.join('.') : '_form';
    (result[key] ??= []).push(issue.message);
  }

  return result;
}

/**
 * Convert FormData into a plain object, collapsing repeated keys into arrays.
 *
 * Repeated keys are how multi-select ballots and option lists arrive, and a
 * naive `Object.fromEntries(formData)` would silently keep only the last value -
 * i.e. drop every selection but one on a multiple-choice vote.
 */
export function formDataToObject(formData: FormData): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of formData.entries()) {
    // File uploads are not accepted anywhere in this system.
    if (typeof value !== 'string') continue;

    const existing = result[key];
    if (existing === undefined) {
      result[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      result[key] = [existing, value];
    }
  }

  return result;
}

/** Always produce an array, whether the key appeared 0, 1 or many times. */
export const stringArrayField = z.preprocess((value) => {
  if (value === undefined || value === null || value === '') return [];
  return Array.isArray(value) ? value : [value];
}, z.array(z.string()));
