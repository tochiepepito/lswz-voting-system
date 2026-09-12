import { describe, expect, it } from 'vitest';
import { formDataToObject, idSchema, toFieldErrors } from '@/schemas/common';
import { loginSchema, passwordSchema } from '@/schemas/admin';
import { createEventSchema, updateEventSchema, updateOptionSchema } from '@/schemas/event';
import { submitVoteSchema } from '@/schemas/voter';

/**
 * Schemas are the only place untrusted input becomes typed data, so this file
 * concentrates on what a hostile client would send rather than on the happy path.
 */

describe('idSchema', () => {
  it('accepts identifier-shaped strings', () => {
    expect(idSchema.safeParse('clk3x9a1b0000qwer1234asdf').success).toBe(true);
    expect(idSchema.safeParse('abc12345').success).toBe(true);
  });

  it('rejects traversal, injection and wildcard payloads', () => {
    for (const bad of [
      '../../../etc/passwd',
      "'; DROP TABLE votes; --",
      '<script>alert(1)</script>',
      '*',
      '%00',
      'id with spaces',
      'a'.repeat(65),
      'short',
      '',
    ]) {
      expect(idSchema.safeParse(bad).success, `expected ${bad} to be rejected`).toBe(false);
    }
  });
});

describe('submitVoteSchema - what a ballot may contain', () => {
  it('accepts a list of option ids', () => {
    const parsed = submitVoteSchema.safeParse({ optionIds: ['abc12345', 'def67890'] });

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.optionIds).toEqual(['abc12345', 'def67890']);
  });

  it('coerces a single value into an array', () => {
    const parsed = submitVoteSchema.safeParse({ optionIds: 'abc12345' });

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.optionIds).toEqual(['abc12345']);
  });

  it('treats a missing field as an empty ballot rather than failing', () => {
    // The "you must choose something" error belongs to the voting rules, where
    // it can be phrased in terms of this event's actual minimum.
    const parsed = submitVoteSchema.safeParse({});

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.optionIds).toEqual([]);
  });

  it('caps the array so a crafted request cannot force huge validation work', () => {
    const flood = Array.from({ length: 5000 }, (_, index) => `option${index}xx`);
    expect(submitVoteSchema.safeParse({ optionIds: flood }).success).toBe(false);
  });

  it('silently ignores extra fields a client tries to smuggle in', () => {
    // The important part: none of these appear in the parsed output, so they
    // cannot reach a service. The server decides all of them itself.
    const parsed = submitVoteSchema.safeParse({
      optionIds: ['abc12345'],
      voterId: 'attacker-chosen',
      eventStatus: 'ACTIVE',
      hasVoted: false,
      voteCount: 9999,
      isAdmin: true,
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(Object.keys(parsed.data).sort()).toEqual(['optionIds']);
    expect(parsed.data).not.toHaveProperty('voterId');
    expect(parsed.data).not.toHaveProperty('hasVoted');
  });
});

describe('loginSchema', () => {
  it('normalises the e-mail and keeps the password verbatim', () => {
    const parsed = loginSchema.safeParse({
      email: '  Admin@Example.COM ',
      password: '  spaces matter  ',
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(parsed.data.email).toBe('admin@example.com');
    // Trimming a password would silently reject a legitimate one.
    expect(parsed.data.password).toBe('  spaces matter  ');
  });

  it('does not apply the strength policy at login', () => {
    // An account may hold a password that predates a policy change; enforcing
    // the policy here would lock that user out and leak the policy to a prober.
    expect(loginSchema.safeParse({ email: 'a@b.co', password: 'short' }).success).toBe(true);
  });

  it('strips an off-site redirect, closing the open-redirect hole', () => {
    for (const hostile of [
      'https://evil.example.com/steal',
      '//evil.example.com',
      'http://evil.example.com',
      'javascript:alert(1)',
    ]) {
      const parsed = loginSchema.safeParse({
        email: 'a@b.co',
        password: 'x',
        redirectTo: hostile,
      });

      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.redirectTo).toBeUndefined();
    }
  });

  it('keeps a legitimate local path', () => {
    const parsed = loginSchema.safeParse({
      email: 'a@b.co',
      password: 'x',
      redirectTo: '/admin/events/abc12345',
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.redirectTo).toBe('/admin/events/abc12345');
  });
});

describe('passwordSchema', () => {
  it('accepts a long passphrase', () => {
    expect(passwordSchema.safeParse('correct horse battery staple').success).toBe(true);
  });

  it('rejects short, repeated and obvious passwords', () => {
    for (const bad of [
      'short',
      'aaaaaaaaaaaaaaaa',
      'mypassword12345',
      'Passw0rd!!!!',
      'changeme123456',
      'administrator1',
    ]) {
      expect(passwordSchema.safeParse(bad).success, `expected ${bad} to be rejected`).toBe(false);
    }
  });
});

describe('createEventSchema - cross-field rules', () => {
  const base = {
    title: 'Guild Officer Election',
    description: 'Choose the next president.',
    votingType: 'SINGLE_CHOICE',
    resultsVisibility: 'AFTER_CLOSE',
    options: [
      { name: 'PlayerOne', displayOrder: 0, isActive: true },
      { name: 'PlayerTwo', displayOrder: 1, isActive: true },
    ],
  };

  it('accepts a well-formed event', () => {
    expect(createEventSchema.safeParse(base).success).toBe(true);
  });

  it('requires the close time to be after the open time', () => {
    const parsed = createEventSchema.safeParse({
      ...base,
      startsAt: '2026-09-17T20:00:00Z',
      endsAt: '2026-09-15T20:00:00Z',
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(toFieldErrors(parsed.error)).toHaveProperty('endsAt');
  });

  it('requires at least two options for a choice-based event', () => {
    const parsed = createEventSchema.safeParse({ ...base, options: [base.options[0]] });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(toFieldErrors(parsed.error)).toHaveProperty('options');
  });

  it('does not require options for a yes/no event', () => {
    // The server generates Yes and No itself, so they cannot be renamed into
    // something misleading.
    expect(
      createEventSchema.safeParse({ ...base, votingType: 'YES_NO', options: [] }).success,
    ).toBe(true);
  });

  it('rejects duplicate option names regardless of case', () => {
    const parsed = createEventSchema.safeParse({
      ...base,
      options: [
        { name: 'PlayerOne', displayOrder: 0, isActive: true },
        { name: 'playerone', displayOrder: 1, isActive: true },
      ],
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(toFieldErrors(parsed.error)).toHaveProperty('options');
  });

  it('rejects a maximum below the minimum on multiple choice', () => {
    const parsed = createEventSchema.safeParse({
      ...base,
      votingType: 'MULTIPLE_CHOICE',
      minSelections: 3,
      maxSelections: 2,
      options: [
        { name: 'A', displayOrder: 0, isActive: true },
        { name: 'B', displayOrder: 1, isActive: true },
        { name: 'C', displayOrder: 2, isActive: true },
      ],
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(toFieldErrors(parsed.error)).toHaveProperty('maxSelections');
  });

  it('rejects a minimum larger than the number of options', () => {
    const parsed = createEventSchema.safeParse({
      ...base,
      votingType: 'MULTIPLE_CHOICE',
      minSelections: 5,
      maxSelections: 5,
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(toFieldErrors(parsed.error)).toHaveProperty('minSelections');
  });

  it('rejects a dangerous option image URL', () => {
    for (const hostile of ['javascript:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=', 'not-a-url']) {
      const parsed = createEventSchema.safeParse({
        ...base,
        options: [
          { name: 'A', imageUrl: hostile, displayOrder: 0, isActive: true },
          { name: 'B', displayOrder: 1, isActive: true },
        ],
      });

      expect(parsed.success, `expected ${hostile} to be rejected`).toBe(false);
    }
  });

  it('rejects an unusable slug', () => {
    for (const bad of ['Has Spaces', 'trailing-', '../escape', 'ab', 'double--hyphen-']) {
      expect(
        createEventSchema.safeParse({ ...base, slug: bad }).success,
        `expected slug ${bad} to be rejected`,
      ).toBe(false);
    }
  });

  it('lowercases a slug rather than rejecting it', () => {
    // Typing the slug in capitals is a mistake worth fixing silently, not an
    // error worth blocking the form over.
    const parsed = createEventSchema.safeParse({ ...base, slug: '  GUILD-Election-2026 ' });

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.slug).toBe('guild-election-2026');
  });

  it('applies the same cross-field rules when updating', () => {
    // The update path must not be a way around rules the create path enforces.
    const parsed = updateEventSchema.safeParse({
      id: 'abc12345',
      ...base,
      startsAt: '2026-09-17T20:00:00Z',
      endsAt: '2026-09-15T20:00:00Z',
    });

    expect(parsed.success).toBe(false);
  });
});

describe('option checkboxes - an absent checkbox means false', () => {
  const base = {
    id: 'option12345',
    eventId: 'event123456',
    name: 'PlayerOne',
    displayOrder: '0',
  };

  it('reads an unticked "available" checkbox as inactive', () => {
    // An unchecked HTML checkbox submits NOTHING. If the schema defaulted this
    // to true, unticking the box and saving would silently keep the option
    // active - i.e. an option could never be withdrawn through the UI.
    const parsed = updateOptionSchema.safeParse(base);

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.isActive).toBe(false);
  });

  it('reads a ticked checkbox as active', () => {
    const parsed = updateOptionSchema.safeParse({ ...base, isActive: 'on' });

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.isActive).toBe(true);
  });

  it('still accepts an explicit boolean from a JSON payload', () => {
    // The create-event form serialises its options to JSON, where `isActive`
    // is a real boolean rather than the string "on".
    for (const value of [true, false]) {
      const parsed = updateOptionSchema.safeParse({ ...base, isActive: value });

      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.isActive).toBe(value);
    }
  });
});

describe('formDataToObject', () => {
  it('collapses repeated keys into an array', () => {
    // Without this, a multiple-choice ballot would silently keep only the last
    // selection and quietly discard the rest.
    const formData = new FormData();
    formData.append('optionIds', 'a');
    formData.append('optionIds', 'b');
    formData.append('optionIds', 'c');
    formData.append('eventSlug', 'my-event');

    expect(formDataToObject(formData)).toEqual({
      optionIds: ['a', 'b', 'c'],
      eventSlug: 'my-event',
    });
  });

  it('ignores file entries', () => {
    const formData = new FormData();
    formData.append('name', 'ok');
    formData.append('upload', new Blob(['x']), 'x.txt');

    expect(formDataToObject(formData)).toEqual({ name: 'ok' });
  });
});
