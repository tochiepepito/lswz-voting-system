/* eslint-disable no-restricted-imports -- this module *is* the sanctioned singleton */
import { Prisma, PrismaClient } from '@prisma/client';
import { isProduction } from './env';

/**
 * Shared PrismaClient.
 *
 * Next.js hot-reloads server modules in development, which would otherwise leak
 * a new connection pool on every edit until MySQL refuses connections, so
 * the instance is cached on `globalThis` outside production.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createClient(): PrismaClient {
  return new PrismaClient({
    log: isProduction ? ['error'] : ['warn', 'error'],
  });
}

export const prisma: PrismaClient = globalForPrisma.prisma ?? createClient();

if (!isProduction) {
  globalForPrisma.prisma = prisma;
}

/**
 * The client handed to an interactive `$transaction` callback. Repositories
 * accept this so the same method works inside or outside a transaction, which
 * is what keeps vote submission atomic without duplicating query code.
 */
export type DbClient = PrismaClient | Prisma.TransactionClient;

/** Unique-constraint violation (MySQL error 1062). */
export const PRISMA_UNIQUE_VIOLATION = 'P2002';
/** Foreign-key constraint violation. */
export const PRISMA_FK_VIOLATION = 'P2003';
/** Record required by the operation was not found. */
export const PRISMA_NOT_FOUND = 'P2025';

/** True when `error` is a Prisma unique-constraint violation. */
export function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === PRISMA_UNIQUE_VIOLATION
  );
}

/**
 * True when `error` is a unique-constraint violation touching *any* of the
 * given columns. Used to tell "this identity already voted" apart from an
 * unrelated collision such as a duplicated receipt code.
 *
 * CONNECTOR DIFFERENCE, and why the matching looks like this:
 *
 *   PostgreSQL  meta.target = ['eventId', 'voterId']        (column names)
 *   MySQL       meta.target = 'votes_eventId_voterId_key'   (the INDEX name)
 *
 * So the target is reduced to underscore-delimited tokens and compared
 * exactly. Substring matching would be wrong: `'name'` would match the index
 * `voters_nameHash_key` and misreport a voter-identity collision as a duplicate
 * option name. Column names in this schema are camelCase and contain no
 * underscore, so tokenising is unambiguous.
 */
export function isUniqueViolationOn(error: unknown, ...fields: string[]): boolean {
  if (!isUniqueViolation(error)) return false;

  const target = (error as Prisma.PrismaClientKnownRequestError).meta?.['target'];
  const raw = Array.isArray(target) ? target.map(String) : [String(target ?? '')];

  const tokens = new Set(raw.flatMap((entry) => entry.split('_')));

  return fields.some((field) => tokens.has(field));
}

export { Prisma };
