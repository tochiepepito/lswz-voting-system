import { describe, expect, it } from 'vitest';
import { csvFilename, escapeCsvCell, toCsv } from '@/lib/csv';
import { normalizeIp } from '@/lib/http';
import { isValidSlug, slugify, uniqueSlug } from '@/lib/slug';
import { ERROR_CODES, AppError, messageForCode, statusForCode, toAppError } from '@/lib/errors';

/** Supporting security-relevant helpers: export safety, IP handling, errors. */

describe('CSV export - spreadsheet formula injection', () => {
  it('neutralises every formula-triggering prefix', () => {
    // An IGN or option name is attacker-chosen text. Without the apostrophe,
    // opening the export runs it as a formula in Excel and Google Sheets.
    expect(escapeCsvCell('=HYPERLINK("http://evil","Click")')).toBe(
      `"'=HYPERLINK(""http://evil"",""Click"")"`,
    );
    expect(escapeCsvCell('+1234')).toBe("'+1234");
    expect(escapeCsvCell('-1+1')).toBe("'-1+1");
    expect(escapeCsvCell('@SUM(A1)')).toBe("'@SUM(A1)");
  });

  it('quotes and escapes separators, quotes and newlines', () => {
    expect(escapeCsvCell('a,b')).toBe('"a,b"');
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvCell('line1\nline2')).toBe('"line1\nline2"');
  });

  it('leaves ordinary values untouched', () => {
    expect(escapeCsvCell('PlayerOne')).toBe('PlayerOne');
    expect(escapeCsvCell(42)).toBe('42');
    expect(escapeCsvCell(true)).toBe('true');
    expect(escapeCsvCell(null)).toBe('');
    expect(escapeCsvCell(undefined)).toBe('');
  });

  it('emits a BOM so Excel reads non-ASCII names correctly', () => {
    const csv = toCsv(['Name'], [['Кирилл']]);

    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('Кирилл');
    expect(csv).toContain('\r\n');
  });

  it('sanitises the download filename so it cannot break the header', () => {
    const filename = csvFilename('Guild "Election" 2026\r\nX-Injected: yes');

    expect(filename).not.toContain('"');
    expect(filename).not.toContain('\r');
    expect(filename).not.toContain('\n');
    expect(filename).toMatch(/^[A-Za-z0-9._-]+\.csv$/);
  });
});

describe('normalizeIp', () => {
  it('returns IPv4 addresses unchanged', () => {
    expect(normalizeIp('203.0.113.42')).toBe('203.0.113.42');
  });

  it('strips a port', () => {
    expect(normalizeIp('203.0.113.42:51234')).toBe('203.0.113.42');
    expect(normalizeIp('[2001:db8::1]:443')).toBe('2001:db8:0:0::/64');
  });

  it('unwraps IPv4-mapped IPv6', () => {
    expect(normalizeIp('::ffff:203.0.113.42')).toBe('203.0.113.42');
  });

  it('collapses IPv6 to a /64, so one household is one actor', () => {
    // A single customer is routinely handed a whole /64; counting each address
    // separately would make IPv6 rate limiting meaningless.
    const a = normalizeIp('2001:db8:85a3:1111:0000:0000:0000:0001');
    const b = normalizeIp('2001:db8:85a3:1111:ffff:ffff:ffff:ffff');

    expect(a).toBe(b);
    expect(a).toContain('/64');
  });

  it('separates different IPv6 networks', () => {
    expect(normalizeIp('2001:db8:85a3:1111::1')).not.toBe(normalizeIp('2001:db8:85a3:2222::1'));
  });

  it('drops a zone index', () => {
    expect(normalizeIp('fe80::1%eth0')).toBe(normalizeIp('fe80::1'));
  });

  it('returns null for empty input', () => {
    expect(normalizeIp('')).toBeNull();
    expect(normalizeIp('   ')).toBeNull();
  });
});

describe('slug handling', () => {
  it('derives a readable slug from a title', () => {
    expect(slugify('2026 Guild Officer Election')).toBe('2026-guild-officer-election');
    expect(slugify('  Multiple   Spaces  ')).toBe('multiple-spaces');
    expect(slugify('Symbols!@#$%^&*()Here')).toBe('symbols-here');
  });

  it('folds diacritics to ASCII rather than dropping the word', () => {
    expect(slugify('Café Événement')).toBe('cafe-evenement');
  });

  it('produces an empty string for a title with no Latin characters', () => {
    expect(slugify('한글 제목')).toBe('');
    expect(isValidSlug('')).toBe(false);
  });

  it('validates the canonical shape', () => {
    expect(isValidSlug('guild-election-2026')).toBe(true);
    expect(isValidSlug('a-b-c')).toBe(true);

    expect(isValidSlug('Has-Uppercase')).toBe(false);
    expect(isValidSlug('double--hyphen')).toBe(false);
    expect(isValidSlug('-leading')).toBe(false);
    expect(isValidSlug('trailing-')).toBe(false);
    expect(isValidSlug('ab')).toBe(false);
  });

  it('appends a numeric suffix until the slug is free', async () => {
    const taken = new Set(['election', 'election-2', 'election-3']);

    await expect(uniqueSlug('election', async (candidate) => taken.has(candidate))).resolves.toBe(
      'election-4',
    );
  });

  it('gives up on a bounded loop rather than spinning forever', async () => {
    // Everything is taken: it must still terminate, with a random suffix.
    const result = await uniqueSlug('election', async () => true, 3);

    expect(result.startsWith('election-')).toBe(true);
    expect(result).not.toBe('election');
  });
});

describe('error taxonomy', () => {
  it('gives every code a status and a user-safe message', () => {
    for (const code of ERROR_CODES) {
      const message = messageForCode(code);
      const status = statusForCode(code);

      expect(message.length, `${code} needs a message`).toBeGreaterThan(0);
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);

      // No internal vocabulary may leak into anything a user reads.
      expect(message.toLowerCase()).not.toContain('prisma');
      expect(message.toLowerCase()).not.toContain('sql');
      expect(message.toLowerCase()).not.toContain('undefined');
      expect(message).not.toContain('Error:');
    }
  });

  it('serialises only the code, message and field errors', () => {
    const error = new AppError('ALREADY_VOTED');
    const json = error.toPublicJSON();

    expect(json).toEqual({
      error: { code: 'ALREADY_VOTED', message: 'You have already voted in this event.' },
    });
    expect(JSON.stringify(json)).not.toContain('stack');
  });

  it('replaces an unexpected error with a generic INTERNAL', () => {
    // The critical guarantee: a raw database error never reaches a client.
    const leaky = new Error(
      'Invalid `prisma.vote.create()` invocation: Unique constraint failed on the fields: (`eventId`,`voterId`)',
    );

    const converted = toAppError(leaky, 'test');

    expect(converted.code).toBe('INTERNAL');
    expect(converted.message).not.toContain('prisma');
    expect(converted.message).not.toContain('Unique constraint');
    expect(converted.toPublicJSON().error.message).toBe('Something went wrong. Please try again.');
  });

  it('passes an AppError through unchanged', () => {
    const original = new AppError('RATE_LIMITED', { retryAfterSeconds: 42 });
    const converted = toAppError(original, 'test');

    expect(converted).toBe(original);
    expect(converted.retryAfterSeconds).toBe(42);
    expect(converted.status).toBe(429);
  });
});
