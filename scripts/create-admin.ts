/**
 * Create (or update) an administrator account from the command line.
 *
 *   npm run admin:create -- --email you@example.com --name "Your Name" --role SUPER_ADMIN
 *
 * This is how the FIRST administrator is created on a production deployment.
 * The seed script refuses to run against production, and there is deliberately
 * no self-registration anywhere in the application - an admin account can only
 * come from here or from an existing super administrator.
 *
 * The password is read from stdin (or generated) rather than taken as an
 * argument, so it never lands in the shell history or in `ps` output.
 */

import { PrismaClient } from '@prisma/client';
import { createInterface } from 'node:readline/promises';
import { randomBytes, scryptSync } from 'node:crypto';
import { stdin, stdout } from 'node:process';

// Node 20.12+ built-in; no dotenv dependency needed.
try {
  process.loadEnvFile();
} catch {
  // No .env file - fall back to the real environment (the normal case in CI
  // and on a PaaS where variables are injected).
}

const prisma = new PrismaClient();

const SCRYPT = { N: 2 ** 15, r: 8, p: 1 };
const KEY_LENGTH = 64;
const MAXMEM = 96 * 1024 * 1024;
const MIN_PASSWORD_LENGTH = 12;

const ROLES = ['SUPER_ADMIN', 'ADMIN', 'AUDITOR'] as const;
type Role = (typeof ROLES)[number];

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password.normalize('NFKC'), salt, KEY_LENGTH, {
    ...SCRYPT,
    maxmem: MAXMEM,
  });

  return [
    'scrypt',
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

function parseArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg?.startsWith('--')) continue;

    const key = arg.slice(2);
    const next = argv[index + 1];

    if (next && !next.startsWith('--')) {
      result[key] = next;
      index += 1;
    } else {
      result[key] = 'true';
    }
  }

  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const email = (args['email'] ?? '').trim().toLowerCase();
  const displayName = (args['name'] ?? '').trim();
  const role = (args['role'] ?? 'ADMIN') as Role;

  if (!email || !email.includes('@')) {
    throw new Error('Pass a valid --email address.');
  }
  if (!displayName) {
    throw new Error('Pass a --name for the account.');
  }
  if (!ROLES.includes(role)) {
    throw new Error(`--role must be one of: ${ROLES.join(', ')}`);
  }

  let password = '';
  let generated = false;

  if (args['generate-password'] === 'true') {
    // 24 base64url characters: comfortably beyond guessable, and safe to paste.
    password = randomBytes(18).toString('base64url');
    generated = true;
  } else {
    const rl = createInterface({ input: stdin, output: stdout });
    password = await rl.question('Password (input is visible): ');
    const confirm = await rl.question('Confirm password: ');
    rl.close();

    if (password !== confirm) throw new Error('The two passwords do not match.');
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`The password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  const passwordHash = hashPassword(password);

  const existing = await prisma.admin.findUnique({
    where: { email },
    select: { id: true },
  });

  const admin = await prisma.admin.upsert({
    where: { email },
    create: {
      email,
      displayName,
      passwordHash,
      role,
      isActive: true,
      mustChangePassword: generated,
    },
    update: {
      displayName,
      passwordHash,
      role,
      isActive: true,
      failedLoginCount: 0,
      lockedUntil: null,
      passwordChangedAt: new Date(),
    },
    select: { id: true, email: true, role: true },
  });

  // Changing a password must end every session that used the old one.
  if (existing) {
    const revoked = await prisma.adminSession.updateMany({
      where: { adminId: admin.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    console.log(`Updated existing account; revoked ${revoked.count} active session(s).`);
  }

  await prisma.auditLog.create({
    data: {
      action: existing ? 'ADMIN_PASSWORD_CHANGED' : 'ADMIN_CREATED',
      severity: 'NOTICE',
      actorType: 'SYSTEM',
      actorLabel: 'cli',
      adminId: admin.id,
      summary: existing
        ? `Password for "${admin.email}" was reset from the command line.`
        : `Administrator "${admin.email}" was created from the command line.`,
      metadata: { role: admin.role },
    },
  });

  console.log(`\n  ${existing ? 'Updated' : 'Created'}: ${admin.email}  (${admin.role})`);
  if (generated) console.log(`  Password: ${password}\n  Change it after the first sign-in.`);
  console.log('\nSign in at /admin/login\n');
}

main()
  .catch((error: unknown) => {
    console.error(`\nFailed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
