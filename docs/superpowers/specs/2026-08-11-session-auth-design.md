# Session auth — design

**Status:** approved 2026-08-11. Spec **A** of three; prerequisite for the
player UI (`2026-08-11-player-ui-design.md`).

## The problem

Order entry is CLI-only, so whoever has the shell can submit as any faction and
read every faction's deploys, attacks and `protect` picks straight out of
SQLite. The web app cannot exist until a request can be attributed to a faction
without the request saying which.

## Shape

```
/login   →  bolt verifies the Slack signature, yielding a trusted user_id
         →  roster: user_id → factionId
         →  mint a token, store its HASH, 10-minute TTL
         →  DM the link
                                  ↓
browser  →  /login/:token  →  validate, delete it, create a session,
                              set the cookie — all in one transaction
```

**`/login` lives in the Slack bot, not the web app.** Bolt already verifies
request signatures against `SLACK_SIGNING_SECRET` and rejects replays outside a
five-minute window. The web app never parses a Slack payload and never needs the
signing secret.

**The two processes talk through SQLite.** They already share the file in WAL
mode — the bot writes the slate and the recap ledger, the web app reads them.
A token row is the same pattern, not a new channel.

## Tokens

32 bytes from `crypto.randomBytes`, base64url, in a table keyed by its
**SHA-256 hash**.

**Hashed rather than raw**, for four lines of code. The database sits on the
same droplet as the app; if it ever leaks, hashed tokens mean the leak grants no
logins. The same reasoning that applies to passwords applies here — a magic link
*is* a credential.

**Single-use, ten-minute TTL, and up to five live tokens per person.** Minting
the sixth evicts the oldest.

*Amended 2026-08-11.* This was originally exactly one live token, enforced by a
`UNIQUE` on `slack_user_id` — "a new `/login` invalidates the previous" as a
property of the schema. In use that edge was sharper than the threat it
answered: running `/login` twice before clicking either, or an operator minting
a link on someone's behalf, silently killed the link the player was about to
use, and it surfaced as the generic "that link is no longer good". What actually
bounds exposure is the ten-minute TTL and single use, both unchanged; the cap
only keeps the table from growing without bound. Migration 6 rebuilds the table
without the constraint, carrying existing rows across so an outstanding link
still works.

Eviction is by insertion order (`rowid`) rather than `expires_at`: the TTL is a
constant, so two links minted in the same millisecond share an expiry and have
no tie-break. Expired rows are the oldest, so they are evicted first anyway and
never crowd out a live link.

**Consumption and session creation are one transaction.** The delete and the
insert commit together, so a link opened twice — a preview fetch, a double tap —
produces exactly one session rather than two, or one session and a dangling
token.

## Sessions

A `sessions` row: hashed token, `factionId`, `seasonId`, `expiresAt`.

**Expiry is the season's end.** Nobody is bounced mid-week, and certainly not at
20:55 — the worst outcome this design could produce is a player locked out
against a hard 21:00 deadline.

**Scoped to a season, deliberately.** A new season means everyone logs in again.
That is correct rather than incidental: a `factionId` only means something
within a season, and a session carried across one would point at a faction that
no longer exists.

**Revocation is a delete.** A lost phone is one row. This is the reason sessions
are a table rather than a signed stateless cookie — a signed cookie cannot be
revoked without rotating a secret and logging everyone out.

## The cookie

`HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`.

- **`HttpOnly`** because no client script needs it. The server reads the session
  and renders the projection; the browser never handles the credential.
- **`SameSite=Lax`** so a link from Slack still works, while a cross-site POST
  cannot forge an order. `Strict` would break the link people actually arrive
  through.
- **`Secure`** requires HTTPS, which Caddy already terminates for the Slack
  events endpoint.

## The not-on-roster reply

The message most people will actually see, so it is specified rather than left
to implementation.

Someone running `/login` before being rostered is the normal state of a new
player, not an error. The reply says which workspace they are in, that they are
not on the roster, and **carries the exact command with their Slack id already
filled in**, so they can paste it to the operator rather than describing the
problem:

```
You're not on the Riskety Rekt roster yet.

Send this to whoever runs the season:
    npm run roster:add -- U01ABCDEF <faction-id> "Your Name"
```

**Self-service joining is deliberately not offered.** The board is sized to the
roster at `season-init` and dealt round-robin, so a faction added after the deal
owns nothing — and `territoryIncome` returns 0 for zero territories, permanently.
A late joiner would not be a late joiner; they would be a spectator who cannot
tell. Adding people is an operator action, before the deal.

## What it must never do

- **Never accept a `factionId` from a request.** Derived from the session on
  every request, with no override — body, query and cookie are all ignored for
  this purpose. Absent from the wire format, not merely validated.
- **Never log a raw token.** It exists in the DM and in the URL and nowhere
  else: not the access log, not an error message, not a thrown stack.
- **Never let an expired, consumed or wrong-season token through.**

## Store surface

One new migration — **appended, never editing a shipped one**:

```sql
CREATE TABLE login_tokens (
  token_hash    TEXT PRIMARY KEY,
  slack_user_id TEXT NOT NULL,
  faction_id    TEXT NOT NULL,
  expires_at    TEXT NOT NULL
);
CREATE INDEX login_tokens_by_user ON login_tokens (slack_user_id);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  faction_id TEXT NOT NULL,
  season_id  TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX sessions_by_faction ON sessions (faction_id);
```

`slack_user_id` is indexed rather than `UNIQUE` — see the amendment above. The
cap lives in `mintLoginToken`, which inserts and then evicts past
`MAX_LIVE_TOKENS` in one transaction, so a reader never sees a user over it.

Store methods, all taking `now: Date` as an argument like every other job in
this codebase rather than reading a clock:

```ts
mintLoginToken(slackUserId, factionId, hash, expiresAt): void  // keeps newest 5
consumeLoginToken(hash, seasonId, sessionHash, expiresAt, now): FactionId | undefined
sessionFaction(hash, seasonId, now): FactionId | undefined
revokeSessions(factionId): number
```

`consumeLoginToken` does the delete and the insert in one `transaction`.

## Testing

The whole flow is store operations plus a hash, so it tests without Slack and
without a browser. What is worth pinning is the **negative space** — the paths
that must fail:

- An expired token fails, and a token consumed once fails the second time.
- A second `/login` leaves the first token working; a sixth evicts the oldest,
  and the cap is per user rather than global.
- A session minted for one season is refused for another.
- A missing or garbage cookie yields **no faction**, never a default one.
- A raw token never appears in any log line the code emits.

And the one that matters most:

- **`factionId` cannot be injected.** A request carrying `factionId` in its
  body, its query string and a second cookie still resolves to the session's
  faction. This is the property the entire secrecy model rests on, and no type
  checks it.

## Rejected

**A signed stateless cookie.** No database read per request, but no revocation
either — a lost phone would mean rotating the secret and logging out the whole
group. The read is one indexed lookup on a local file.

**Ephemeral slash-command replies instead of a DM.** Ephemeral messages vanish
on reload, and a link you cannot find at 20:55 is exactly the failure this
design exists to avoid. A DM adds no real exposure: anyone who can read your DMs
could run `/login` themselves.

**Self-service roster joining.** Covered above — the board is dealt to a fixed
headcount.

**Short-lived sessions.** Tighter, but they put the failure exactly where it
hurts most: a re-login needed on the evening of a deadline.

## Out of scope

- **Logout.** `revokeSessions` exists and is callable; a UI for it can wait
  until someone wants it.
- **Anything the player UI does with the session.** Spec C.
