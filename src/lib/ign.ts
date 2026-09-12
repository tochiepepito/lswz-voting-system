/**
 * In-game-name (IGN) normalisation and validation.
 *
 * This module is deliberately pure and dependency-free: it holds no secrets,
 * touches no database, and is therefore directly unit-testable and safe to
 * reason about. Hashing of the normalised value lives in `lib/crypto.ts`.
 *
 * THE CONTRACT
 *   displayName    - exactly what the player typed (trimmed). Shown in the UI.
 *   normalizedName - the comparison key. Two inputs that normalise to the same
 *                    string are the same voter as far as this system is concerned.
 *   confusableKey  - a deliberately *lossier* key used ONLY for abuse heuristics,
 *                    never for identity. See `confusableKey()`.
 */

export const IGN_MIN_LENGTH = 2;
export const IGN_MAX_LENGTH = 32;

/**
 * Invisible and direction-controlling characters, written as explicit escapes
 * so the pattern is reviewable. These are stripped outright: they are never
 * meaningful in a game name, and they are the classic way to smuggle two
 * "different" IGNs that render identically to a human moderator.
 */
const INVISIBLE_CHARACTERS = new RegExp(
  '[' +
    '\\u00AD' + // soft hyphen
    '\\u180E' + // Mongolian vowel separator
    '\\u200B-\\u200F' + // zero-width space/joiners, LTR/RTL marks
    '\\u202A-\\u202E' + // bidi embedding and override
    '\\u2060-\\u2064' + // word joiner, invisible operators
    '\\u206A-\\u206F' + // deprecated format characters
    '\\uFEFF' + // zero-width no-break space / BOM
    ']',
  'gu',
);

/**
 * Non-whitespace C0/C1 control characters. Always rejected rather than stripped.
 *
 * The range deliberately EXCLUDES U+0009-U+000D (tab, line feed, vertical tab,
 * form feed, carriage return). Those are real whitespace - a player pasting a
 * name out of a spreadsheet or a Discord message legitimately brings a tab with
 * it - so they are collapsed by WHITESPACE_RUN like any other space. The
 * remaining control characters have no business in a name and are refused.
 */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000E-\u001F\u007F-\u009F]/u;

/** Any Unicode whitespace run, including ideographic and non-breaking spaces. */
const WHITESPACE_RUN = /\s+/gu;

/**
 * Characters permitted in an IGN: any Unicode letter, number or combining mark,
 * plus a conservative set of separators that real game names use. Must begin
 * and end with an alphanumeric-ish character, so no leading or trailing
 * punctuation.
 *
 * Intentionally permissive about scripts (a guild may be Korean, Cyrillic or
 * Arabic) and intentionally strict about punctuation.
 */
const ALLOWED_IGN =
  /^[\p{L}\p{N}\p{M}](?:[\p{L}\p{N}\p{M} ._'\-\[\]()]*[\p{L}\p{N}\p{M}\)\]])?$/u;

/** Homoglyph folding applied only when building the `confusableKey`. */
const CONFUSABLE_FOLD: ReadonlyArray<readonly [RegExp, string]> = [
  [/[0оОｏ]/gu, 'o'], // 0, Cyrillic o/O, fullwidth o
  [/[1l|Іі]/gu, 'l'], // 1, pipe, Cyrillic I/i
  [/[3еЕ]/gu, 'e'], // 3, Cyrillic ie/IE
  [/[4а]/gu, 'a'], // 4, Cyrillic a
  [/[5$ѕ]/gu, 's'], // 5, dollar, Cyrillic dze
  [/[7тТ]/gu, 't'], // 7, Cyrillic te/TE
  [/[8]/gu, 'b'],
  [/[рР]/gu, 'p'], // Cyrillic er/ER
  [/[сС]/gu, 'c'], // Cyrillic es/ES
  [/[хХ]/gu, 'x'], // Cyrillic ha/HA
  [/[уУ]/gu, 'y'], // Cyrillic u/U
  [/[кК]/gu, 'k'], // Cyrillic ka/KA
  [/[мМ]/gu, 'm'], // Cyrillic em/EM
  [/[нН]/gu, 'h'], // Cyrillic en/EN
];

export type IgnRejectionReason =
  | 'EMPTY'
  | 'TOO_SHORT'
  | 'TOO_LONG'
  | 'CONTROL_CHARACTERS'
  | 'DISALLOWED_CHARACTERS';

export type NormalizedIgn = {
  /** Trimmed, whitespace-collapsed, as typed. For display only. */
  displayName: string;
  /** The identity comparison key. */
  normalizedName: string;
  /** Lossy key for near-duplicate detection. Never an identity. */
  confusableKey: string;
};

export type IgnNormalizationResult =
  | { ok: true; value: NormalizedIgn }
  | { ok: false; reason: IgnRejectionReason };

/**
 * Collapse a raw input to its display form: strip invisibles, apply Unicode
 * NFKC (so full-width and compatibility characters fold to their canonical
 * equivalents), then squeeze every whitespace run down to a single space.
 */
function toDisplayForm(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(INVISIBLE_CHARACTERS, '')
    .replace(WHITESPACE_RUN, ' ')
    .trim();
}

/**
 * Normalise and validate a raw IGN submitted by a voter.
 *
 * Case folding makes `" PlayerName "`, `"playername"` and `"PLAYERNAME"` a
 * single identity, which is what the community expects: players do not think of
 * their own name as case-sensitive, and treating those as three voters would
 * hand anyone three ballots.
 */
export function normalizeIgn(raw: unknown): IgnNormalizationResult {
  if (typeof raw !== 'string') return { ok: false, reason: 'EMPTY' };

  // Reject control characters before stripping anything, so that an IGN built
  // out of them fails loudly rather than silently becoming a different name.
  if (CONTROL_CHARACTERS.test(raw)) return { ok: false, reason: 'CONTROL_CHARACTERS' };

  const displayName = toDisplayForm(raw);
  if (displayName.length === 0) return { ok: false, reason: 'EMPTY' };

  // Measure by code points, not UTF-16 units, so names using astral-plane
  // characters are counted the way a player would count them.
  const codePointLength = Array.from(displayName).length;
  if (codePointLength < IGN_MIN_LENGTH) return { ok: false, reason: 'TOO_SHORT' };
  if (codePointLength > IGN_MAX_LENGTH) return { ok: false, reason: 'TOO_LONG' };

  if (!ALLOWED_IGN.test(displayName)) return { ok: false, reason: 'DISALLOWED_CHARACTERS' };

  // `toLowerCase()` rather than a locale-aware fold: the result is a storage key
  // and must be byte-identical on every machine and in every server locale.
  const normalizedName = displayName.toLowerCase();

  return {
    ok: true,
    value: {
      displayName,
      normalizedName,
      confusableKey: confusableKey(normalizedName),
    },
  };
}

/**
 * Build the lossy near-duplicate key.
 *
 * Folds homoglyphs and drops every separator, so `PlayerOne`, `P1ayer_One` and
 * `Pl ayer.0ne` share a key. This is ONLY for flagging suspicious activity to a
 * human moderator: it is far too aggressive to use as an identity, since
 * legitimately distinct players really are called `Shadow` and `5hadow`.
 */
export function confusableKey(normalizedName: string): string {
  // Decompose and drop combining marks so accented letters fold to their base.
  let key = normalizedName.normalize('NFKD').replace(/\p{M}+/gu, '');

  for (const [pattern, replacement] of CONFUSABLE_FOLD) {
    key = key.replace(pattern, replacement);
  }

  return key.replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Voter-facing explanation for each rejection reason. */
export const IGN_REJECTION_MESSAGES: Record<IgnRejectionReason, string> = {
  EMPTY: 'Please enter your in-game name.',
  TOO_SHORT: `Your in-game name must be at least ${IGN_MIN_LENGTH} characters.`,
  TOO_LONG: `Your in-game name cannot be longer than ${IGN_MAX_LENGTH} characters.`,
  CONTROL_CHARACTERS: 'Your in-game name contains characters we cannot accept.',
  DISALLOWED_CHARACTERS:
    'Your in-game name can only contain letters, numbers, spaces and the characters . _ - ( ) [ ]',
};

/**
 * True when two normalised names are the same identity.
 * A function rather than `===` at call sites so the identity rule has exactly
 * one definition in the codebase.
 */
export function isSameVoterIdentity(a: string, b: string): boolean {
  return a === b;
}
