/**
 * Event slug handling.
 *
 * Slugs appear in public URLs (`/events/2026-guild-officer-election`) so they
 * must be lowercase, ASCII-safe and stable. They are also a natural unique key,
 * which is why collisions are resolved with an explicit suffix rather than
 * silently overwriting.
 */

export const SLUG_MIN_LENGTH = 3;
export const SLUG_MAX_LENGTH = 80;

/** The canonical slug shape. Anchored, so a partial match cannot slip through. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Derive a slug from a title.
 *
 * Diacritics are folded to ASCII (`Café` -> `cafe`) rather than dropped, so a
 * title in a Latin-script language still produces a readable URL. Non-Latin
 * scripts reduce to empty, and callers fall back to a generated slug.
 */
export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    // Strip combining marks left behind by the decomposition.
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LENGTH)
    // A trailing hyphen can reappear after the slice.
    .replace(/-+$/g, '');
}

export function isValidSlug(slug: string): boolean {
  return (
    slug.length >= SLUG_MIN_LENGTH && slug.length <= SLUG_MAX_LENGTH && SLUG_PATTERN.test(slug)
  );
}

/**
 * Append a numeric suffix until the slug is unused.
 *
 * `isTaken` is an async predicate against the database. The loop is bounded:
 * after `maxAttempts` it falls back to a random suffix rather than spinning.
 */
export async function uniqueSlug(
  base: string,
  isTaken: (candidate: string) => Promise<boolean>,
  maxAttempts = 25,
): Promise<string> {
  const root = isValidSlug(base) ? base : fallbackSlug(base);

  if (!(await isTaken(root))) return root;

  for (let attempt = 2; attempt <= maxAttempts; attempt += 1) {
    const suffix = `-${attempt}`;
    const candidate = `${root.slice(0, SLUG_MAX_LENGTH - suffix.length)}${suffix}`;
    if (!(await isTaken(candidate))) return candidate;
  }

  const random = Math.random().toString(36).slice(2, 8);
  return `${root.slice(0, SLUG_MAX_LENGTH - 7)}-${random}`;
}

/** Slug for a title that produced nothing usable (e.g. an all-Hangul title). */
export function fallbackSlug(seed: string): string {
  const derived = slugify(seed);
  if (isValidSlug(derived)) return derived;

  const random = Math.random().toString(36).slice(2, 8);
  return `event-${random}`;
}
