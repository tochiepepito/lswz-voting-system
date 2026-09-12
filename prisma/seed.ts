import { PrismaClient } from '@prisma/client';
import { createHmac, randomBytes, scryptSync } from 'node:crypto';

/**
 * Development seed.
 *
 * Creates a super administrator plus three example events that exercise all
 * three voting types, so the whole interface can be explored immediately after
 * `npm run db:migrate`.
 *
 * IDEMPOTENT: every write is an upsert keyed on a natural unique column, so
 * running it twice changes nothing and never throws. Safe to re-run after a
 * schema change.
 *
 * The crypto here is duplicated from `src/lib/crypto.ts` rather than imported,
 * because the seed runs under plain `tsx` with no path aliases and no validated
 * env module. The scrypt parameters and the digest encoding must stay in step
 * with that file - there is a unit test asserting exactly that.
 */

const prisma = new PrismaClient();

const SCRYPT = { N: 2 ** 15, r: 8, p: 1 };
const KEY_LENGTH = 64;
const MAXMEM = 96 * 1024 * 1024;

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password.normalize('NFKC'), salt, KEY_LENGTH, {
    ...SCRYPT,
    maxmem: MAXMEM,
  });

  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), derived.toString('base64')].join(
    '$',
  );
}

function hashNormalizedIgn(normalizedName: string): string {
  const pepper = process.env['IGN_HASH_PEPPER'];
  if (!pepper) throw new Error('IGN_HASH_PEPPER is not set. Copy .env.example to .env first.');

  return createHmac('sha256', pepper).update(`ign:${normalizedName}`).digest('hex');
}

function confusableKey(normalizedName: string): string {
  return normalizedName
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[0о]/gu, 'o')
    .replace(/[1l|]/gu, 'l')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

const DAY = 24 * 60 * 60 * 1000;

async function main() {
  const email = (process.env['SEED_ADMIN_EMAIL'] ?? 'admin@example.com').toLowerCase();
  const password = process.env['SEED_ADMIN_PASSWORD'] ?? 'ChangeMe!Dev12345';
  // Read from the environment rather than hard-coded, so this script stays
  // generic and each deployment's identity lives in its own .env.
  const displayName = process.env['SEED_ADMIN_NAME'] ?? 'Seed Administrator';

  if (process.env['NODE_ENV'] === 'production') {
    throw new Error(
      'Refusing to seed a production database. Use `npm run admin:create` to create the first administrator instead.',
    );
  }

  // --- Administrator ---------------------------------------------------
  const admin = await prisma.admin.upsert({
    where: { email },
    create: {
      email,
      displayName,
      passwordHash: hashPassword(password),
      role: 'SUPER_ADMIN',
      mustChangePassword: true,
    },
    // Keep the name in step on a re-seed, but never touch the password: an
    // operator who has already changed theirs should not be reset by a seed.
    update: { displayName },
    select: { id: true, email: true },
  });

  console.log(`admin ready: ${admin.email}`);

  const now = Date.now();

  // --- 1. An open single-choice election -------------------------------
  const election = await prisma.votingEvent.upsert({
    where: { slug: '2026-guild-officer-election' },
    create: {
      slug: '2026-guild-officer-election',
      title: '2026 Guild Officer Election',
      description:
        'Choose the next Guild President. Each member may vote once.\n\nThe candidate with the most votes takes office at the start of next season.',
      instructions: 'Read each candidate statement, then choose ONE candidate.',
      votingType: 'SINGLE_CHOICE',
      status: 'ACTIVE',
      minSelections: 1,
      maxSelections: 1,
      startsAt: new Date(now - 2 * DAY),
      endsAt: new Date(now + 5 * DAY),
      resultsVisibility: 'AFTER_CLOSE',
      publishedAt: new Date(now - 3 * DAY),
      openedAt: new Date(now - 2 * DAY),
      createdById: admin.id,
      options: {
        create: [
          {
            name: 'PlayerOne',
            description: 'Experienced guild member. Six years raiding, three as an officer.',
            displayOrder: 0,
          },
          {
            name: 'PlayerTwo',
            description: 'Runs the weekly PvP nights and the newcomer mentoring programme.',
            displayOrder: 1,
          },
          {
            name: 'PlayerThree',
            description: 'Long-standing crafter and quartermaster. Wants a bigger guild bank.',
            displayOrder: 2,
          },
        ],
      },
    },
    update: {},
    select: { id: true, title: true, options: { select: { id: true, name: true } } },
  });

  // --- 2. An open multiple-choice rules poll ---------------------------
  await prisma.votingEvent.upsert({
    where: { slug: 'season-12-rule-changes' },
    create: {
      slug: 'season-12-rule-changes',
      title: 'Season 12 Rule Changes',
      description: 'Which rules should we adopt for the coming season? Pick up to three.',
      instructions: 'Choose the changes you support. You can select up to three.',
      votingType: 'MULTIPLE_CHOICE',
      status: 'ACTIVE',
      minSelections: 1,
      maxSelections: 3,
      startsAt: new Date(now - DAY),
      endsAt: new Date(now + 3 * DAY),
      // Live tally: rule polls are more fun when everyone can watch.
      resultsVisibility: 'WHILE_VOTING',
      publishedAt: new Date(now - DAY),
      openedAt: new Date(now - DAY),
      createdById: admin.id,
      options: {
        create: [
          { name: 'Raid sign-ups close 24h ahead', displayOrder: 0 },
          { name: 'Loot council replaces DKP', displayOrder: 1 },
          { name: 'Mandatory voice chat on progression nights', displayOrder: 2 },
          { name: 'Weekly guild bank contribution', displayOrder: 3 },
          { name: 'Alt characters get full raid priority', displayOrder: 4 },
        ],
      },
    },
    update: {},
    select: { id: true },
  });

  // --- 3. A scheduled yes/no vote --------------------------------------
  await prisma.votingEvent.upsert({
    where: { slug: 'adopt-new-pvp-rule' },
    create: {
      slug: 'adopt-new-pvp-rule',
      title: 'Should the guild adopt the new PvP rule?',
      description:
        'The proposed rule bans premade groups from the Tuesday scrimmage so newer players get games.',
      votingType: 'YES_NO',
      status: 'SCHEDULED',
      minSelections: 1,
      maxSelections: 1,
      startsAt: new Date(now + 2 * DAY),
      endsAt: new Date(now + 9 * DAY),
      resultsVisibility: 'AFTER_VOTING',
      publishedAt: new Date(now - 60_000),
      createdById: admin.id,
      options: {
        create: [
          { name: 'Yes', displayOrder: 0 },
          { name: 'No', displayOrder: 1 },
        ],
      },
    },
    update: {},
    select: { id: true },
  });

  // --- Sample ballots on the election ----------------------------------
  // Gives the results dashboard and the turnout chart something to render.
  const sampleVoters = [
    'Aeloria', 'Brannick', 'Cindershard', 'Dawnrunner', 'Emberfall',
    'Frostlyn', 'Grimward', 'Hollowbane', 'Ironveil', 'Jadeclaw',
    'Kestrelwing', 'Lorehaven', 'Mistvale', 'Nightbloom', 'Oakenshield',
  ];

  let created = 0;

  for (const [index, displayName] of sampleVoters.entries()) {
    const normalizedName = displayName.toLowerCase();

    const voter = await prisma.voter.upsert({
      where: { nameHash: hashNormalizedIgn(normalizedName) },
      create: {
        displayName,
        normalizedName,
        nameHash: hashNormalizedIgn(normalizedName),
        confusableKey: confusableKey(normalizedName),
      },
      update: {},
      select: { id: true },
    });

    // Weight the sample so the tally is not a three-way tie.
    const choice = index % 7 === 0 ? 2 : index % 3 === 0 ? 1 : 0;
    const option = election.options[choice];
    if (!option) continue;

    const existing = await prisma.vote.findUnique({
      where: { eventId_voterId: { eventId: election.id, voterId: voter.id } },
      select: { id: true },
    });

    if (existing) continue;

    await prisma.vote.create({
      data: {
        eventId: election.id,
        voterId: voter.id,
        identityMethod: 'IGN_SELF_DECLARED',
        receiptCode: `SEED-${index.toString().padStart(4, '0')}-DEMO`,
        suspicionReasons: [],
        castAt: new Date(now - (sampleVoters.length - index) * 3 * 3_600_000),
        selections: { create: [{ optionId: option.id }] },
      },
    });

    created += 1;
  }

  console.log(`seeded 3 events and ${created} sample ballots`);
  console.log(`\nSign in at /admin/login\n  ${email}\n  ${password}\n`);
}

main()
  .catch((error) => {
    console.error('seed failed:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
