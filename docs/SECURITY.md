# Security model

This document is deliberately blunt about what the system does and does not
guarantee. Read it before running an election that matters.

---

## 1. The honest claim

**IGN-based voting provides community-level verification, not identity
verification.**

An in-game name is a string a player types into a box. There is no password, no
e-mail, no token — nothing to verify it against. Therefore:

> The system **cannot** guarantee that one human casts one vote.

What it does guarantee, and enforces in the database rather than in application
logic:

- one **normalised IGN** can hold at most one counted ballot per event
- one **browser session** can cast at most `maxVotesPerSession` ballots (default 1)
- every decision about a vote is made **server-side**, from server state
- every consequential action leaves an **audit record**

And what it provides as deterrence and evidence rather than prevention:

- rate limiting per browser session and per IP
- flagging of look-alike names, network concentration and shared browsers
- an optional CAPTCHA per event
- a moderation surface where a human can invalidate or void ballots, with a
  recorded reason

### What a determined attacker can still do

Stated plainly, because pretending otherwise is worse than the gap itself:

| Attack | Status |
|---|---|
| Vote twice with the same name | **Blocked** — database constraint |
| Vote twice with different capitalisation or spacing | **Blocked** — normalisation |
| Vote again in a private window under the same name | **Blocked** — constraint is on the name, not the cookie |
| Vote again in a private window under a *different* name | **Not blocked.** Flagged if the names look alike or the network is concentrated. |
| Vote as a real guild-mate who has not voted yet | **Not blocked.** This is the fundamental limit: their name is not a secret. |
| Invent plausible names and stuff the ballot | **Not blocked**, but rate-limited, flagged, and visible in the audit log and participant export |

The intended control for the last three is **social**: organisers know their
community, and the participant export lists exactly which names voted. A ballot
cast under a name that is not on the roster is visible and removable.

If you need more than that, see [Stronger verification](#6-stronger-verification).

---

## 2. Identity handling

### Normalisation

Every IGN passes through `normalizeIgn()` before it is used for anything:

1. Unicode **NFKC** — full-width and compatibility characters fold to canonical
   equivalents, so `Ｐｌａｙｅｒ` is not a second identity.
2. **Invisible characters stripped** — zero-width spaces, joiners, bidi overrides,
   BOM. These are the standard way to mint a name that renders identically to a
   human moderator but differs byte-for-byte.
3. **Whitespace collapsed**, including non-breaking and ideographic spaces. Tabs
   and newlines count as whitespace and are collapsed, not rejected — a player
   pasting from Discord legitimately brings one along.
4. **Non-whitespace control characters rejected** outright, rather than stripped,
   so a name built from them fails loudly instead of silently becoming another.
5. **Case folded** with `toLowerCase()` — not a locale-aware fold, because the
   result is a storage key and must be byte-identical in every server locale.
6. **Character allow-list** — Unicode letters, numbers and marks plus
   `. _ - ' ( ) [ ]`, and it must start and end alphanumerically. Angle brackets
   and quotes cannot appear in a name at all.
7. **Length measured in code points**, not UTF-16 units, so astral-plane
   characters are counted the way a player would count them.

Three representations are stored, for three different jobs:

| Column | Job |
|---|---|
| `displayName` | shown in the UI, exactly as typed |
| `normalizedName` | **the** identity comparison key |
| `nameHash` | keyed HMAC of the normalised name — a stable lookup key that keeps working if the plaintext columns are ever purged |

A fourth value, `confusableKey`, folds homoglyphs and drops separators so
`PlayerOne`, `P1ayer_One` and `Pl ayer.0ne` share a key. It is used **only** to
flag near-duplicates for a human. It is far too aggressive to be an identity:
`Shadow` and `5hadow` collide under it and may well be two real players, so both
ballots count and the pair is merely flagged.

### Why HMAC rather than a plain hash

`nameHash`, `ipHash` and `userAgentHash` are all **keyed** HMACs under a secret
pepper. A bare SHA-256 of an IGN or an IPv4 address is trivially brute-forced from
a database dump — the keyspace is tiny. An HMAC under a pepper the attacker does
not have is not.

`IGN_HASH_PEPPER` is effectively permanent: rotating it orphans every existing
voter identity and every historical ballot's link to a name.

---

## 3. Sessions and cookies

### The cookies

| Cookie | Contents | Flags |
|---|---|---|
| `gev_voter` | a 256-bit random token, nothing else | HttpOnly, Secure (prod), SameSite=Lax, Path=/ |
| `gev_admin` | a 256-bit random token, nothing else | HttpOnly, Secure (prod), SameSite=**Strict**, Path=/ |

In production both gain the `__Host-` prefix, which browsers enforce: the cookie
is rejected unless it is Secure, `Path=/` and has no `Domain`. That makes it
impossible for a sibling subdomain to overwrite it — a real session-fixation
vector.

**Neither cookie contains an IGN, an event, a vote, or a `hasVoted` flag.** A voter
editing their own cookies can invalidate their session; they cannot change what
the server believes about them.

The database stores only the **HMAC** of each token, so a database leak yields no
usable session.

`SameSite=Lax` for voters is deliberate: ballots are reached by following a link
from Discord or Reddit, and `Strict` would drop the session on that first
navigation. Admin sessions use `Strict`, because nothing should ever link into an
authenticated admin action from another site.

### Nothing sensitive in client storage

No `localStorage`, no `sessionStorage`, no credentials in JavaScript-readable form
anywhere.

---

## 4. CSRF

Two independent layers on every state-changing request:

**Layer 1 — origin enforcement.** `Origin` is checked against the allow-list
derived from `APP_URL`. When absent, `Sec-Fetch-Site` is consulted. A JSON
endpoint additionally requires `Content-Type: application/json`, which a
cross-site HTML form cannot set.

**Layer 2 — a synchroniser token.** The token is `HMAC(pepper, "csrf-token:" +
sessionToken)`. That derivation matters:

- it needs no second cookie and no extra database column;
- it **cannot be computed by anyone who cannot read the session cookie**, which is
  exactly the property a synchroniser token needs;
- it is stable for the session, so it can be rendered into a server component and
  posted back from a form.

A cross-site attacker's request *does* carry the victim's cookie — that is how CSRF
works — but it cannot carry this value, because the attacker cannot read the cookie
to derive it.

Next.js applies its own origin check to Server Actions. Ours is a second,
independent layer that does not depend on framework internals staying put.

---

## 5. Authorisation

### Voters

Voters have no privileges. Every public payload is built field-by-field by a
**presenter** (`server/presenters/public.ts`) rather than by spreading a database
row and deleting the sensitive parts — so a column added to `voting_events` next
year cannot appear in an API response by accident.

Never sent to a browser: internal event ids, vote ids, `createdById`,
`maxVotesPerSession`, `ipSoftLimit` (publishing your thresholds tells an attacker
exactly how far they can go), lifecycle timestamps, audit data, or any other
voter's name.

Option ids *are* published — a ballot has to name what it votes for. They are
opaque, and every submitted id is re-validated against **this event's** active
options inside the vote transaction, so a crafted request naming another event's
option is simply refused.

### Administrators

Three roles, resolved to a capability set on the server for every protected
action:

| Role | Capabilities |
|---|---|
| `SUPER_ADMIN` | everything, including managing administrators |
| `ADMIN` | events, options, results, vote and voter moderation |
| `AUDITOR` | read-only: results, audit, export |

**Enforcement points.** Every admin page calls `requireAdminPage(capability)`;
every Server Action and Route Handler calls `requireAdmin(capability)` as its
first statement. The navigation hides links a role cannot use, but that is
usability, not access control — a URL typed directly, or an action invoked by a
hand-crafted POST, hits the same guard.

**Middleware is not the access control.** `src/middleware.ts` runs on the Edge
runtime, where there is no database, so it can only see whether a cookie is
*present* — and anyone can set a cookie with the right name. It exists to give a
signed-out operator an instant redirect, nothing more. This is stated in a comment
at the top of the file so nobody mistakes it for a security boundary.

---

## 6. Stronger verification

The architecture anticipates this. `EventIdentityClaim.identityMethod` records
*how* an identity was established:

```
IGN_SELF_DECLARED   today's default — a typed name
DISCORD_OAUTH       a verified Discord account
GAME_ACCOUNT        a verified in-game account
VOTER_TOKEN         an admin-issued one-time code
ADMIN_VERIFIED      an organiser vouched in person
```

To add one: issue a claim with the new method from a new route, and add the method
to the event's `allowedIdentityMethods`. `VotingService.submitVote` reads whatever
claim it finds and records the method on the vote. **The vote transaction, the
duplicate constraint, the tallies, the results screens and the audit trail do not
change.**

For a high-stakes election today, the strongest option without new code is
admin-issued voting codes distributed out of band, combined with
`maxVotesPerSession = 1` and `requireCaptcha`.

---

## 7. Abuse controls

### Rate limiting

Fixed-window counters in MySQL — **not** in process memory, because the app
is expected to run as more than one instance (or on a platform where every request
may be a fresh isolate), and an in-memory limiter under those conditions
multiplies every limit by the instance count while appearing to work perfectly in
development.

| Scope | Default |
|---|---|
| votes per browser session | 10 / hour |
| votes per IP | 40 / hour |
| IGN claims per IP | 30 / 15 min |
| admin logins per IP | 10 / 15 min |
| admin logins per account | 10 / 15 min |

The per-account login limit is what stops a distributed password spray from
spreading across many IPs against one known administrator.

A fixed window permits a burst of up to 2× the limit across a boundary. That is an
accepted trade: the limits exist to stop scripted stuffing, and the duplicate-vote
constraint is what protects correctness.

**When no client IP can be determined, IP limits are skipped, not denied.** A
deployment behind a misconfigured proxy would otherwise take the whole election
offline — a far worse failure than a missing rate limit.

### IP handling

Raw IP addresses are **never** written to the database; only keyed HMACs. IPv6 is
collapsed to its **/64 prefix** before hashing, because a single household is
routinely handed a whole /64 and treating each address as a distinct actor would
make IPv6 limits meaningless.

IP is never used alone to block a vote. Guild-mates share networks, student halls
share networks, mobile carriers share CGNAT. Exceeding an event's `ipSoftLimit`
**flags** ballots for review; it never refuses them.

### Flagging, not blocking

Four signals are recorded on a vote, all of which have innocent explanations:

| Signal | Meaning |
|---|---|
| `IP_SOFT_LIMIT` | many ballots from one network |
| `CONFUSABLE_NAME` | name resembles another voter in this event |
| `SHARED_BROWSER` | a second ballot from this browser |
| `IMMEDIATE_SUBMISSION` | submitted under 2.5s after arriving |

Flagged ballots are **still counted**. Flagging means "a human should look at
this", not "this is fraud". An election that silently drops real votes is worse
than one that flags a few honest ones.

### Moderation

Two distinct operations, deliberately not merged:

- **Invalidate** — the row stays, drops out of every tally, reversible. The
  default.
- **Void for re-vote** — the row is deleted so its owner can vote again, *after*
  its full content is copied into the audit log. Needed because
  `votes(eventId, voterId)` is a plain unique constraint: an invalidated row still
  occupies the slot.

Both require a written reason and are audited against the acting administrator.

---

## 8. Admin authentication

**Passwords** use Node's built-in `scrypt` (N=2^15, r=8, p=1, 64-byte key, 16-byte
random salt). Chosen over bcrypt because it needs no native build toolchain, it is
memory-hard, and — unlike bcrypt — it does not silently truncate input at 72
bytes. Cost parameters travel inside each digest (`scrypt$N$r$p$salt$hash`), so
they can be raised later without invalidating existing passwords; a weaker digest
is transparently upgraded on the next successful sign-in.

**Anti-enumeration.** Every failure path of `login()` costs about the same
wall-clock time and returns the identical `INVALID_CREDENTIALS` error:

- an unknown e-mail is verified against a **decoy digest**, so it burns the same
  ~100ms as a real account;
- a **disabled** account is only reported as disabled *after* the password has
  been proven correct.

Without both, the login form is an oracle for "which e-mail addresses are
administrators here".

**Lockout.** 8 consecutive failures locks the account for 15 minutes. A correct
password during the lock is still refused, and the lock is audited.

**Session hygiene.** A fresh token is minted on every login (no session
fixation). Changing a password or deactivating an account revokes **every**
outstanding session — a password change that leaves old sessions alive protects
nothing.

**Password policy** is length-first: 12 characters minimum plus a blocklist of
obvious choices. The only composition rule is that the password is not a single
repeated character. Classic "one uppercase, one symbol" rules mostly produce
`Password1!`.

---

## 9. Injection and output safety

**SQL injection** — every query goes through Prisma's parameterised client. The
one piece of raw SQL (date-truncated grouping for the turnout chart) uses a tagged
template with bound parameters, including the granularity. Tested with live
injection payloads in the admin search.

**XSS** — React escapes all interpolated content. Beyond that, an IGN cannot
contain angle brackets or quotes at all, and option image URLs are restricted to
absolute `http(s)` (a `javascript:` or `data:` URL in an `<img src>` is a stored
XSS vector, and that field is admin-supplied text). A CSP is set in
`next.config.ts`.

**CSV formula injection** — a cell beginning with `=`, `+`, `-`, `@`, TAB or CR is
executed as a formula by Excel, Sheets and LibreOffice. Since export cells contain
attacker-chosen text, every such cell is prefixed with an apostrophe. Without
this, an IGN of `=HYPERLINK("http://evil","Click")` runs the moment an organiser
opens the export. The download filename is sanitised too, so a crafted event title
cannot break out of the `Content-Disposition` header.

**Error messages** — responses are built from an error **code**, never from
`error.message`. No database error, Prisma message or stack trace can reach a
client; unexpected errors are logged in full server-side and returned as a bare
`INTERNAL`.

---

## 10. Privacy

Stored: the IGN (display, normalised, hashed), keyed hashes of IP and user agent,
timestamps, and the ballot.

Never stored: e-mail, password, phone number, raw IP, raw user agent, or any other
personal data.

**Ballot secrecy.** Ballots are *not* anonymous to administrators — an organiser
can see which name chose what. That is a deliberate trade for a community system:
without it, duplicate accounts could not be investigated. Voters should be told.
If you need a secret ballot, drop the `Vote.voterId` link and keep only a per-event
participation marker — the tally queries do not depend on `voterId`.

**Retention.** `voters`, `voter_sessions` and `audit_logs` grow without bound.
Expired sessions can be deleted freely. Audit rows reference `voterId` as a plain
column precisely so that voter rows can be purged while history survives.

---

## 11. Reporting a problem

Include the audit-log entries around the incident (the admin Security screen
exports the window), the event slug, and — if a ballot is involved — its receipt
code. The receipt code identifies a ballot without revealing how it voted and
grants no ability to read or change anything.
