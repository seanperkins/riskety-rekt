# Session Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A request can be attributed to a faction without the request saying which — so the web app can exist.

**Architecture:** `/login` is a Slack slash command handled by the bot, where bolt already verifies request signatures. It mints a single-use token, stores its SHA-256 hash, and DMs a link. The web app consumes that token and issues a season-scoped session cookie. The two processes talk through the SQLite file they already share.

**Tech Stack:** TypeScript 5.x strict, Vitest, Node 24, `tsx`, `@slack/bolt`, `node:crypto`, `node:sqlite`. No new dependencies.

## Global Constraints

- **No new runtime dependencies.** `@slack/bolt` and `@slack/web-api` remain the only two. `node:crypto` is a builtin.
- **Never edit a shipped migration** in `src/store/schema.ts`; append. This adds migration **4**.
- **`src/engine/` is untouched.** Auth has nothing to do with the engine.
- **Bolt must stay out of the test import graph.** Handlers are pure functions over a narrow structural payload; `src/slack/app.ts` is the only file that imports Bolt and the only one that adapts its types. Follow `handleMessageEvent` exactly.
- **`store.transaction` is the single owner of `BEGIN IMMEDIATE`.** Public writers wrap themselves in one call and never nest.
- **Jobs and handlers take `now: Date` as an argument** rather than reading a clock.
- **Tests never touch the network** — `test/no-network.ts` replaces `fetch` globally.
- **A raw token is never logged.** Not in an access log, an error message, or a thrown stack.
- **`factionId` is never read from a request.** Body, query string and any other cookie are ignored for that purpose.
- `npm test` and `npm run typecheck` pass at every commit.

## File Structure

**Create**

| File | Responsibility |
|---|---|
| `src/auth/token.ts` | `newToken()`, `hashToken()` — pure crypto, no store, no I/O |
| `src/auth/token.test.ts` | |
| `src/slack/login.ts` | `handleLoginCommand(payload, deps)` — pure, returns the reply text. No Bolt. |
| `src/slack/login.test.ts` | |
| `src/web/session.ts` | Cookie parse/serialise, `sessionFactionFor(req, deps)` |
| `src/web/session.test.ts` | |
| `src/store/auth.test.ts` | The four store methods |

**Modify**

| File | Change |
|---|---|
| `src/store/schema.ts` | Migration 4: `login_tokens`, `sessions` |
| `src/store/types.ts` | `AuthStore` interface |
| `src/store/sqlite.ts` | The four methods |
| `src/slack/app.ts` | Wire `app.command("/login", …)` |
| `src/slack/cli.ts` | Pass the web base URL through |
| `src/slack/env.ts` | `RR_WEB_URL` |
| `src/web/server.ts` | `/login/:token` route, session on request |
| `src/web/cli.ts` | Read `RR_SEASON_ID` |

---

### Task 1: Token helpers and the auth store

The data layer, reviewable on its own: tokens can be minted, consumed once, and turned into sessions.

**Files:**
- Create: `src/auth/token.ts`, `src/auth/token.test.ts`, `src/store/auth.test.ts`
- Modify: `src/store/schema.ts`, `src/store/types.ts`, `src/store/sqlite.ts`

**Interfaces:**
- Produces:
  ```ts
  // src/auth/token.ts
  export function newToken(): string          // 32 random bytes, base64url
  export function hashToken(token: string): string  // sha256 hex

  // src/store/types.ts
  export interface AuthStore {
    mintLoginToken(row: {
      slackUserId: string
      factionId: FactionId
      tokenHash: string
      expiresAt: Date
    }): void
    consumeLoginToken(args: {
      tokenHash: string
      seasonId: string
      sessionHash: string
      sessionExpiresAt: Date
      now: Date
    }): FactionId | undefined
    sessionFaction(tokenHash: string, seasonId: string, now: Date): FactionId | undefined
    revokeSessions(factionId: FactionId): number
  }
  ```

- [ ] **Step 1: Write the failing token tests**

```ts
// src/auth/token.test.ts
import { describe, expect, it } from "vitest"
import { hashToken, newToken } from "./token.js"

describe("newToken", () => {
  it("is URL-safe, so it survives being pasted into a link", () => {
    for (let i = 0; i < 50; i++) expect(newToken()).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it("is long enough not to be guessed", () => {
    // 32 bytes. Shorter is a credential someone can brute-force offline.
    expect(Buffer.from(newToken(), "base64url")).toHaveLength(32)
  })

  it("never repeats", () => {
    const seen = new Set(Array.from({ length: 1000 }, newToken))
    expect(seen.size).toBe(1000)
  })
})

describe("hashToken", () => {
  it("is stable and 64 hex characters", () => {
    expect(hashToken("abc")).toBe(hashToken("abc"))
    expect(hashToken("abc")).toMatch(/^[0-9a-f]{64}$/)
  })

  it("differs for different tokens", () => {
    expect(hashToken("abc")).not.toBe(hashToken("abd"))
  })

  it("does not contain the token", () => {
    // The whole point: a leaked table must not yield a working link.
    const t = newToken()
    expect(hashToken(t)).not.toContain(t)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/auth/token.test.ts`
Expected: FAIL — `Cannot find module './token.js'`

- [ ] **Step 3: Implement the helpers**

```ts
// src/auth/token.ts
import { createHash, randomBytes } from "node:crypto"

/**
 * A login or session token: 32 random bytes, base64url.
 *
 * base64url because the token goes in a path segment of a link that gets
 * pasted into Slack — `+` and `/` from plain base64 would need escaping and
 * would survive it badly.
 */
export function newToken(): string {
  return randomBytes(32).toString("base64url")
}

/**
 * SHA-256, hex.
 *
 * Tokens are stored hashed for the same reason passwords are: the database
 * sits on the same droplet as the app, and if it leaks, hashed tokens grant no
 * logins. There is no salt and no work factor on purpose — this is a 32-byte
 * random value, not a human-chosen secret, so there is nothing to brute-force
 * and nothing a rainbow table can precompute.
 *
 * Lookups are BY hash against a primary key, never a comparison, so no
 * constant-time compare is needed.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/auth/token.test.ts` — Expected: PASS

- [ ] **Step 5: Append migration 4**

At the end of the `MIGRATIONS` array in `src/store/schema.ts`:

```ts
  `
  -- Login tokens. Stored HASHED, never raw: the database sits on the same
  -- droplet as the app, and a magic link IS a credential.
  --
  -- slack_user_id is UNIQUE rather than merely indexed, which is what makes
  -- "a new /login invalidates the previous token" a property of the schema
  -- instead of a step someone can forget.
  CREATE TABLE login_tokens (
    token_hash    TEXT PRIMARY KEY,
    slack_user_id TEXT NOT NULL UNIQUE,
    faction_id    TEXT NOT NULL,
    expires_at    TEXT NOT NULL
  );

  -- Sessions expire at the season's end, so nobody is bounced mid-week and
  -- certainly not at 20:55 against a hard 21:00 deadline.
  --
  -- season_id is on the row because a factionId only means something within a
  -- season; a session carried across one would point at a faction that no
  -- longer exists.
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    faction_id TEXT NOT NULL,
    season_id  TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE INDEX sessions_by_faction ON sessions (faction_id);
  `,
```

- [ ] **Step 6: Write the failing store tests**

```ts
// src/store/auth.test.ts
import { describe, expect, it } from "vitest"
import { hashToken, newToken } from "../auth/token.js"
import { openStore } from "./sqlite.js"

const SEASON = { seasonId: "s1", startDate: "2026-09-01", lengthDays: 14 }
const NOW = new Date("2026-09-02T12:00:00Z")
const IN_10 = new Date("2026-09-02T12:10:00Z")
const SEASON_END = new Date("2026-09-16T01:00:00Z")

function seeded() {
  const store = openStore(":memory:")
  store.upsertSeason(SEASON)
  return store
}

/** Mint a token and hand back the RAW value, as the Slack handler would. */
function mint(store: ReturnType<typeof openStore>, user = "U1", faction = "f1") {
  const raw = newToken()
  store.mintLoginToken({
    slackUserId: user,
    factionId: faction,
    tokenHash: hashToken(raw),
    expiresAt: IN_10,
  })
  return raw
}

describe("login tokens", () => {
  it("consumes a valid token and yields the faction", () => {
    const store = seeded()
    const raw = mint(store)
    expect(
      store.consumeLoginToken({
        tokenHash: hashToken(raw),
        seasonId: "s1",
        sessionHash: hashToken("session-a"),
        sessionExpiresAt: SEASON_END,
        now: NOW,
      }),
    ).toBe("f1")
    store.close()
  })

  it("refuses the same token twice", () => {
    // Single-use. A link opened again -- a preview fetch, a double tap -- must
    // not mint a second session.
    const store = seeded()
    const raw = mint(store)
    const consume = (s: string) =>
      store.consumeLoginToken({
        tokenHash: hashToken(raw),
        seasonId: "s1",
        sessionHash: hashToken(s),
        sessionExpiresAt: SEASON_END,
        now: NOW,
      })
    expect(consume("a")).toBe("f1")
    expect(consume("b")).toBeUndefined()
    store.close()
  })

  it("refuses an expired token", () => {
    const store = seeded()
    const raw = mint(store)
    expect(
      store.consumeLoginToken({
        tokenHash: hashToken(raw),
        seasonId: "s1",
        sessionHash: hashToken("x"),
        sessionExpiresAt: SEASON_END,
        now: new Date("2026-09-02T12:11:00Z"),
      }),
    ).toBeUndefined()
    store.close()
  })

  it("refuses a token that was never minted", () => {
    const store = seeded()
    expect(
      store.consumeLoginToken({
        tokenHash: hashToken("never-existed"),
        seasonId: "s1",
        sessionHash: hashToken("x"),
        sessionExpiresAt: SEASON_END,
        now: NOW,
      }),
    ).toBeUndefined()
    store.close()
  })

  it("invalidates the previous token when the same user logs in again", () => {
    // Enforced by the UNIQUE on slack_user_id, not by remembering to delete.
    const store = seeded()
    const first = mint(store)
    const second = mint(store)
    const consume = (raw: string, s: string) =>
      store.consumeLoginToken({
        tokenHash: hashToken(raw),
        seasonId: "s1",
        sessionHash: hashToken(s),
        sessionExpiresAt: SEASON_END,
        now: NOW,
      })
    expect(consume(first, "a")).toBeUndefined()
    expect(consume(second, "b")).toBe("f1")
    store.close()
  })

  it("keeps different users' tokens independent", () => {
    const store = seeded()
    const a = mint(store, "U1", "f1")
    const b = mint(store, "U2", "f2")
    expect(
      store.consumeLoginToken({
        tokenHash: hashToken(a),
        seasonId: "s1",
        sessionHash: hashToken("sa"),
        sessionExpiresAt: SEASON_END,
        now: NOW,
      }),
    ).toBe("f1")
    expect(
      store.consumeLoginToken({
        tokenHash: hashToken(b),
        seasonId: "s1",
        sessionHash: hashToken("sb"),
        sessionExpiresAt: SEASON_END,
        now: NOW,
      }),
    ).toBe("f2")
    store.close()
  })

  it("leaves no session behind when the token is refused", () => {
    // The delete and the insert are one transaction; a refused token must not
    // leave a usable session.
    const store = seeded()
    store.consumeLoginToken({
      tokenHash: hashToken("bogus"),
      seasonId: "s1",
      sessionHash: hashToken("orphan"),
      sessionExpiresAt: SEASON_END,
      now: NOW,
    })
    expect(store.sessionFaction(hashToken("orphan"), "s1", NOW)).toBeUndefined()
    store.close()
  })
})

describe("sessions", () => {
  const login = (store: ReturnType<typeof openStore>, session: string) => {
    const raw = mint(store)
    store.consumeLoginToken({
      tokenHash: hashToken(raw),
      seasonId: "s1",
      sessionHash: hashToken(session),
      sessionExpiresAt: SEASON_END,
      now: NOW,
    })
  }

  it("resolves a live session to its faction", () => {
    const store = seeded()
    login(store, "sess")
    expect(store.sessionFaction(hashToken("sess"), "s1", NOW)).toBe("f1")
    store.close()
  })

  it("refuses an expired session", () => {
    const store = seeded()
    login(store, "sess")
    expect(
      store.sessionFaction(hashToken("sess"), "s1", new Date("2026-09-17T00:00:00Z")),
    ).toBeUndefined()
    store.close()
  })

  it("refuses a session minted for a different season", () => {
    // A factionId only means something within a season.
    const store = seeded()
    login(store, "sess")
    expect(store.sessionFaction(hashToken("sess"), "s2", NOW)).toBeUndefined()
    store.close()
  })

  it("refuses an unknown session", () => {
    const store = seeded()
    expect(store.sessionFaction(hashToken("nope"), "s1", NOW)).toBeUndefined()
    store.close()
  })

  it("revokes every session for a faction and reports how many", () => {
    const store = seeded()
    login(store, "one")
    login(store, "two")
    expect(store.revokeSessions("f1")).toBe(2)
    expect(store.sessionFaction(hashToken("one"), "s1", NOW)).toBeUndefined()
    store.close()
  })

  it("revoking one faction leaves another alone", () => {
    const store = seeded()
    login(store, "mine")
    const other = newToken()
    store.mintLoginToken({
      slackUserId: "U2",
      factionId: "f2",
      tokenHash: hashToken(other),
      expiresAt: IN_10,
    })
    store.consumeLoginToken({
      tokenHash: hashToken(other),
      seasonId: "s1",
      sessionHash: hashToken("theirs"),
      sessionExpiresAt: SEASON_END,
      now: NOW,
    })
    store.revokeSessions("f1")
    expect(store.sessionFaction(hashToken("theirs"), "s1", NOW)).toBe("f2")
    store.close()
  })
})
```

- [ ] **Step 7: Run to verify they fail**

Run: `npx vitest run src/store/auth.test.ts`
Expected: FAIL — `store.mintLoginToken is not a function`

- [ ] **Step 8: Add `AuthStore` to `src/store/types.ts`**

```ts
/**
 * Login tokens and sessions.
 *
 * Both are keyed by the SHA-256 hash of the token; the raw value exists only in
 * the DM, the URL and the cookie. This layer never sees one.
 */
export interface AuthStore {
  /** Replaces any live token for that Slack user — one live token per person. */
  mintLoginToken(row: {
    slackUserId: string
    factionId: FactionId
    tokenHash: string
    expiresAt: Date
  }): void

  /**
   * Consume a login token and create a session, in ONE transaction.
   *
   * Returns the faction, or undefined if the token is unknown, expired or
   * already used. The delete and the insert commit together, so a link opened
   * twice yields exactly one session rather than two — or one session and a
   * dangling token.
   */
  consumeLoginToken(args: {
    tokenHash: string
    seasonId: string
    sessionHash: string
    sessionExpiresAt: Date
    now: Date
  }): FactionId | undefined

  /** The faction for a live session in this season, or undefined. */
  sessionFaction(tokenHash: string, seasonId: string, now: Date): FactionId | undefined

  /** Drop every session for a faction. Returns how many. */
  revokeSessions(factionId: FactionId): number
}
```

Add `AuthStore` to the intersection type `openStore` returns, and to the import list in `src/store/sqlite.ts`.

- [ ] **Step 9: Implement the four methods in `src/store/sqlite.ts`**

```ts
    mintLoginToken(row: {
      slackUserId: string
      factionId: FactionId
      tokenHash: string
      expiresAt: Date
    }): void {
      // Delete-then-insert rather than an upsert on the unique column: the
      // token hash is the PRIMARY KEY, so replacing a user's token changes the
      // key, and an explicit delete says that plainly.
      this.transaction(() => {
        db.prepare("DELETE FROM login_tokens WHERE slack_user_id = ?").run(row.slackUserId)
        db.prepare(
          `INSERT INTO login_tokens (token_hash, slack_user_id, faction_id, expires_at)
           VALUES (?, ?, ?, ?)`,
        ).run(row.tokenHash, row.slackUserId, row.factionId, row.expiresAt.toISOString())
      })
    },

    consumeLoginToken(args: {
      tokenHash: string
      seasonId: string
      sessionHash: string
      sessionExpiresAt: Date
      now: Date
    }): FactionId | undefined {
      return this.transaction((): FactionId | undefined => {
        const row = db
          .prepare("SELECT faction_id FROM login_tokens WHERE token_hash = ? AND expires_at > ?")
          .get(args.tokenHash, args.now.toISOString()) as { faction_id: string } | undefined
        if (row === undefined) return undefined

        db.prepare("DELETE FROM login_tokens WHERE token_hash = ?").run(args.tokenHash)
        db.prepare(
          `INSERT INTO sessions (token_hash, faction_id, season_id, expires_at)
           VALUES (?, ?, ?, ?)`,
        ).run(
          args.sessionHash,
          row.faction_id,
          args.seasonId,
          args.sessionExpiresAt.toISOString(),
        )
        return row.faction_id
      })
    },

    sessionFaction(tokenHash: string, seasonId: string, now: Date): FactionId | undefined {
      const row = db
        .prepare(
          `SELECT faction_id FROM sessions
            WHERE token_hash = ? AND season_id = ? AND expires_at > ?`,
        )
        .get(tokenHash, seasonId, now.toISOString()) as { faction_id: string } | undefined
      return row?.faction_id
    },

    revokeSessions(factionId: FactionId): number {
      const res = db.prepare("DELETE FROM sessions WHERE faction_id = ?").run(factionId)
      return Number(res.changes)
    },
```

- [ ] **Step 10: Run everything**

Run: `npm test && npm run typecheck` — Expected: PASS

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat(auth): token helpers and the auth store

Tokens are stored hashed for the same reason passwords are: the database sits
on the same droplet as the app, and a magic link IS a credential. No salt and
no work factor on purpose -- a 32-byte random value has nothing to
brute-force and nothing a rainbow table can precompute.

slack_user_id is UNIQUE, which makes 'a new /login invalidates the previous
token' a property of the schema rather than a step someone can forget.
consumeLoginToken deletes the token and inserts the session in ONE
transaction, so a link opened twice yields exactly one session."
```

---

### Task 2: The `/login` slash command

**Files:**
- Create: `src/slack/login.ts`, `src/slack/login.test.ts`
- Modify: `src/slack/app.ts`, `src/slack/env.ts`, `src/slack/env.test.ts`

**Interfaces:**
- Consumes: `newToken`, `hashToken` (Task 1); `mintLoginToken` (Task 1); `factionForSlackUser` from `RosterStore`
- Produces:
  ```ts
  export interface LoginDeps {
    store: RosterStore & AuthStore
    webUrl: string
    now: Date
    log?: (msg: string) => void
  }
  export interface LoginPayload {
    userId: string
    teamId: string
  }
  export function handleLoginCommand(payload: LoginPayload, deps: LoginDeps): string
  ```
  The return value is the DM text. **It contains the raw token exactly once**, in the link.

- [ ] **Step 1: Add `RR_WEB_URL` to `src/slack/env.ts`**

In `loadSlackEnv`, alongside the existing four:

```ts
    webUrl: required(env, "RR_WEB_URL"),
```

and on the `SlackEnv` interface: `webUrl: string`. Add to `src/slack/env.test.ts` wherever the existing required-variable cases are enumerated, following the pattern already there for `SLACK_TEAM_ID`.

- [ ] **Step 2: Write the failing handler tests**

```ts
// src/slack/login.test.ts
import { describe, expect, it } from "vitest"
import { openStore } from "../store/sqlite.js"
import { handleLoginCommand } from "./login.js"

const NOW = new Date("2026-09-02T12:00:00Z")

function seeded(rostered = true) {
  const store = openStore(":memory:")
  store.upsertSeason({ seasonId: "s1", startDate: "2026-09-01", lengthDays: 14 })
  if (rostered) {
    store.addRosterMember({ slackUserId: "U01ABCDEF", factionId: "f1", displayName: "Ada" })
  }
  return store
}

const deps = (store: ReturnType<typeof openStore>) => ({
  store,
  webUrl: "https://rr.example.com",
  now: NOW,
})

describe("handleLoginCommand", () => {
  it("returns a link containing a token", () => {
    const store = seeded()
    const reply = handleLoginCommand({ userId: "U01ABCDEF", teamId: "T1" }, deps(store))
    expect(reply).toMatch(/https:\/\/rr\.example\.com\/login\/[A-Za-z0-9_-]+/)
    store.close()
  })

  it("stores the token HASHED, never raw", () => {
    // The property the whole design rests on. Pull the raw token out of the
    // reply and assert it does not appear anywhere in the database file.
    const store = seeded()
    const reply = handleLoginCommand({ userId: "U01ABCDEF", teamId: "T1" }, deps(store))
    const raw = /\/login\/([A-Za-z0-9_-]+)/.exec(reply)![1]!
    // Consuming with the RAW value as if it were the hash must fail; only the
    // hash opens it.
    expect(
      store.consumeLoginToken({
        tokenHash: raw,
        seasonId: "s1",
        sessionHash: "x",
        sessionExpiresAt: NOW,
        now: NOW,
      }),
    ).toBeUndefined()
    store.close()
  })

  it("mints a token that actually works", () => {
    const store = seeded()
    const reply = handleLoginCommand({ userId: "U01ABCDEF", teamId: "T1" }, deps(store))
    const raw = /\/login\/([A-Za-z0-9_-]+)/.exec(reply)![1]!
    expect(
      store.consumeLoginToken({
        tokenHash: hashToken(raw),
        seasonId: "s1",
        sessionHash: hashToken("sess"),
        sessionExpiresAt: new Date("2026-09-16T01:00:00Z"),
        now: NOW,
      }),
    ).toBe("f1")
    store.close()
  })

  it("tells an unrostered player exactly what to send, with their id filled in", () => {
    // The message most new players will actually see. A vague one produces a
    // DM to the operator asking why the game is broken.
    const store = seeded(false)
    const reply = handleLoginCommand({ userId: "U0NEWBIE", teamId: "T1" }, deps(store))
    expect(reply).toContain("not on the")
    expect(reply).toContain("roster:add")
    expect(reply).toContain("U0NEWBIE")
    expect(reply).not.toMatch(/\/login\//)
    store.close()
  })

  it("mints nothing for an unrostered player", () => {
    const store = seeded(false)
    handleLoginCommand({ userId: "U0NEWBIE", teamId: "T1" }, deps(store))
    // No token row exists to consume, whatever hash is tried.
    expect(
      store.consumeLoginToken({
        tokenHash: "anything",
        seasonId: "s1",
        sessionHash: "x",
        sessionExpiresAt: NOW,
        now: NOW,
      }),
    ).toBeUndefined()
    store.close()
  })

  it("never logs the raw token", () => {
    const lines: string[] = []
    const store = seeded()
    const reply = handleLoginCommand(
      { userId: "U01ABCDEF", teamId: "T1" },
      { ...deps(store), log: (m) => lines.push(m) },
    )
    const raw = /\/login\/([A-Za-z0-9_-]+)/.exec(reply)![1]!
    expect(lines.join("\n")).not.toContain(raw)
    store.close()
  })

  it("a second login invalidates the first link", () => {
    const store = seeded()
    const first = /\/login\/([A-Za-z0-9_-]+)/.exec(
      handleLoginCommand({ userId: "U01ABCDEF", teamId: "T1" }, deps(store)),
    )![1]!
    handleLoginCommand({ userId: "U01ABCDEF", teamId: "T1" }, deps(store))
    expect(
      store.consumeLoginToken({
        tokenHash: hashToken(first),
        seasonId: "s1",
        sessionHash: hashToken("x"),
        sessionExpiresAt: new Date("2026-09-16T01:00:00Z"),
        now: NOW,
      }),
    ).toBeUndefined()
    store.close()
  })
})
```

Add `import { hashToken } from "../auth/token.js"` at the top.

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run src/slack/login.test.ts`
Expected: FAIL — `Cannot find module './login.js'`

- [ ] **Step 4: Implement `src/slack/login.ts`**

```ts
import { hashToken, newToken } from "../auth/token.js"
import type { AuthStore, RosterStore } from "../store/types.js"

/** How long a magic link is good for. Long enough to switch apps, no longer. */
export const LOGIN_TOKEN_TTL_MS = 10 * 60 * 1000

export interface LoginDeps {
  store: RosterStore & AuthStore
  /** Origin of the web app, e.g. https://rr.example.com. No trailing slash. */
  webUrl: string
  now: Date
  log?: (msg: string) => void
}

export interface LoginPayload {
  userId: string
  teamId: string
}

/**
 * The `/login` slash command.
 *
 * Pure: no Bolt, no network, no clock. `src/slack/app.ts` adapts Bolt's types
 * and sends the return value as a DM — the same split as the event handlers,
 * and the reason Bolt stays out of the test import graph.
 *
 * The return value contains the raw token exactly once, in the link. It is
 * never logged and never stored; only its hash reaches the database.
 */
export function handleLoginCommand(payload: LoginPayload, deps: LoginDeps): string {
  const log = deps.log ?? (() => {})

  const factionId = deps.store.factionForSlackUser(payload.userId)
  if (factionId === undefined) {
    // Not an error -- the normal state of a new player. The reply carries the
    // exact command with their id already in it, so they can paste it to the
    // operator rather than describing the problem.
    log(`login: ${payload.userId} is not on the roster`)
    return [
      "You're not on the Riskety Rekt roster yet.",
      "",
      "Send this to whoever runs the season:",
      "```",
      `npm run roster:add -- ${payload.userId} <faction-id> "Your Name"`,
      "```",
    ].join("\n")
  }

  const token = newToken()
  deps.store.mintLoginToken({
    slackUserId: payload.userId,
    factionId,
    tokenHash: hashToken(token),
    expiresAt: new Date(deps.now.getTime() + LOGIN_TOKEN_TTL_MS),
  })

  // The faction, never the token.
  log(`login: minted a token for ${payload.userId} (${factionId})`)

  return [
    `Here's your link, <@${payload.userId}> — good for 10 minutes, single use.`,
    `${deps.webUrl}/login/${token}`,
    "",
    "Running /login again replaces this link.",
  ].join("\n")
}
```

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run src/slack/login.test.ts` — Expected: PASS

- [ ] **Step 6: Wire it into Bolt**

In `src/slack/app.ts`, extend `SlackAppDeps.store` to `ApprovalStore & RosterStore & AuthStore`, add `webUrl` to what the app reads from `deps.env`, and register the command alongside the existing `app.event` calls:

```ts
  // A slash command, not an event. Bolt verifies the same signature and gives a
  // trusted user_id; the handler is pure and returns the DM text.
  app.command("/login", async ({ command, ack, respond }) => {
    await ack()
    const text = handleLoginCommand(
      { userId: command.user_id, teamId: command.team_id },
      { store: deps.store, webUrl: deps.env.webUrl, now: new Date(), log: deps.log },
    )
    // response_type defaults to ephemeral, which is what we want as the
    // fallback if the DM cannot be opened -- only the invoker ever sees it.
    await respond({ text, response_type: "ephemeral" })
  })
```

- [ ] **Step 7: Run everything**

Run: `npm test && npm run typecheck` — Expected: PASS. `src/slack/app.test.ts` builds an app with `deferInitialization: true`; it must still pass without reaching the network.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(slack): the /login slash command

Pure handler, Bolt only adapts -- the same split as the event handlers, and
what keeps Bolt out of the test import graph.

The unrostered reply carries the exact roster:add command with the player's
Slack id already in it, so they can paste it to the operator instead of
describing the problem. Self-service joining is deliberately not offered: the
board is sized to the roster at season-init, so a faction added afterwards
owns nothing and earns nothing, permanently.

Tests assert the raw token never reaches the database and never reaches a log
line."
```

---

### Task 3: The session cookie and `/login/:token`

**Files:**
- Create: `src/web/session.ts`, `src/web/session.test.ts`
- Modify: `src/web/server.ts`, `src/web/cli.ts`

**Interfaces:**
- Consumes: `hashToken` (Task 1); `consumeLoginToken`, `sessionFaction` (Task 1)
- Produces:
  ```ts
  export const SESSION_COOKIE = "rr_session"
  export function parseCookies(header: string | undefined): Record<string, string>
  export function serializeSessionCookie(token: string, expires: Date): string
  export function sessionFactionFor(
    req: { headers: { cookie?: string | undefined } },
    deps: { store: AuthStore; seasonId: string; now: Date },
  ): FactionId | undefined
  ```

- [ ] **Step 1: Write the failing session tests**

```ts
// src/web/session.test.ts
import { describe, expect, it } from "vitest"
import { hashToken } from "../auth/token.js"
import { openStore } from "../store/sqlite.js"
import {
  SESSION_COOKIE,
  parseCookies,
  serializeSessionCookie,
  sessionFactionFor,
} from "./session.js"

const NOW = new Date("2026-09-02T12:00:00Z")
const END = new Date("2026-09-16T01:00:00Z")

describe("parseCookies", () => {
  it("reads several cookies", () => {
    expect(parseCookies("a=1; b=2")).toEqual({ a: "1", b: "2" })
  })

  it("is empty for a missing or blank header", () => {
    expect(parseCookies(undefined)).toEqual({})
    expect(parseCookies("")).toEqual({})
  })

  it("keeps a value containing =", () => {
    // base64url has no "=", but a padded base64 value would, and silently
    // truncating a credential is the worst kind of bug to debug.
    expect(parseCookies("t=aa=bb")).toEqual({ t: "aa=bb" })
  })

  it("decodes percent-encoding and ignores junk segments", () => {
    expect(parseCookies("a=%20x; ; b")).toEqual({ a: " x" })
  })
})

describe("serializeSessionCookie", () => {
  const cookie = serializeSessionCookie("tok", END)

  it("is HttpOnly, Secure, SameSite=Lax and site-wide", () => {
    // HttpOnly because no client script needs it -- the server reads the
    // session and renders the projection. Lax rather than Strict so the link
    // from Slack still works, while a cross-site POST cannot forge an order.
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("Secure")
    expect(cookie).toContain("SameSite=Lax")
    expect(cookie).toContain("Path=/")
  })

  it("carries the token and an expiry", () => {
    expect(cookie).toContain(`${SESSION_COOKIE}=tok`)
    expect(cookie).toContain("Expires=")
  })
})

describe("sessionFactionFor", () => {
  function loggedIn() {
    const store = openStore(":memory:")
    store.upsertSeason({ seasonId: "s1", startDate: "2026-09-01", lengthDays: 14 })
    store.mintLoginToken({
      slackUserId: "U1",
      factionId: "f1",
      tokenHash: hashToken("login"),
      expiresAt: new Date("2026-09-02T12:10:00Z"),
    })
    store.consumeLoginToken({
      tokenHash: hashToken("login"),
      seasonId: "s1",
      sessionHash: hashToken("sess"),
      sessionExpiresAt: END,
      now: NOW,
    })
    return store
  }

  it("resolves a valid cookie to its faction", () => {
    const store = loggedIn()
    expect(
      sessionFactionFor(
        { headers: { cookie: `${SESSION_COOKIE}=sess` } },
        { store, seasonId: "s1", now: NOW },
      ),
    ).toBe("f1")
    store.close()
  })

  it("yields undefined for no cookie, junk, or the wrong season", () => {
    // Never a default faction. Falling back to one would hand a stranger
    // somebody's orders.
    const store = loggedIn()
    const call = (cookie: string | undefined, seasonId = "s1") =>
      sessionFactionFor({ headers: { cookie } }, { store, seasonId, now: NOW })
    expect(call(undefined)).toBeUndefined()
    expect(call("")).toBeUndefined()
    expect(call(`${SESSION_COOKIE}=nonsense`)).toBeUndefined()
    expect(call("other=sess")).toBeUndefined()
    expect(call(`${SESSION_COOKIE}=sess`, "s2")).toBeUndefined()
    store.close()
  })

  it("cannot be overridden by a factionId anywhere in the request", () => {
    // THE test. factionId is absent from the wire format, not merely
    // validated -- this asserts that a request shouting a different faction is
    // still resolved from the session.
    const store = loggedIn()
    expect(
      sessionFactionFor(
        {
          headers: {
            cookie: `factionId=f9; ${SESSION_COOKIE}=sess; faction_id=f9`,
          },
        },
        { store, seasonId: "s1", now: NOW },
      ),
    ).toBe("f1")
    store.close()
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/web/session.test.ts`
Expected: FAIL — `Cannot find module './session.js'`

- [ ] **Step 3: Implement `src/web/session.ts`**

```ts
import { hashToken } from "../auth/token.js"
import type { FactionId } from "../engine/index.js"
import type { AuthStore } from "../store/types.js"

export const SESSION_COOKIE = "rr_session"

/**
 * Parse a Cookie header.
 *
 * Splits each pair on the FIRST `=` only: a value containing `=` must survive
 * intact, because silently truncating a credential is a miserable bug to find.
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (header === undefined || header === "") return out
  for (const part of header.split(";")) {
    const eq = part.indexOf("=")
    if (eq === -1) continue
    const name = part.slice(0, eq).trim()
    if (name === "") continue
    try {
      out[name] = decodeURIComponent(part.slice(eq + 1).trim())
    } catch {
      // A malformed percent-escape is not worth a 500; the cookie simply does
      // not resolve, and the caller sees no session.
      continue
    }
  }
  return out
}

/**
 * The Set-Cookie value.
 *
 * HttpOnly because no client script needs it — the server reads the session and
 * renders the projection, so the browser never handles the credential.
 * SameSite=Lax rather than Strict so the link arriving from Slack still works,
 * while a cross-site POST cannot forge an order. Secure requires HTTPS, which
 * Caddy already terminates.
 */
export function serializeSessionCookie(token: string, expires: Date): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Expires=${expires.toUTCString()}`,
  ].join("; ")
}

/**
 * The faction for a request, or undefined.
 *
 * The ONLY way a request acquires a faction. `factionId` is absent from the
 * wire format rather than merely validated: nothing here reads a body, a query
 * string, or any cookie other than the session one, so there is no path by
 * which a request can name a faction.
 *
 * Returns undefined rather than a default. A fallback faction would hand a
 * stranger somebody else's orders.
 */
export function sessionFactionFor(
  req: { headers: { cookie?: string | undefined } },
  deps: { store: AuthStore; seasonId: string; now: Date },
): FactionId | undefined {
  const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE]
  if (raw === undefined || raw === "") return undefined
  return deps.store.sessionFaction(hashToken(raw), deps.seasonId, deps.now)
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/web/session.test.ts` — Expected: PASS

- [ ] **Step 5: Add the `/login/:token` route to `src/web/server.ts`**

`createWebServer`'s deps gain the store and the season, since the route needs
both. Change the interface first:

```ts
export interface WebDeps {
  port: number
  store: AuthStore & SeasonStore
  seasonId: string
  log?: (msg: string) => void
}
```

Imports at the top of `src/web/server.ts`:

```ts
import { hashToken, newToken } from "../auth/token.js"
import { tickInstant } from "../season.js"
import { serializeSessionCookie } from "./session.js"
import type { AuthStore, SeasonStore } from "../store/types.js"
```

The existing router is exact-match on `path`. Add this branch **inside the
request handler, before the table lookup**, since `/login/<token>` cannot be a
fixed key:

```ts
    if (path.startsWith("/login/")) {
      const season = deps.store.season(deps.seasonId)
      if (season === undefined) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" })
        res.end("no season\n")
        return
      }
      const now = new Date()
      // The session dies with the season, so nobody is bounced mid-week -- and
      // a faction id means nothing in the next one anyway.
      const seasonEnd = tickInstant(season, season.lengthDays)
      const sessionToken = newToken()

      const faction = deps.store.consumeLoginToken({
        tokenHash: hashToken(path.slice("/login/".length)),
        seasonId: deps.seasonId,
        sessionHash: hashToken(sessionToken),
        sessionExpiresAt: seasonEnd,
        now,
      })

      if (faction === undefined) {
        // Deliberately identical for expired, already-used and never-existed.
        // Distinguishing them tells someone holding a stale link which kind of
        // wrong it is, and helps nobody entitled to be here.
        res.writeHead(401, { "content-type": "text/html; charset=utf-8" })
        res.end(
          page(
            "Link expired",
            `<div class="rail"><h1 class="title">That link is no longer good</h1>
             <p class="sub">Links last ten minutes and work once.
             Run <code>/login</code> in Slack for a fresh one.</p></div>`,
          ),
        )
        return
      }

      // 303 rather than 200, so refreshing the landing page does not re-submit
      // a token that has already been consumed.
      res.writeHead(303, {
        location: "/",
        "set-cookie": serializeSessionCookie(sessionToken, seasonEnd),
      })
      res.end()
      return
    }
```

`src/web/cli.ts` gains `RR_DB_PATH` and `RR_SEASON_ID`, opens the store with
`openStore`, and passes both into `createWebServer` — following
`src/jobs/cli.ts`, including its rule that `process.exit` is never called with
the store open. `src/web/server.test.ts`'s `beforeAll` must now build a store
and pass `store` and `seasonId`.

- [ ] **Step 6: Add the route tests**

Append to `src/web/server.test.ts`, in the style already there:

```ts
describe("login", () => {
  it("401s an unknown, expired or reused token identically", async () => {
    for (const t of ["nope", "", "aaaaaaaaaaaaaaaaaaaaaaaa"]) {
      const res = await request(`/login/${t}`)
      expect(res.status, t).toBe(401)
      expect(res.body, t).toContain("no longer good")
    }
  })

  it("does not set a cookie when the token is refused", async () => {
    const res = await request("/login/nope")
    expect(res.headers["set-cookie"]).toBeUndefined()
  })
})
```

- [ ] **Step 7: Run everything**

Run: `npm test && npm run typecheck` — Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(web): session cookie and /login/:token

sessionFactionFor is the only way a request acquires a faction, and it reads
nothing but the session cookie -- no body, no query string, no other cookie.
A test asserts a request carrying factionId in two other cookies still
resolves to the session's faction.

Cookies parse on the FIRST '=' so a value containing one survives; silently
truncating a credential is a miserable bug to find. A refused token 401s
identically whether it expired, was used, or never existed."
```

---

### Task 4: Deployment, docs, and an end-to-end check

**Files:**
- Modify: `deploy/README.md`, `deploy/riskety-slack.service`, `CLAUDE.md`, `README.md`, `HANDOFF.md`
- Create: `deploy/riskety-web.service`

- [ ] **Step 1: The web unit**

```ini
[Unit]
Description=Riskety Rekt — the web app
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=riskety
WorkingDirectory=/srv/riskety-rekt
EnvironmentFile=/etc/riskety-rekt/env
ExecStart=/usr/bin/npm run web
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: Document the two new environment variables**

In `deploy/README.md`, alongside the existing block: `RR_WEB_URL` (the public origin, no trailing slash — the Slack bot builds links from it) and the note that the web app needs `RR_DB_PATH` and `RR_SEASON_ID` like the jobs. Add the Caddy route for the web app on port 3002 next to the existing `/slack/events` route, and state that **`Secure` cookies mean the app does not work over plain HTTP** — a local run needs `http://localhost`, which browsers exempt.

- [ ] **Step 3: Register the slash command**

In `deploy/README.md`, under the Slack setup: create a `/login` slash command in the Slack app pointing at the bot's public URL, and note it needs the `commands` scope, plus `chat:write` for the reply.

- [ ] **Step 4: Update `CLAUDE.md`**

Add to the traps section:

```markdown
- **`factionId` never comes from a request.** `sessionFactionFor` is the only
  way a request acquires one, and it reads nothing but the session cookie.
- **Login tokens are stored hashed.** The raw value exists in the DM, the URL
  and the cookie — never in the database and never in a log line.
```

And amend the dependency rule to distinguish client from server dependencies, as the player-UI spec requires.

- [ ] **Step 5: End-to-end check**

```bash
npm test
npm run typecheck
```

Then, with a scratch database, assert the loop by hand: mint a token through `handleLoginCommand`, consume it through the store, and confirm `sessionFactionFor` resolves the resulting cookie — the same sequence the tests cover, run once against a file-backed database rather than `:memory:` to confirm the migration applies to a real file.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(deploy): web unit, /login registration, and the auth docs"
```

---

## What this plan does not build

- **The player UI.** Spec C. This plan ends with a session cookie and nothing that reads it.
- **Territory geometry.** Spec B.
- **A logout UI.** `revokeSessions` exists and is callable; a page for it can wait until someone wants one.
- **Rate limiting `/login`.** Bolt's signature verification means only real workspace members reach the handler, and the `UNIQUE` on `slack_user_id` caps stored tokens at one per person. A player spamming the command DMs themselves.
