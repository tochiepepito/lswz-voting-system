# Game Event Voting System

Login-free voting and elections for online gaming communities. Voters enter their
in-game name and cast a ballot — no account, no password, no e-mail. Organisers get
a full admin dashboard with results, turnout charts, an audit trail and vote
moderation.

Built with Next.js (App Router), TypeScript, React, Tailwind CSS, MySQL and
Prisma.

---

## Read this first: the security model

**This system cannot guarantee one human = one vote, and it does not pretend to.**

An in-game name is a string a player types. Anyone can type someone else's name.
There is no credential, so there is nothing to verify. What the system actually
provides is:

```
one normalised IGN
  + one anonymous browser session
  + server-side validation of every decision
  + database-level uniqueness constraints
  + rate limiting and abuse flagging
  + a complete audit trail
```

That is **community-level verification**: strong enough that casual double-voting
fails and organised ballot-stuffing leaves visible evidence, while keeping the
voter experience to two taps. It is *not* cryptographic identity verification.

If your election needs a real guarantee, the architecture is built to accept one —
see [Adding stronger verification](#adding-stronger-verification). Full threat
model in **[docs/SECURITY.md](docs/SECURITY.md)**.

---

## Architecture

### The five decisions that shape everything else

**1. Identity is a *claim*, never an authentication.** Three concepts a naive
design would merge are deliberately kept apart:

| Model | What it is | Lifetime |
|---|---|---|
| `Voter` | a normalised in-game identity (`displayName` / `normalizedName` / `nameHash`) | permanent, global |
| `VoterSession` | an opaque *browser* credential, held in an HTTP-only cookie | 30 days |
| `EventIdentityClaim` | "this browser claims to be this Voter, **for this event**" | per event |

Because the claim carries an `identityMethod`, adding Discord or game-account
verification later is a new enum member and a new claim-issuing route. Votes,
tallies, results and audit code do not change.

**2. The database is the last word on duplicate votes.**
`@@unique([eventId, voterId])` on `Vote` is the guarantee. The application's
"have you already voted?" check is a fast path for a friendly error message —
under a genuine race *both* requests pass it, because both read before either
writes. MySQL decides the winner. `tests/integration/concurrency.test.ts`
attacks the constraint directly to prove the claim.

**3. Nothing the browser sends is trusted.** A vote request carries only option
ids and an optional CAPTCHA token. The event, its status, its schedule, the
selectable options, the voter's identity and whether they have already voted are
all re-read from the database *inside the vote transaction*.

**4. Public API = Route Handlers; admin mutations = Server Actions.** Route
handlers give the voter flow an explicit, testable HTTP surface. Server Actions
give admin mutations Next's built-in origin protection plus our own synchroniser
token. **Both are thin shells over the same services** — one implementation of
the rules, no chance of the two paths disagreeing.

**5. Lazy status reconciliation, so a missing cron job is not a correctness bug.**
An event's stored status and its schedule can disagree. Rather than depending on a
scheduler, every read reconciles the row it loaded, and `lib/voting-rules` treats
the clock as authoritative regardless of the column. A deployment with no
scheduler at all is still correct: a missed job can never extend an election or
lock voters out of a live one.

### Layers

```
app/                  routes only — no business logic
  api/                public Route Handlers (voter flow)
  events/             voter UI (4 screens)
  admin/(dashboard)/  admin UI, behind an auth guard

server/
  actions/            Server Actions — auth + CSRF, then delegate
  services/           ALL business logic lives here
  repositories/       data access; owns every `select` shape
  presenters/         the allow-list boundary for public payloads
  auth/               requireAdmin / requireAdminPage / CSRF

lib/                  env, prisma, crypto, cookies, http (server-leaning)
                      ign, voting-rules, errors, result, format, csv, slug (pure)
schemas/              Zod — the only place untrusted input becomes typed data
types/                domain enums, independent of generated Prisma code
```

Dependencies point one way: `app → actions/api → services → repositories → prisma`.
A component never queries the database and a repository never makes a decision.

> **One convention worth knowing:** a value the UI needs may not live in a module
> that imports a Node built-in. `PASSWORD_MIN_LENGTH` sits in
> `lib/password-policy.ts`, not `lib/crypto.ts`, because importing it from a
> client component would pull `node:crypto` into the browser bundle. The build
> catches this; the split documents why.

### Services

| Service | Owns |
|---|---|
| `VotingService` | ballot submission, the transaction, moderation |
| `VoterService` | sessions, IGN claims, abuse heuristics |
| `EventService` | event lifecycle, options, status reconciliation |
| `ResultsService` | tallies, turnout, visibility rules, CSV export |
| `AdminService` | authentication, sessions, accounts |
| `AuditService` | the audit trail |
| `RateLimitService` | fixed-window counters |
| `CaptchaService` | optional Turnstile verification |

### The vote path

```
POST /api/events/:slug/vote   (or the submitVote Server Action)
  │
  ├─ origin check + CSRF synchroniser token
  ├─ Zod: option ids are id-shaped, and nothing else is read from the body
  ├─ event is public, and open by status AND clock
  ├─ session cookie → VoterSession → EventIdentityClaim → Voter
  ├─ voter / session block checks
  ├─ rate limit: per session, then per IP
  ├─ CAPTCHA, if this event requires one
  │
  └─ TRANSACTION ─────────────────────────────────────────
       re-read the event, re-assert it is open
       read THIS event's active option ids
       validate min / max / duplicates / membership
       per-browser ballot limit
       compute suspicion signals
       INSERT vote + selections      ← unique(eventId, voterId)
       INSERT audit row              ← same transaction
     ─────────────────────────────────────────────────────
```

The audit write is *inside* the transaction: a vote that cannot be recorded in
the audit trail is rolled back rather than kept silently.

---

## Getting started

### Requirements

- Node.js **20.9+** (the pinned dependency set targets Node 20)
- MySQL **8.0+** (MySQL Workbench is a convenient way to create the schema)

### Setup

```bash
npm install

cp .env.example .env
npm run secrets:generate        # paste the three secrets into .env
#   then set DATABASE_URL

npm run db:migrate              # create the schema
npm run db:seed                 # dev only: an admin + 3 example events

npm run dev                     # http://localhost:3000
```

The seed prints the sign-in details. Voters go to `/events`; organisers to
`/admin/login`.

### Environment

Every variable is documented inline in [`.env.example`](.env.example). The three
that matter most:

| Variable | Notes |
|---|---|
| `IGN_HASH_PEPPER` | Keys the HMAC deriving `Voter.nameHash`. **Treat as permanent** — rotating it orphans every existing voter identity. |
| `SESSION_TOKEN_PEPPER` | Keys session lookup and CSRF tokens. Rotatable; rotating signs everyone out. |
| `TRUSTED_PROXY_HOPS` | How many reverse proxies you own. **`0` disables IP protection entirely.** Get this right — see below. |

#### `TRUSTED_PROXY_HOPS` — the one easy thing to get wrong

`X-Forwarded-For` is client-controlled unless a proxy *you own* appended the entry
you read:

```
XFF:  <spoofed>, <spoofed>, <real client>, <your proxy>
                             ^ hops = 1 reads here
```

With `hops = 0` the header is ignored and IP-based protection is simply **off**.
That is the honest default for a direct-to-Node deployment — better than trusting
a header any client can forge. Set it to the number of proxies in front of the
app (Vercel / Fly / most PaaS = `1`).

Validation runs at boot, so a misconfigured deployment fails immediately and
loudly rather than behaving insecurely during an election.

---

## Database

### Schema

```
admins ──< admin_sessions
  └──< voting_events ──< voting_options ──< vote_selections >── votes
            │                                                     │
            ├──< event_identity_claims >── voters ────────────────┘
            │          │
            │     voter_sessions
            └──< audit_logs
rate_limit_records  (standalone)
```

Constraints that carry real weight:

| Constraint | Why |
|---|---|
| `votes (eventId, voterId)` UNIQUE | **the** duplicate-vote guarantee |
| `event_identity_claims (eventId, sessionId)` UNIQUE | one identity per browser per event |
| `voters.normalizedName` / `voters.nameHash` UNIQUE | one row per identity |
| `vote_selections.optionId` → `RESTRICT` | an option with votes can be deactivated, never deleted |
| `votes.voterId` → `RESTRICT` | a voter with ballots cannot be deleted out from under them |

`audit_logs.voterId` is deliberately a plain column, not a foreign key, so audit
history survives voter data being purged.

### Migrations

```bash
npm run db:migrate                      # dev: create + apply a migration
npm run db:deploy                       # apply committed migrations (no shadow DB)
npm run db:reset                        # dev only: DROP everything and re-apply
npx prisma migrate status               # what is applied where
```

An initial migration is committed at
`prisma/migrations/20260912000000_init/`. Generated from the schema with
`prisma migrate diff`, so `db:deploy` works against an empty database with no
further steps.

**`P3014: could not create the shadow database`.** `prisma migrate dev` builds a
temporary database to detect drift between the migration history and the schema,
and a least-privilege MySQL account cannot create one. Two ways out:

- **Just apply the migrations:** `npm run db:deploy` never uses a shadow
  database. This is what production does anyway.
- **Grant the pattern** (development only), so `migrate dev` works when you
  change the schema later:

  ```sql
  GRANT ALL PRIVILEGES ON `prisma\_migrate\_shadow\_db%`.* TO 'voting'@'localhost';
  FLUSH PRIVILEGES;
  ```

  The `\_` escapes are required: an unescaped `_` is a single-character wildcard
  in a MySQL grant pattern, so the unescaped form would match far more databases
  than intended. This stays much narrower than granting global
  `CREATE DATABASE`. Both statements are in
  [`prisma/setup-mysql.sql`](prisma/setup-mysql.sql).

**Connection pooling.** Prisma manages its own MySQL pool, sized on the URL:
`?connection_limit=10&pool_timeout=20`. Keep `connection_limit` at or below the
server's `max_connections` divided by the number of app instances, or a busy
election will exhaust the server's connection slots.

**Creating the database.** Prisma Migrate creates *tables*, not the schema itself.
Create `voting_system` first — in MySQL Workbench, or with one statement:

```sql
CREATE DATABASE voting_system
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;
```

`utf8mb4` is not optional: the default `utf8` in older MySQL is three bytes and
cannot store astral-plane characters, which appear in real player names.

---

## Testing

```bash
npm test                  # unit suite — no database, no network
npm run test:integration  # integration suite — needs a real MySQL database
npm run test:all          # both
npm run typecheck
npm run lint
```

### Unit suite — 123 tests, no database

`tests/unit/` covers the pure logic: IGN normalisation (case folding, Unicode
NFKC, invisible-character stripping, length by code point, injection payloads),
the complete voting ruleset (selection bounds, phases, the full
results-visibility matrix), crypto (scrypt round-trip, tampered digests, domain
separation), every validation schema, and the security helpers (CSV formula
injection, IPv6 /64 grouping, error-taxonomy leak checks).

### Integration suite — 66 tests, needs MySQL

```bash
# Any throwaway database. The suite TRUNCATES tables and refuses to run
# against a URL that does not look like a test database.
export TEST_DATABASE_URL="mysql://voting:voting@localhost:3306/voting_system_test"
npx prisma migrate deploy          # with DATABASE_URL=$TEST_DATABASE_URL
npm run test:integration
```

Covers valid and invalid votes, voting outside the event window, duplicate votes
across browsers and capitalisations, multiple-choice limits, cross-event option
ids, blocked voters and sessions, admin login / lockout / enumeration resistance,
rate limiting, results visibility, injection payloads against live queries — and
**concurrency**: simultaneous submissions from one identity, proven to produce
exactly one row both through the service and by attacking the constraint directly.

The suite exercises the real services. `next/headers` is aliased to an in-memory
cookie jar so `cookies()` works outside a request — nothing in `src/` changes for
tests, only the transport.

Every spec self-skips when `TEST_DATABASE_URL` is absent, so CI without a database
is a no-op rather than a failure.

---

## Production deployment

### 1. Before you deploy

```bash
npm run secrets:generate     # fresh secrets — never reuse across environments
```

- `APP_URL` must be the exact public origin, **https** (enforced at boot: session
  cookies are issued `Secure`, and in production the `__Host-` cookie prefix
  requires it).
- Set `TRUSTED_PROXY_HOPS` to match your infrastructure.
- Never deploy with the `.env.example` placeholder secrets — boot validation
  refuses to start.

### 2. Build and migrate

```bash
npm ci
npm run db:deploy            # apply migrations BEFORE the new code goes live
npm run build                # runs prisma generate, typecheck and lint
npm start
```

`next build` does not need a live database or real secrets — it issues no cookies
and serves no requests, so those rules relax during the build phase and are
enforced strictly at runtime. A CI pipeline can compile without production
credentials in scope.

### 3. Create the first administrator

There is no self-registration anywhere in the application, and the seed script
refuses to run against production.

```bash
npm run admin:create -- --email you@example.com --name "Your Name" --role SUPER_ADMIN
```

The password is read from stdin, so it never lands in shell history or `ps`
output. `--generate-password` prints a strong one and flags the account for a
forced change at first sign-in.

### 4. Operating notes

- **Security headers** (CSP, HSTS-adjacent, frame/sniff protection) are set in
  `next.config.ts` so they cover static assets and error pages too.
- **Housekeeping is opportunistic.** Expired rate-limit windows are pruned on
  roughly 1 request in 200, so no scheduler is required. If you want tidy stored
  statuses, call `EventService.reconcileAll()` from a cron job — correctness does
  not depend on it.
- **Backups.** `votes`, `vote_selections` and `audit_logs` are the election
  record. Back them up before and after every significant event.

### Platform notes

Works on any Node host. On serverless (Vercel), use a MySQL service that tolerates
many short-lived connections (PlanetScale, or MySQL behind ProxySQL) and keep
`connection_limit` low. Rate-limit counters live in the database precisely so that
multiple instances and cold isolates share one limit — an in-memory limiter would
silently multiply every limit by the instance count.

---

## Adding stronger verification

The extension point is `IdentityMethod` on `EventIdentityClaim`. To add, say,
Discord verification:

1. Add `DISCORD_OAUTH` to the enum (already present).
2. Add a route that completes the OAuth flow and issues a claim with that method.
3. Add the method to the event's `allowedIdentityMethods`.

`VotingService.submitVote` reads the claim it finds and records the method on the
vote. The transaction, the duplicate constraint, the tallies, the results screens
and the audit trail are untouched. The same shape fits one-time voting codes,
admin-issued tokens or a game-API lookup.

---

## Error handling

Every user-visible failure is one of the codes in `lib/errors.ts`, each with one
pre-written message. Responses are built from the **code**, never from
`error.message`, so no database error, Prisma message or stack trace can reach a
client. Unexpected errors are logged server-side in full and returned as a bare
`INTERNAL`. There is a test asserting no catalogue message mentions Prisma, SQL or
`undefined`.

## Accessibility & mobile

The voter interface is built for a phone first: 44px minimum touch targets, a
sticky submit bar (a button below the fold is the main reason ballots get
abandoned), visible focus rings, `aria-live` selection counts, and a table view
beside every chart. Timestamps render in UTC on the server and upgrade to the
viewer's timezone after mount, which avoids a hydration mismatch on every date.
Colour is never the only carrier of meaning, and the chart palette is validated
for contrast and colour-vision deficiency in both themes.

## Licence

Provided as-is for community use.
