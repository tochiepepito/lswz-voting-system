/**
 * Password policy constants.
 *
 * These live apart from `lib/crypto.ts` on purpose. They are needed by client
 * components (to set `minLength` and write help text) and by the validation
 * schemas, and `lib/crypto.ts` imports `node:crypto` - importing the constants
 * from there would pull the whole Node crypto module into the browser bundle
 * and fail the build.
 *
 * Rule of thumb for this codebase: a value the UI needs is not allowed to live
 * in a module that touches Node built-ins.
 */

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;
