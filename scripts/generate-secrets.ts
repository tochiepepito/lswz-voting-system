/**
 * Print a fresh set of application secrets.
 *
 *   npm run secrets:generate
 *
 * Each is 32 bytes from the OS CSPRNG, base64-encoded.
 *
 * IGN_HASH_PEPPER is effectively permanent: it keys the HMAC that derives
 * `Voter.nameHash`, so rotating it orphans every existing voter identity and
 * every historical ballot's link to a name. Generate it once, keep it in your
 * secret store, and never roll it on a live system.
 *
 * SESSION_TOKEN_PEPPER can be rotated freely - the cost is that every signed-in
 * administrator and every active voter session is logged out at once.
 *
 * IP_HASH_PEPPER can be rotated too; past IP-based correlation in the audit log
 * simply stops matching new entries.
 */

import { randomBytes } from 'node:crypto';

const SECRETS = [
  ['IGN_HASH_PEPPER', 'Keys the voter identity hash. Treat as permanent.'],
  ['IP_HASH_PEPPER', 'Keys IP and user-agent hashes. Rotatable.'],
  ['SESSION_TOKEN_PEPPER', 'Keys session lookup and CSRF tokens. Rotating logs everyone out.'],
] as const;

console.log('\n# Generated secrets - paste into .env (or your secret manager)\n');

for (const [name, note] of SECRETS) {
  console.log(`# ${note}`);
  console.log(`${name}="${randomBytes(32).toString('base64')}"\n`);
}

console.log('# Never commit these. Never reuse them between environments.\n');
