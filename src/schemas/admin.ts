import { z } from 'zod';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@/lib/password-policy';
import { checkboxField, idSchema, textField } from './common';

/** Administrator authentication and account-management schemas. */

export const emailSchema = z
  .string({ required_error: 'Enter your e-mail address.' })
  .trim()
  .toLowerCase()
  .min(3, 'Enter your e-mail address.')
  .max(254, 'That e-mail address is too long.')
  .email('Enter a valid e-mail address.');

/**
 * Password policy.
 *
 * Length first, composition rules second. A 12-character minimum with a
 * blocklist of obvious choices does far more for real-world account safety than
 * the classic "one uppercase, one symbol" ruleset, which mostly produces
 * `Password1!`. The only composition requirement is that the password is not
 * entirely one character class.
 */
export const passwordSchema = z
  .string({ required_error: 'Enter a password.' })
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters.`)
  .max(PASSWORD_MAX_LENGTH, 'That password is too long.')
  .refine(
    (value) => !/^(.)\1*$/.test(value),
    'Use a password with more variety than a single repeated character.',
  )
  .refine((value) => {
    const lowered = value.toLowerCase();
    const banned = [
      'password',
      'passw0rd',
      'letmein',
      '123456789',
      'qwertyuiop',
      'administrator',
      'changeme',
    ];
    return !banned.some((entry) => lowered.includes(entry));
  }, 'That password is too easy to guess. Choose something less common.');

/**
 * Login input.
 *
 * The password is NOT run through the strength policy here: an existing account
 * may legitimately hold a password that predates a policy change, and applying
 * the policy at login would both lock that user out and leak the policy to an
 * attacker probing the form.
 */
export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Enter your password.').max(PASSWORD_MAX_LENGTH),
  csrfToken: z.string().max(256).optional(),
  /** Where to land after a successful sign-in. Validated as a local path. */
  redirectTo: z
    .string()
    .max(512)
    .optional()
    .transform((value) => {
      // Only same-site absolute paths. `//evil.com` and `https://evil.com` are
      // both rejected, which closes the classic open-redirect on login.
      if (!value) return undefined;
      if (!value.startsWith('/') || value.startsWith('//')) return undefined;
      return value;
    }),
});

export type LoginInput = z.infer<typeof loginSchema>;

export const adminRoleSchema = z.enum(['SUPER_ADMIN', 'ADMIN', 'AUDITOR'], {
  errorMap: () => ({ message: 'Choose a role.' }),
});

export const createAdminSchema = z.object({
  email: emailSchema,
  displayName: textField({ min: 2, max: 80, label: 'Display name' }),
  password: passwordSchema,
  role: adminRoleSchema,
  mustChangePassword: checkboxField.default(true),
});

export type CreateAdminInput = z.infer<typeof createAdminSchema>;

export const updateAdminSchema = z.object({
  adminId: idSchema,
  displayName: textField({ min: 2, max: 80, label: 'Display name' }),
  role: adminRoleSchema,
  isActive: checkboxField,
});

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password.').max(PASSWORD_MAX_LENGTH),
    newPassword: passwordSchema,
    confirmPassword: z.string().max(PASSWORD_MAX_LENGTH),
  })
  .superRefine((value, ctx) => {
    if (value.newPassword !== value.confirmPassword) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['confirmPassword'],
        message: 'The two passwords do not match.',
      });
    }

    if (value.newPassword === value.currentPassword) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['newPassword'],
        message: 'Choose a password you have not used before.',
      });
    }
  });

export const resetAdminPasswordSchema = z.object({
  adminId: idSchema,
  newPassword: passwordSchema,
});
