# Riskety Rekt — Slack Ingress & Recap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn workout photos and 👍 reactions in `#riskety-rekt` into persisted `ApprovedAction` rows the tick can read offline, and render the daily recap and morning slate as Block Kit messages — so that by the end, `DailyContext.approvals` and `DailyContext.postedToday` are available from SQLite with no network call, and the game has a voice in Slack.

**Architecture:** A Bolt app owns the Events webhook and does nothing but validate scope and write rows. All interesting logic is pure and lives outside the handlers: emoji normalization, image detection and scope predicates in `src/slack/events.ts`; approval derivation as a SQL query in the store; recap and slate rendering as pure functions from `GameState`/`Market[]` to Block Kit. The tick never calls Slack, and Slack never calls the engine.

**Tech Stack:** TypeScript 5.x (strict), Vitest, Node 24. `@slack/bolt` ^5 and `@slack/web-api` ^8 — the project's first runtime dependencies. `node:sqlite` (`DatabaseSync`) for persistence. No other new packages.

**Spec:** `docs/superpowers/specs/2026-08-09-riskety-rekt-design.md`

**This is Plan 3 of 4.** Plans 1 (engine + sim) and 2 (market adapter + poller) are complete. Plan 4 covers the Next.js web app, the board renderer, the 21:00 tick runner and deployment. This plan builds the recap *renderer* and a `postRecap` entrypoint; the tick that calls it is Plan 4's.

## Global Constraints

- **The tick never touches the network.** Every handler in this plan writes to SQLite. Nothing here is called from `resolve()`, and `postRecap` runs strictly *after* state is saved.
- **`src/engine/**` is touched by exactly one task (Task 1) and no other.** Nothing in `src/engine/` may import from `src/slack/`, `src/store/`, `src/adapters/`, `src/slate/` or `src/jobs/`. `src/engine/types.test.ts` enforces this along with the ban on `Date.now()`, `Math.random()` and `new Date()` — do not weaken it.
- **No test may make a network call.** Bolt's `App` constructor is only ever built with `deferInitialization: true` in tests, which is what keeps `auth.test` from firing. Handlers are tested as plain functions against literal event payloads; the `WebClient` is injected behind a one-method interface and faked.
- **The service fails to boot if `SLACK_SIGNING_SECRET` is missing.** A missing secret must never degrade into an unverified handler. This is asserted by a test, not just by code review.
- **Determinism.** Never iterate an object's keys or a SQL result without an explicit `ORDER BY` / sort. Every tie-break is explicit: timestamp, then Slack `event_ts`, then faction id.
- **Every timestamp that reaches the engine comes from Slack, never from the database write time.** A reaction at 20:59:59 delivered at 21:00:01 must still count. `received_at` columns exist for debugging only and are never read by game logic.
- **All third-party and player-supplied text is capped and sanitized before it reaches a Block Kit payload.** `QUESTION_MAX_CHARS` is 200. Use Block Kit `plain_text`, never `mrkdwn` — a question containing `<!channel>` would otherwise ping the workspace daily.
- **Exception text never reaches Slack.** Log locally, post a generic failure note.
- Test files live beside the code as `*.test.ts`.
- Times are pinned to `America/New_York`. Never construct a local-time `Date` from parts without going through `src/time.ts`.

## Decisions taken before this plan was written

| Decision | Why |
|---|---|
| **`@slack/bolt` rather than a hand-rolled receiver** | The spec names Bolt. It costs the project its zero-runtime-dependency status; Plan 4 brings Next.js anyway. Bolt owns signature verification and the 3-second ack. |
| **The post gate goes in the engine**, as `DailyContext.postedToday: FactionId[]` | The spec's elimination veto "gates on the post, not on peer approval", and `combat.ts:38` currently gates on elimination alone. Filtering `protect` in the tick runner instead would mean the golden file records already-filtered orders, so a regression in that filter replays green forever. There are also two callers — the tick runner and `src/sim/run.ts` — and the sim needs the gate to keep measuring how often a protection voids an attack. |
| **`postedToday: FactionId[]`, not `posts: PostedAction[]`** | Nothing needs post *times* beyond what `ApprovedAction.postedAt` already carries: Early Bird keys on the post time of an *approved* action. A set of faction ids is the whole requirement. |
| **A post is a top-level `file_share` message carrying at least one `image/*` file** | "Posts a photo in `#riskety-rekt`". Thread replies are excluded so a photo re-shared into a thread cannot double-count. |
| **Roster lives in SQLite, seeded by CLI** | Slack user ids are opaque (`U01ABCDEF`) and the mapping to `factionId` is per-season configuration, not code. An env-var roster would need a redeploy to fix a typo. |

## File Structure

```
src/engine/types.ts                 MODIFIED: DailyContext gains postedToday
src/engine/combat.ts                MODIFIED: protection gates on posted AND eliminated
src/slack/config.ts                 Slack-specific constants: emoji, cutoff hour, caps
src/slack/env.ts                    fail-boot environment loading
src/slack/events.ts                 pure: raw Slack payload -> a decision, or a drop reason
src/slack/handlers.ts               pure-ish: decision + store -> row writes. No Bolt types.
src/slack/app.ts                    thin Bolt wiring. The only file that imports @slack/bolt.
src/slack/text.ts                   pure: sanitize and cap untrusted text for Block Kit
src/slack/recap.ts                  pure: GameState -> the daily recap blocks
src/slack/announce.ts               pure: Market[] -> the 08:00 slate blocks
src/slack/post.ts                   the only code that speaks to the Slack Web API
src/store/schema.ts                 MODIFIED: migration 2 — roster, events, posts, reactions
src/store/types.ts                  MODIFIED: RosterStore + ApprovalStore interfaces
src/store/sqlite.ts                 MODIFIED: implementations
src/time.ts                         MODIFIED: etDateAdd, slackTsToIso
src/jobs/post-recap.ts              the recap job, callable by Plan 4's tick runner
src/jobs/cli.ts                     MODIFIED: roster-add, slack-bot, post-recap commands
deploy/riskety-slack.service        the long-running bot
deploy/README.md                    MODIFIED
```

`events.ts` and `handlers.ts` are separate on purpose. Every interesting failure mode — a skin-toned emoji, a self-approval, a DM, a replayed event — is a decision made before any row is written, and those tests must not need a database or a socket.

---

### Task 1: The post gate in the engine

The spec says the elimination veto "gates on the **post**, not on peer approval — deliberately. Gating on approval would hand living factions a concrete incentive to withhold the 👍 from someone whose veto they fear." `combat.ts` gates on elimination only, because `DailyContext` has no way to express who posted. This task closes that gap first, so every later task knows the shape it must fill.

**Files:**
- Modify: `src/engine/types.ts:60-64`
- Modify: `src/engine/combat.ts:22-45`
- Modify: `src/engine/resolve.ts:91`
- Modify: `src/engine/combat.test.ts`
- Modify: `src/engine/golden.test.ts`
- Modify: `src/sim/run.ts:69-90`
- Regenerate: `src/engine/__golden__/season-1.json`

**Interfaces:**
- Produces: `DailyContext.postedToday: FactionId[]`; `resolveCombat(state, orders, postedToday)` — the third parameter is required, not optional.
- Consumed by: Task 5's `loadPostedToday`, and Plan 4's tick runner.

A required third parameter is deliberate. An optional one defaulting to `[]` would silently disable every protection in the game the first time a caller forgot it, and nothing would fail loudly.

- [ ] **Step 1: Write the failing test**

Add to `src/engine/combat.test.ts`, inside the existing `describe("protections", ...)` block so it sits beside the parity tests it extends. Reuse that file's existing `board(factions, setup)` and `order({...})` helpers and its module-level `factions` array (`f1`, `f2`, `f3`) — do not write new fixtures.

The existing tests call `resolveCombat(state, orders)` with two arguments; they stop compiling in Step 4, which is expected and handled in Step 5.

```ts
  /** f1 owns everything except alberta, which f2 holds with 1. f3 is eliminated. */
  const aboutToFall = () =>
    board(factions, (s) => {
      for (const t of RISK_MAP.territories) s.ownership[t.id] = "f1"
      s.garrisons["alaska"] = 10
      s.ownership["alberta"] = "f2"
      s.garrisons["alberta"] = 1
    })

  it("ignores a pick from an eliminated faction that did not post today", () => {
    const s = aboutToFall()
    const orders = [
      order({ factionId: "f1", attacks: [{ from: "alaska", to: "alberta", count: 9 }] }),
      order({ factionId: "f3", protect: "alberta" }),
    ]
    // f3 holds nothing, so it may claim a veto -- but only by showing up.
    expect(resolveCombat(s, orders, ["f3"]).ownership["alberta"]).toBe("f2")
    expect(resolveCombat(s, orders, []).ownership["alberta"]).toBe("f1")
    expect(resolveCombat(s, orders, []).events.filter((e) => e.t === "protected")).toEqual([])
  })

  it("still ignores a pick from a living faction that posted", () => {
    // Posting must not become a second route to the veto for a faction that
    // still holds territory.
    const s = aboutToFall()
    const orders = [
      order({ factionId: "f1", attacks: [{ from: "alaska", to: "alberta", count: 9 }] }),
      order({ factionId: "f2", protect: "alberta" }),
    ]
    expect(resolveCombat(s, orders, ["f2"]).ownership["alberta"]).toBe("f1")
  })

  it("counts parity only over eliminated factions that posted", () => {
    // Two picks on one territory cancel. If only one of the two posted, the
    // surviving pick protects.
    const four = [...factions, { id: "f4", playerName: "Dee", color: "#ee1" }]
    const s = board(four, (s) => {
      for (const t of RISK_MAP.territories) s.ownership[t.id] = "f1"
      s.garrisons["alaska"] = 10
      s.ownership["alberta"] = "f2"
      s.garrisons["alberta"] = 1
    })
    const orders = [
      order({ factionId: "f1", attacks: [{ from: "alaska", to: "alberta", count: 9 }] }),
      order({ factionId: "f3", protect: "alberta" }),
      order({ factionId: "f4", protect: "alberta" }),
    ]

    // Both posted: the picks cancel and the attack lands.
    expect(resolveCombat(s, orders, ["f3", "f4"]).ownership["alberta"]).toBe("f1")
    // Only f3 posted: one pick stands, so alberta holds.
    expect(resolveCombat(s, orders, ["f3"]).ownership["alberta"]).toBe("f2")
    expect(resolveCombat(s, orders, ["f3"]).events).toContainEqual({
      t: "protected", territory: "alberta", byCount: 1,
    })
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/engine/combat.test.ts -t protections`
Expected: FAIL — `resolveCombat` currently takes two parameters, so TypeScript reports "Expected 2 arguments, but got 3", and at runtime the no-post assertions fail because the protection still fires.

- [ ] **Step 3: Add `postedToday` to `DailyContext`**

In `src/engine/types.ts`, replace the `DailyContext` interface:

```ts
export interface DailyContext {
  slate: Market[]
  approvals: ApprovedAction[]
  /**
   * Faction ids that POSTED an action today, approved or not.
   *
   * Separate from `approvals` because the elimination veto gates on posting
   * while the +1 soldier gates on peer approval. Gating the veto on approval
   * would give living factions a reason to withhold the reaction from someone
   * whose veto they fear, which weaponizes the one mechanic the design insists
   * stays non-adversarial.
   *
   * Post times are deliberately absent: Early Bird keys on `postedAt` of an
   * approved action, so nothing needs a time here.
   */
  postedToday: FactionId[]
  settlements: Record<MarketId, Settlement>
}
```

- [ ] **Step 4: Gate the protection in `combat.ts`**

In `src/engine/combat.ts`, change the signature and the 6a block:

```ts
export function resolveCombat(
  state: GameState,
  orders: Order[],
  postedToday: FactionId[],
): {
  ownership: Record<TerritoryId, FactionId>
  garrisons: Record<TerritoryId, number>
  events: TickEvent[]
} {
  const ownership = { ...state.ownership }
  const garrisons = { ...state.garrisons }
  const events: TickEvent[] = []
  const sorted = [...orders].sort((a, b) => cmp(a.factionId, b.factionId))

  // 6a — parity protections. Both halves of the condition are load-bearing:
  // eliminated, so a living faction cannot claim a free veto while holding a
  // full army; and posted, because the veto is what an eliminated player gets
  // for showing up. Neither half may move outside the engine -- the golden file
  // only pins what crosses this boundary.
  const posted = new Set(postedToday)
  const picks: Record<TerritoryId, number> = {}
  for (const o of sorted) {
    if (o.protect && posted.has(o.factionId) && territoriesOf(state, o.factionId).length === 0) {
      picks[o.protect] = (picks[o.protect] ?? 0) + 1
    }
  }
```

The rest of the function is unchanged.

- [ ] **Step 5: Update the three callers and the existing tests**

In `src/engine/resolve.ts:91`:

```ts
  // 6 — combat, against the post-deploy garrisons.
  const combat = resolveCombat({ ...state, garrisons, reserves }, clean, context.postedToday)
```

Every existing `resolveCombat(state, orders)` call in `src/engine/combat.test.ts` gains a third argument. Pass the ids of every faction the test expects to be able to veto — for tests that assert a protection fires, that is the protecting faction; for tests with no `protect` field, pass `[]`.

Every literal `DailyContext` in the codebase gains `postedToday`. Find them with:

```bash
grep -rln "approvals:" src/ | sort
```

In `src/sim/run.ts`, the day loop builds `approvals` from `p.irlActionsPerDay` for each policy, using the policy's `name` as the faction id. Add the parallel array — every approval implies a post, and the sim has no unapproved posts, so `postedToday` is exactly the policies that acted:

```ts
    const approvals: ApprovedAction[] = []
    const postedToday: FactionId[] = []
    policies.forEach((p, i) => {
      if (p.irlActionsPerDay > 0) postedToday.push(p.name)
      for (let k = 0; k < p.irlActionsPerDay; k++) {
        approvals.push({
          eventId: `${day}-${p.name}-${k}`,
          playerId: p.name,
          postedAt: `T${String(6 + i).padStart(2, "0")}:${String(k * 10).padStart(2, "0")}`,
          approvedAt: `T${String(8 + i).padStart(2, "0")}:${String(k * 10).padStart(2, "0")}`,
        })
      }
    })
```

and further down, the context literal:

```ts
    const context: DailyContext = { slate, approvals, postedToday: postedToday.sort(), settlements }
```

This makes `Slacker` — the only policy with `irlActionsPerDay: 0` — lose its veto once eliminated, which is exactly the behaviour change the gate exists to produce. Expect it to show in Step 9's balance run.

- [ ] **Step 6: Run the full engine and sim suites**

Run: `npx vitest run src/engine src/sim`
Expected: every test passes except `src/engine/golden.test.ts`, which fails on a changed hash — the scripted season includes a protect pick, and that pick's faction now has to post.

If any *other* test fails, stop and read it. A failure in `resolve.test.ts` or `invariants.test.ts` means a `DailyContext` literal was missed, not that the gate is wrong.

- [ ] **Step 7: Give the golden season a post, then regenerate deliberately**

In `src/engine/golden.test.ts`, the scripted season builds a `DailyContext` per day. The eliminated faction that claims a protect must now appear in `postedToday`, or the golden file records a season in which the veto silently stopped working — which would pin the bug rather than the behaviour.

Find the day whose context carries the protect pick and give that faction a post. The simplest correct rule for the scripted season, since it exercises IRL grants every day, is to derive it from the approvals plus any protecting faction:

```ts
const contextFor = (day: number, approvals: ApprovedAction[], protectors: FactionId[]): DailyContext => ({
  slate: [market(day, 0.5)],
  approvals,
  // Every approved action implies a post; protectors post without being approved.
  postedToday: [...new Set([...approvals.map((a) => a.playerId), ...protectors])].sort(),
  settlements: {},
})
```

Adapt this to whatever shape `scriptedSeason()` already uses — the point is that the protecting faction is in `postedToday` on the day it protects, and that the array is sorted.

Then confirm the golden test is the *only* thing failing, delete the fixture, and regenerate:

```bash
npx vitest run src/engine    # confirm golden.test.ts is the sole failure
rm src/engine/__golden__/season-1.json
npx vitest run src/engine/golden.test.ts   # writes the file when absent
git diff --stat src/engine/__golden__/season-1.json
```

- [ ] **Step 8: Review the regenerated golden diff before committing it**

Run: `git diff src/engine/__golden__/season-1.json | head -60`

Expected: the diff touches the protection day and whatever follows from it. If the diff shows changes on days with no protect pick, the gate is affecting something it should not — stop and find out why. Regenerating a golden file without reading the diff is how a real regression gets committed as a fixture.

- [ ] **Step 9: Run the whole suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: all 271 tests pass, plus the three new ones.

- [ ] **Step 10: Commit**

```bash
git add src/engine src/sim/run.ts
git commit -m "feat(engine): gate the elimination veto on posting an action

DailyContext gains postedToday. combat.ts gated on elimination alone, so an
eliminated player who posted nothing still vetoed an attack. Filtering protect
outside the engine was rejected: the golden file only pins what crosses the
boundary, and the sim needs the same rule."
```

---

### Task 2: Slack config, environment, and the roster

Three small pieces that every later task consumes. The fail-boot behaviour is the security-critical one and gets the most tests.

**Files:**
- Create: `src/slack/config.ts`
- Create: `src/slack/env.ts`
- Create: `src/slack/env.test.ts`
- Modify: `src/store/schema.ts` — append migration 2
- Modify: `src/store/types.ts` — add `RosterStore`
- Modify: `src/store/sqlite.ts` — implement it
- Modify: `src/store/sqlite.test.ts`
- Modify: `src/jobs/cli.ts` — `roster-add`, `roster-list`

**Interfaces:**
- Produces: `APPROVAL_EMOJI`, `TICK_HOUR`, `MAX_RECAP_BLOCKS`, `RECAP_NAME_MAX_CHARS`; `loadSlackEnv(env?): SlackEnv`; `SlackEnv { signingSecret, botToken, teamId, channelId }`; `RosterStore { addRosterMember, roster, factionForSlackUser, slackUserForFaction }`; `RosterMember { slackUserId, factionId, displayName }`

- [ ] **Step 1: Write `src/slack/config.ts`**

```ts
/**
 * Reaction names that count as an approval, AFTER normalization by
 * `normalizeEmoji`. Slack sends `+1`, `thumbsup` and `+1::skin-tone-3` as three
 * distinct strings for what players see as one reaction.
 */
export const APPROVAL_EMOJI: ReadonlySet<string> = new Set(["+1"])

/**
 * Emoji aliases that mean the same reaction. Keys and values are both
 * post-skin-tone-strip. Slack's own alias table is much larger; this covers
 * only the approval reaction, because nothing else is read.
 */
export const EMOJI_ALIASES: Readonly<Record<string, string>> = {
  thumbsup: "+1",
  thumbsup_all: "+1",
  "+1": "+1",
}

/** The order lock and approval cutoff, in America/New_York. */
export const TICK_HOUR = 21

/**
 * Slack rejects a message with more than 50 blocks. The recap truncates rather
 * than failing to post: a partial recap beats no recap.
 */
export const MAX_RECAP_BLOCKS = 48

/** Player display names are player-supplied. Cap them like any other untrusted text. */
export const RECAP_NAME_MAX_CHARS = 40

/**
 * Slack Web API base. Overridable so tests can point at a local fake without
 * any chance of a real request escaping.
 */
export const SLACK_API_BASE = "https://slack.com/api"
```

- [ ] **Step 2: Write the failing env test**

Create `src/slack/env.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { loadSlackEnv } from "./env.js"

const complete = {
  SLACK_SIGNING_SECRET: "s3cret",
  SLACK_BOT_TOKEN: "xoxb-token",
  SLACK_TEAM_ID: "T01ABCDEF",
  SLACK_CHANNEL_ID: "C01ABCDEF",
}

describe("loadSlackEnv", () => {
  it("returns every value when the environment is complete", () => {
    expect(loadSlackEnv(complete)).toEqual({
      signingSecret: "s3cret",
      botToken: "xoxb-token",
      teamId: "T01ABCDEF",
      channelId: "C01ABCDEF",
    })
  })

  it("throws when the signing secret is missing", () => {
    const { SLACK_SIGNING_SECRET: _, ...rest } = complete
    expect(() => loadSlackEnv(rest)).toThrow(/SLACK_SIGNING_SECRET/)
  })

  it("throws when the signing secret is present but empty", () => {
    // An unset variable in a systemd EnvironmentFile arrives as "", not as
    // undefined. Treating "" as present is how a service boots unverified.
    expect(() => loadSlackEnv({ ...complete, SLACK_SIGNING_SECRET: "" })).toThrow(
      /SLACK_SIGNING_SECRET/,
    )
  })

  it("throws for each other missing variable", () => {
    for (const key of ["SLACK_BOT_TOKEN", "SLACK_TEAM_ID", "SLACK_CHANNEL_ID"]) {
      const partial = { ...complete, [key]: undefined }
      expect(() => loadSlackEnv(partial)).toThrow(new RegExp(key))
    }
  })

  it("refuses to boot when a secret is exposed to the client bundle", () => {
    // Next.js inlines every NEXT_PUBLIC_ variable into the browser bundle. The
    // spec requires this assertion at boot; Plan 4 shares this process's
    // environment.
    expect(() =>
      loadSlackEnv({ ...complete, NEXT_PUBLIC_SLACK_BOT_TOKEN: "xoxb-leaked" }),
    ).toThrow(/NEXT_PUBLIC_SLACK_BOT_TOKEN/)
  })

  it("allows a NEXT_PUBLIC_ variable that is not secret-shaped", () => {
    expect(() => loadSlackEnv({ ...complete, NEXT_PUBLIC_SITE_URL: "https://x" })).not.toThrow()
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run src/slack/env.test.ts`
Expected: FAIL — `Cannot find module './env.js'`.

- [ ] **Step 4: Write `src/slack/env.ts`**

```ts
export interface SlackEnv {
  signingSecret: string
  botToken: string
  teamId: string
  channelId: string
}

type Env = Record<string, string | undefined>

/** Substrings that mark a variable as carrying a secret. */
const SECRET_MARKERS = ["SECRET", "TOKEN", "KEY", "PASSWORD"]

function required(env: Env, name: string): string {
  const v = env[name]
  // "" and undefined are both absent. A systemd EnvironmentFile line with no
  // value yields "", and treating that as present is exactly how a service
  // boots with signature verification silently disabled.
  if (v === undefined || v === "") {
    throw new Error(`${name} is not set — refusing to start. See deploy/README.md.`)
  }
  return v
}

/**
 * Load and validate the Slack environment. Throws on anything missing.
 *
 * Called at module scope by the bot entrypoint on purpose: a missing signing
 * secret must kill the process, never degrade into an unverified handler.
 */
export function loadSlackEnv(env: Env = process.env): SlackEnv {
  for (const key of Object.keys(env).sort()) {
    if (!key.startsWith("NEXT_PUBLIC_")) continue
    if (SECRET_MARKERS.some((m) => key.includes(m))) {
      throw new Error(
        `${key} is exposed to the client bundle — Next.js inlines every ` +
          `NEXT_PUBLIC_ variable into browser JavaScript. Rename it.`,
      )
    }
  }

  return {
    signingSecret: required(env, "SLACK_SIGNING_SECRET"),
    botToken: required(env, "SLACK_BOT_TOKEN"),
    teamId: required(env, "SLACK_TEAM_ID"),
    channelId: required(env, "SLACK_CHANNEL_ID"),
  }
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run src/slack/env.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Append migration 2 to `src/store/schema.ts`**

Add a second entry to the `MIGRATIONS` array. Do not edit the first one — it has shipped.

```ts
  `
  -- Slack user id -> faction. Opaque ids (U01ABCDEF) that only a human can map,
  -- and per-season configuration rather than code, so it lives in the database
  -- and is seeded by "npm run roster:add".
  CREATE TABLE roster (
    slack_user_id TEXT PRIMARY KEY,
    faction_id    TEXT NOT NULL UNIQUE,
    display_name  TEXT NOT NULL
  );

  -- Dedupe ledger. Slack redelivers an event up to three times when the ack is
  -- slow, and a retry carries the same event_id. Without this, one retried
  -- reaction becomes two approvals.
  CREATE TABLE slack_events (
    event_id    TEXT PRIMARY KEY,
    received_at TEXT NOT NULL
  );

  -- One row per workout photo. message_ts is Slack's own identifier for the
  -- message and is stable across edits, which is what lets a reaction find its
  -- post.
  --
  -- posted_at and et_date both derive from message_ts, never from the time the
  -- row was written: a post at 20:59:59 delivered at 21:00:01 still counts for
  -- that day.
  CREATE TABLE posts (
    message_ts TEXT PRIMARY KEY,
    faction_id TEXT NOT NULL,
    posted_at  TEXT NOT NULL,          -- ISO instant derived from message_ts
    et_date    TEXT NOT NULL,          -- America/New_York calendar date
    deleted    INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX posts_by_date ON posts (et_date);

  -- One row per (post, distinct approver). The primary key IS the "count
  -- distinct reactors" rule: a second approval emoji from the same player --
  -- 👍 after 👍🏽 -- collides and is ignored.
  --
  -- reacted_at is the reaction's Slack event_ts. The second one of these, in
  -- ascending order, becomes ApprovedAction.approvedAt.
  CREATE TABLE reactions (
    message_ts TEXT NOT NULL,
    faction_id TEXT NOT NULL,
    reacted_at TEXT NOT NULL,
    PRIMARY KEY (message_ts, faction_id)
  );
  `,
```

- [ ] **Step 7: Write the failing roster test**

Add to `src/store/sqlite.test.ts`, following the file's existing `openStore(":memory:")` pattern:

```ts
describe("roster", () => {
  it("maps in both directions and returns members sorted by faction", () => {
    const store = openStore(":memory:")
    store.addRosterMember({ slackUserId: "U2", factionId: "f2", displayName: "Bex" })
    store.addRosterMember({ slackUserId: "U1", factionId: "f1", displayName: "Ada" })

    expect(store.factionForSlackUser("U1")).toBe("f1")
    expect(store.factionForSlackUser("U404")).toBeUndefined()
    expect(store.slackUserForFaction("f2")).toBe("U2")
    expect(store.roster().map((m) => m.factionId)).toEqual(["f1", "f2"])
    store.close()
  })

  it("updates the display name on a repeat add rather than failing", () => {
    const store = openStore(":memory:")
    store.addRosterMember({ slackUserId: "U1", factionId: "f1", displayName: "Ada" })
    store.addRosterMember({ slackUserId: "U1", factionId: "f1", displayName: "Ada L." })
    expect(store.roster()).toEqual([{ slackUserId: "U1", factionId: "f1", displayName: "Ada L." }])
    store.close()
  })

  it("refuses to give one faction to two Slack users", () => {
    // Two accounts on one faction would let a player approve their own post
    // from an alt, which the self-approval check keys on faction id to prevent.
    const store = openStore(":memory:")
    store.addRosterMember({ slackUserId: "U1", factionId: "f1", displayName: "Ada" })
    expect(() =>
      store.addRosterMember({ slackUserId: "U2", factionId: "f1", displayName: "Alt" }),
    ).toThrow()
    store.close()
  })
})
```

- [ ] **Step 8: Run it to verify it fails**

Run: `npx vitest run src/store/sqlite.test.ts -t roster`
Expected: FAIL — `store.addRosterMember is not a function`.

- [ ] **Step 9: Add `RosterStore` to `src/store/types.ts`**

```ts
export interface RosterMember {
  slackUserId: string
  factionId: FactionId
  displayName: string
}

export interface RosterStore {
  /** Idempotent on slack_user_id; updates the display name. Throws if the faction is taken. */
  addRosterMember(member: RosterMember): void
  /** Every member, ordered by faction id. */
  roster(): RosterMember[]
  factionForSlackUser(slackUserId: string): FactionId | undefined
  slackUserForFaction(factionId: FactionId): string | undefined
}
```

Add `FactionId` to the existing type import at the top of the file, and widen the store's return type. `openStore` currently returns `SlateStore`; change it to `SlateStore & RosterStore` in `src/store/sqlite.ts` and add `ApprovalStore` to the intersection in Task 4.

- [ ] **Step 10: Implement it in `src/store/sqlite.ts`**

Add to the returned object:

```ts
    addRosterMember(member: RosterMember): void {
      db.prepare(
        `INSERT INTO roster (slack_user_id, faction_id, display_name) VALUES (?, ?, ?)
         ON CONFLICT (slack_user_id) DO UPDATE SET display_name = excluded.display_name,
                                                   faction_id   = excluded.faction_id`,
      ).run(member.slackUserId, member.factionId, member.displayName)
    },

    roster(): RosterMember[] {
      const rows = db
        .prepare("SELECT slack_user_id, faction_id, display_name FROM roster ORDER BY faction_id")
        .all() as { slack_user_id: string; faction_id: string; display_name: string }[]
      return rows.map((r) => ({
        slackUserId: r.slack_user_id,
        factionId: r.faction_id,
        displayName: r.display_name,
      }))
    },

    factionForSlackUser(slackUserId: string): FactionId | undefined {
      const row = db
        .prepare("SELECT faction_id FROM roster WHERE slack_user_id = ?")
        .get(slackUserId) as { faction_id: string } | undefined
      return row?.faction_id
    },

    slackUserForFaction(factionId: FactionId): string | undefined {
      const row = db
        .prepare("SELECT slack_user_id FROM roster WHERE faction_id = ?")
        .get(factionId) as { slack_user_id: string } | undefined
      return row?.slack_user_id
    },
```

The third test passes without extra code: `faction_id TEXT NOT NULL UNIQUE` raises on the conflicting insert. Rows come back with a `null` prototype, so spread them rather than calling `Object.prototype` methods.

- [ ] **Step 11: Run the store tests**

Run: `npx vitest run src/store/sqlite.test.ts`
Expected: PASS, including the three new roster tests. Every pre-existing store test must still pass — migration 2 runs against the same fresh database.

- [ ] **Step 12: Add the roster CLI commands**

In `src/jobs/cli.ts`, add two branches alongside `season-init`:

```ts
  } else if (command === "roster-add") {
    const [slackUserId, factionId, ...nameParts] = process.argv.slice(3)
    const displayName = nameParts.join(" ")
    if (!slackUserId || !factionId || displayName === "") {
      throw new UsageError("usage: roster-add <slack-user-id> <faction-id> <display name>")
    }
    store.addRosterMember({ slackUserId, factionId, displayName })
    log(`roster: ${slackUserId} -> ${factionId} (${displayName})`)
  } else if (command === "roster-list") {
    for (const m of store.roster()) {
      log(`${m.factionId}\t${m.slackUserId}\t${m.displayName}`)
    }
```

Add both to the `unknown command` message's list of expected commands.

Add to `package.json` scripts:

```json
    "roster:add": "tsx src/jobs/cli.ts roster-add",
    "roster:list": "tsx src/jobs/cli.ts roster-list",
```

- [ ] **Step 13: Verify the CLI end to end**

```bash
RR_DB_PATH=/tmp/rr-plan3.db RR_SEASON_ID=season-1 npm run roster:add -- U01ABCDEF f1 "Ada L."
RR_DB_PATH=/tmp/rr-plan3.db RR_SEASON_ID=season-1 npm run roster:list
```

Expected: the second command prints `f1	U01ABCDEF	Ada L.`. Then `rm /tmp/rr-plan3.db*`.

- [ ] **Step 14: Commit**

```bash
git add src/slack/config.ts src/slack/env.ts src/slack/env.test.ts src/store src/jobs/cli.ts package.json
git commit -m "feat(slack): config, fail-boot environment loading, and the roster"
```

---

### Task 3: Pure event interpretation

Every decision about a Slack payload — is this a workout photo, is this an approval, is this even from our channel — before any row is written. No database, no Bolt, no clock.

**Files:**
- Create: `src/slack/events.ts`
- Create: `src/slack/events.test.ts`
- Modify: `src/time.ts` — add `slackTsToIso` and `etDateAdd`
- Modify: `src/time.test.ts`

**Interfaces:**
- Consumes: `APPROVAL_EMOJI`, `EMOJI_ALIASES` from `src/slack/config.js`; `etDate` from `src/time.js`
- Produces: `normalizeEmoji(name): string`; `slackTsToIso(ts): string`; `etDateAdd(date, days): string`; `interpretMessage(input): MessageDecision`; `interpretReaction(input): ReactionDecision`

- [ ] **Step 1: Write the failing time-helper tests**

Add to `src/time.test.ts`:

```ts
describe("slackTsToIso", () => {
  it("converts a Slack ts to an ISO instant", () => {
    // Slack sends seconds with a six-digit suffix, as a string.
    expect(slackTsToIso("1723237200.000200")).toBe("2026-08-09T21:00:00.000Z")
  })

  it("keeps millisecond precision", () => {
    expect(slackTsToIso("1723237200.123456")).toBe("2026-08-09T21:00:00.123Z")
  })

  it("rejects anything that is not a Slack ts", () => {
    // Never parse one of these with bare Number(): Number("") is 0, which would
    // silently place a post at the Unix epoch and hide it from every day query.
    for (const bad of ["", "abc", "1723237200", "1723237200.", ".000200", "-1.0"]) {
      expect(() => slackTsToIso(bad)).toThrow(/slackTsToIso/)
    }
  })
})

describe("etDateAdd", () => {
  it("advances a calendar date", () => {
    expect(etDateAdd("2026-08-09", 3)).toBe("2026-08-12")
  })

  it("crosses a month and a year boundary", () => {
    expect(etDateAdd("2026-08-31", 1)).toBe("2026-09-01")
    expect(etDateAdd("2026-12-31", 1)).toBe("2027-01-01")
  })

  it("is unaffected by a DST transition inside the interval", () => {
    // Counting in calendar dates rather than hours is the whole point.
    expect(etDateAdd("2026-11-01", 1)).toBe("2026-11-02")
    expect(etDateAdd("2026-03-08", 1)).toBe("2026-03-09")
  })

  it("round-trips with etDaysBetween", () => {
    expect(etDaysBetween("2026-08-09", etDateAdd("2026-08-09", 21))).toBe(21)
  })
})
```

Note: verify the expected ISO strings by running `node -e 'console.log(new Date(1723237200000).toISOString())'` before writing the implementation. If the epoch second above does not land on `2026-08-09T21:00:00Z`, use whatever it actually produces — the assertion must state the truth, not the intent.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/time.test.ts`
Expected: FAIL — `slackTsToIso is not exported`.

- [ ] **Step 3: Add the helpers to `src/time.ts`**

```ts
/**
 * A Slack `ts` / `event_ts` as an ISO instant.
 *
 * Slack sends "1723237200.000200": seconds, then a six-digit suffix that is a
 * per-message counter rather than true microseconds. ISO carries milliseconds,
 * so the suffix mostly rounds away — which is fine, because every ordering in
 * the game breaks ties on the raw ts string afterwards.
 *
 * Strict on purpose. Number("") is 0 and Number(null) is 0, so a bare Number()
 * here would place a malformed post at the Unix epoch, where no day query would
 * ever find it and no error would ever be raised.
 */
export function slackTsToIso(ts: string): string {
  const m = /^(\d{1,12})\.(\d{1,6})$/.exec(ts)
  if (!m) throw new Error(`slackTsToIso: not a Slack timestamp: ${JSON.stringify(ts)}`)
  const ms = Number(m[1]) * 1000 + Math.round(Number(m[2]!.padEnd(6, "0")) / 1000)
  const at = new Date(ms)
  if (Number.isNaN(at.getTime())) throw new Error(`slackTsToIso: out of range: ${ts}`)
  return at.toISOString()
}

/**
 * The ET calendar date `days` after another, as "YYYY-MM-DD".
 *
 * Reads both ends as UTC midnight, so a DST transition inside the interval
 * cannot shift the result. The inverse of `etDaysBetween`.
 */
export function etDateAdd(date: string, days: number): string {
  const [y, mo, d] = date.split("-").map(Number)
  if (y === undefined || mo === undefined || d === undefined) {
    throw new Error(`etDateAdd: not a YYYY-MM-DD date: ${date}`)
  }
  const at = new Date(Date.UTC(y, mo - 1, d) + days * 86_400_000)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/time.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing event-interpretation tests**

Create `src/slack/events.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { interpretMessage, interpretReaction, normalizeEmoji } from "./events.js"

const SCOPE = { teamId: "T1", channelId: "C1", roster: new Set(["U1", "U2", "U3"]) }

const photo = {
  teamId: "T1",
  event: {
    type: "message" as const,
    subtype: "file_share",
    channel: "C1",
    user: "U1",
    ts: "1723237200.000200",
    files: [{ mimetype: "image/jpeg" }],
  },
}

describe("normalizeEmoji", () => {
  it("collapses aliases and skin tones onto one name", () => {
    // These are four distinct strings in the API and one reaction to a player.
    for (const raw of ["+1", "thumbsup", "+1::skin-tone-3", "THUMBSUP"]) {
      expect(normalizeEmoji(raw)).toBe("+1")
    }
  })

  it("leaves an unrelated reaction alone", () => {
    expect(normalizeEmoji("tada")).toBe("tada")
    expect(normalizeEmoji("tada::skin-tone-2")).toBe("tada")
  })
})

describe("interpretMessage", () => {
  it("accepts a photo posted in the channel by a roster member", () => {
    expect(interpretMessage(photo, SCOPE)).toEqual({
      kind: "post",
      slackUserId: "U1",
      messageTs: "1723237200.000200",
    })
  })

  it("drops a message from another workspace", () => {
    // A shared channel can deliver events whose team_id is not ours.
    expect(interpretMessage({ ...photo, teamId: "T-EVIL" }, SCOPE)).toEqual({
      kind: "drop", reason: "wrong-team",
    })
  })

  it("drops a message from another channel", () => {
    const dm = { ...photo, event: { ...photo.event, channel: "D999" } }
    expect(interpretMessage(dm, SCOPE)).toEqual({ kind: "drop", reason: "wrong-channel" })
  })

  it("drops a message from a non-roster user", () => {
    const guest = { ...photo, event: { ...photo.event, user: "U404" } }
    expect(interpretMessage(guest, SCOPE)).toEqual({ kind: "drop", reason: "not-on-roster" })
  })

  it("drops a text-only message", () => {
    const chat = { teamId: "T1", event: { type: "message" as const, channel: "C1", user: "U1", ts: "1723237200.000200" } }
    expect(interpretMessage(chat, SCOPE)).toEqual({ kind: "drop", reason: "not-a-photo" })
  })

  it("drops a file share carrying no image", () => {
    const pdf = { ...photo, event: { ...photo.event, files: [{ mimetype: "application/pdf" }] } }
    expect(interpretMessage(pdf, SCOPE)).toEqual({ kind: "drop", reason: "not-a-photo" })
  })

  it("drops a photo posted inside a thread", () => {
    // Otherwise re-sharing yesterday's photo into a thread posts it again.
    const reply = { ...photo, event: { ...photo.event, thread_ts: "1723200000.000100" } }
    expect(interpretMessage(reply, SCOPE)).toEqual({ kind: "drop", reason: "thread-reply" })
  })

  it("accepts a photo that is its own thread parent", () => {
    const parent = { ...photo, event: { ...photo.event, thread_ts: photo.event.ts } }
    expect(interpretMessage(parent, SCOPE)).toMatchObject({ kind: "post" })
  })

  it("reads a deletion as a deletion, keyed on the deleted message", () => {
    const del = {
      teamId: "T1",
      event: {
        type: "message" as const,
        subtype: "message_deleted",
        channel: "C1",
        ts: "1723240000.000000",
        deleted_ts: "1723237200.000200",
      },
    }
    expect(interpretMessage(del, SCOPE)).toEqual({
      kind: "delete", messageTs: "1723237200.000200",
    })
  })

  it("drops a bot message", () => {
    // The recap posts photos-adjacent content; the bot must never approve itself
    // into the economy.
    const bot = { ...photo, event: { ...photo.event, subtype: "bot_message", bot_id: "B1" } }
    expect(interpretMessage(bot, SCOPE)).toEqual({ kind: "drop", reason: "not-a-photo" })
  })
})

describe("interpretReaction", () => {
  const reaction = {
    teamId: "T1",
    event: {
      type: "reaction_added" as const,
      user: "U2",
      reaction: "+1",
      item_user: "U1",
      item: { type: "message", channel: "C1", ts: "1723237200.000200" },
      event_ts: "1723237800.000100",
    },
  }

  it("accepts a thumbs-up from another roster member", () => {
    expect(interpretReaction(reaction, SCOPE)).toEqual({
      kind: "approve",
      slackUserId: "U2",
      messageTs: "1723237200.000200",
      reactedAt: "1723237800.000100",
    })
  })

  it("accepts a skin-toned thumbs-up", () => {
    const toned = { ...reaction, event: { ...reaction.event, reaction: "+1::skin-tone-5" } }
    expect(interpretReaction(toned, SCOPE)).toMatchObject({ kind: "approve" })
  })

  it("drops a self-approval", () => {
    const self = { ...reaction, event: { ...reaction.event, user: "U1" } }
    expect(interpretReaction(self, SCOPE)).toEqual({ kind: "drop", reason: "self-approval" })
  })

  it("drops a reaction that is not an approval", () => {
    const party = { ...reaction, event: { ...reaction.event, reaction: "tada" } }
    expect(interpretReaction(party, SCOPE)).toEqual({ kind: "drop", reason: "not-an-approval" })
  })

  it("drops a reaction in a DM", () => {
    // A 👍 in a DM counts for nothing.
    const dm = { ...reaction, event: { ...reaction.event, item: { type: "message", channel: "D9", ts: "1.0" } } }
    expect(interpretReaction(dm, SCOPE)).toEqual({ kind: "drop", reason: "wrong-channel" })
  })

  it("drops a reaction from a non-roster user", () => {
    const guest = { ...reaction, event: { ...reaction.event, user: "U404" } }
    expect(interpretReaction(guest, SCOPE)).toEqual({ kind: "drop", reason: "not-on-roster" })
  })

  it("drops a reaction on a non-message item", () => {
    const file = { ...reaction, event: { ...reaction.event, item: { type: "file", file: "F1" } } }
    expect(interpretReaction(file, SCOPE)).toEqual({ kind: "drop", reason: "not-a-message" })
  })

  it("reads a removal as an un-approval", () => {
    const removed = { ...reaction, event: { ...reaction.event, type: "reaction_removed" as const } }
    expect(interpretReaction(removed, SCOPE)).toEqual({
      kind: "unapprove",
      slackUserId: "U2",
      messageTs: "1723237200.000200",
    })
  })
})
```

- [ ] **Step 6: Run to verify it fails**

Run: `npx vitest run src/slack/events.test.ts`
Expected: FAIL — `Cannot find module './events.js'`.

- [ ] **Step 7: Write `src/slack/events.ts`**

The input types are deliberately structural and narrow rather than imports from `@slack/types`. Slack's own `MessageEvent` is a seventeen-member union, and a handler written against it spends its length narrowing. These shapes describe exactly the fields the game reads.

```ts
import { APPROVAL_EMOJI, EMOJI_ALIASES } from "./config.js"

export interface Scope {
  teamId: string
  channelId: string
  /** Slack user ids on the roster. */
  roster: ReadonlySet<string>
}

export type DropReason =
  | "wrong-team"
  | "wrong-channel"
  | "not-on-roster"
  | "not-a-photo"
  | "thread-reply"
  | "not-a-message"
  | "not-an-approval"
  | "self-approval"

export type MessageDecision =
  | { kind: "post"; slackUserId: string; messageTs: string }
  | { kind: "delete"; messageTs: string }
  | { kind: "drop"; reason: DropReason }

export type ReactionDecision =
  | { kind: "approve"; slackUserId: string; messageTs: string; reactedAt: string }
  | { kind: "unapprove"; slackUserId: string; messageTs: string }
  | { kind: "drop"; reason: DropReason }

interface MessageInput {
  teamId: string
  event: {
    type: "message"
    subtype?: string
    channel?: string
    user?: string
    ts?: string
    thread_ts?: string
    deleted_ts?: string
    bot_id?: string
    files?: { mimetype?: string }[]
  }
}

interface ReactionInput {
  teamId: string
  event: {
    type: "reaction_added" | "reaction_removed"
    user?: string
    reaction?: string
    item_user?: string
    item?: { type?: string; channel?: string; ts?: string }
    event_ts?: string
  }
}

/**
 * Collapse a Slack reaction name to its canonical form.
 *
 * `+1`, `thumbsup` and `+1::skin-tone-3` are three distinct strings in the API
 * and one reaction to a player. Comparing raw names means a player with a skin
 * tone set in their profile silently never approves anything.
 */
export function normalizeEmoji(name: string): string {
  const base = name.toLowerCase().split("::")[0] ?? ""
  return EMOJI_ALIASES[base] ?? base
}

export function interpretMessage(input: MessageInput, scope: Scope): MessageDecision {
  const { event } = input
  if (input.teamId !== scope.teamId) return { kind: "drop", reason: "wrong-team" }
  if (event.channel !== scope.channelId) return { kind: "drop", reason: "wrong-channel" }

  // A deletion arrives before the roster check: the post it names was already
  // proven to be ours when it was written, and the deletion event carries no
  // user field to check.
  if (event.subtype === "message_deleted") {
    if (event.deleted_ts === undefined) return { kind: "drop", reason: "not-a-photo" }
    return { kind: "delete", messageTs: event.deleted_ts }
  }

  if (event.subtype !== "file_share") return { kind: "drop", reason: "not-a-photo" }
  if (event.bot_id !== undefined) return { kind: "drop", reason: "not-a-photo" }

  const hasImage = (event.files ?? []).some((f) => f.mimetype?.startsWith("image/") === true)
  if (!hasImage) return { kind: "drop", reason: "not-a-photo" }

  // A photo re-shared into a thread would otherwise post yesterday's workout
  // again. A message that is its own thread parent is a normal top-level post.
  if (event.thread_ts !== undefined && event.thread_ts !== event.ts) {
    return { kind: "drop", reason: "thread-reply" }
  }

  if (event.user === undefined || !scope.roster.has(event.user)) {
    return { kind: "drop", reason: "not-on-roster" }
  }
  if (event.ts === undefined) return { kind: "drop", reason: "not-a-photo" }

  return { kind: "post", slackUserId: event.user, messageTs: event.ts }
}

export function interpretReaction(input: ReactionInput, scope: Scope): ReactionDecision {
  const { event } = input
  if (input.teamId !== scope.teamId) return { kind: "drop", reason: "wrong-team" }
  if (event.item?.type !== "message") return { kind: "drop", reason: "not-a-message" }
  if (event.item.channel !== scope.channelId) return { kind: "drop", reason: "wrong-channel" }
  if (event.reaction === undefined || !APPROVAL_EMOJI.has(normalizeEmoji(event.reaction))) {
    return { kind: "drop", reason: "not-an-approval" }
  }
  if (event.user === undefined || !scope.roster.has(event.user)) {
    return { kind: "drop", reason: "not-on-roster" }
  }
  // "Two distinct OTHER players." Checked again in SQL when approvals are
  // derived, because an alt account added to the roster later would otherwise
  // leave a self-approval already written to disk.
  if (event.user === event.item_user) return { kind: "drop", reason: "self-approval" }
  if (event.item.ts === undefined) return { kind: "drop", reason: "not-a-message" }

  if (event.type === "reaction_removed") {
    return { kind: "unapprove", slackUserId: event.user, messageTs: event.item.ts }
  }
  if (event.event_ts === undefined) return { kind: "drop", reason: "not-a-message" }
  return {
    kind: "approve",
    slackUserId: event.user,
    messageTs: event.item.ts,
    reactedAt: event.event_ts,
  }
}
```

- [ ] **Step 8: Run to verify it passes**

Run: `npx vitest run src/slack/events.test.ts`
Expected: PASS, 20 tests.

- [ ] **Step 9: Commit**

```bash
git add src/slack/events.ts src/slack/events.test.ts src/time.ts src/time.test.ts
git commit -m "feat(slack): pure event interpretation, emoji normalization, ts helpers"
```

---

### Task 4: Persisting posts and approvals

The store side. Every write is idempotent, because Slack redelivers.

**Files:**
- Modify: `src/store/types.ts` — add `ApprovalStore`
- Modify: `src/store/sqlite.ts`
- Modify: `src/store/sqlite.test.ts`

**Interfaces:**
- Consumes: `slackTsToIso`, `etDate` from `src/time.js`
- Produces: `ApprovalStore { markEventSeen, recordPost, deletePost, recordApproval, removeApproval }`

- [ ] **Step 1: Write the failing tests**

Add to `src/store/sqlite.test.ts`:

```ts
describe("slack ingest", () => {
  const seed = () => {
    const store = openStore(":memory:")
    store.addRosterMember({ slackUserId: "U1", factionId: "f1", displayName: "Ada" })
    store.addRosterMember({ slackUserId: "U2", factionId: "f2", displayName: "Bex" })
    store.addRosterMember({ slackUserId: "U3", factionId: "f3", displayName: "Cy" })
    return store
  }

  it("marks an event seen exactly once", () => {
    // Slack redelivers up to three times when the ack is slow, with the same
    // event_id. Without this, one retried reaction becomes two approvals.
    const store = seed()
    expect(store.markEventSeen("Ev1", new Date("2026-08-09T12:00:00Z"))).toBe(true)
    expect(store.markEventSeen("Ev1", new Date("2026-08-09T12:00:01Z"))).toBe(false)
    store.close()
  })

  it("records a post under the ET date of its Slack ts", () => {
    const store = seed()
    // 2026-08-10T01:30:00Z is 21:30 on 2026-08-09 in New York.
    const ts = String(Date.UTC(2026, 7, 10, 1, 30) / 1000) + ".000100"
    store.recordPost({ messageTs: ts, factionId: "f1" })
    expect(store.postsOn("2026-08-09").map((p) => p.factionId)).toEqual(["f1"])
    expect(store.postsOn("2026-08-10")).toEqual([])
    store.close()
  })

  it("is idempotent on a repeated post", () => {
    const store = seed()
    const ts = "1723237200.000200"
    store.recordPost({ messageTs: ts, factionId: "f1" })
    store.recordPost({ messageTs: ts, factionId: "f1" })
    expect(store.postsOn(etDate(new Date(slackTsToIso(ts)))).length).toBe(1)
    store.close()
  })

  it("hides a deleted post without losing its reactions", () => {
    const store = seed()
    const ts = "1723237200.000200"
    const day = etDate(new Date(slackTsToIso(ts)))
    store.recordPost({ messageTs: ts, factionId: "f1" })
    store.recordApproval({ messageTs: ts, factionId: "f2", reactedAt: "1723237800.000100" })
    store.deletePost(ts)
    expect(store.postsOn(day)).toEqual([])
    // Undeleting is not a feature; the reaction row surviving is just honesty
    // about what happened, and costs nothing.
    store.close()
  })

  it("tolerates a deletion for a post it never saw", () => {
    // Slack sends message_deleted for every message in the channel, including
    // text chatter the ingest ignored.
    const store = seed()
    expect(() => store.deletePost("1723237200.000200")).not.toThrow()
    store.close()
  })

  it("counts one approval per distinct approver and keeps the first timestamp", () => {
    const store = seed()
    const ts = "1723237200.000200"
    store.recordPost({ messageTs: ts, factionId: "f1" })
    store.recordApproval({ messageTs: ts, factionId: "f2", reactedAt: "1723237800.000100" })
    // 👍 after 👍🏽 from the same player is one reaction, and must not advance
    // the timestamp -- approvedAt is the SECOND distinct approver's reaction.
    store.recordApproval({ messageTs: ts, factionId: "f2", reactedAt: "1723239999.000100" })
    // Stored as an ISO instant, not as a raw Slack ts: the cutoff comparison in
    // Task 5 is a string comparison, and comparing "1723237800.000100" against
    // "2026-08-09T21:00:00.000Z" is always false in the same direction.
    expect(store.approversOf(ts)).toEqual([
      { factionId: "f2", reactedAt: slackTsToIso("1723237800.000100") },
    ])
    store.close()
  })

  it("removes an approval", () => {
    const store = seed()
    const ts = "1723237200.000200"
    store.recordPost({ messageTs: ts, factionId: "f1" })
    store.recordApproval({ messageTs: ts, factionId: "f2", reactedAt: "1723237800.000100" })
    store.removeApproval(ts, "f2")
    expect(store.approversOf(ts)).toEqual([])
    store.close()
  })
})
```

`postsOn` and `approversOf` are test-facing read helpers on the store; they are also used by Task 5's derivation. Import `etDate` and `slackTsToIso` from `../time.js` at the top of the test file.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/store/sqlite.test.ts -t "slack ingest"`
Expected: FAIL — `store.markEventSeen is not a function`.

- [ ] **Step 3: Add `ApprovalStore` to `src/store/types.ts`**

```ts
export interface PostRow {
  messageTs: string
  factionId: FactionId
  postedAt: string
  etDate: string
}

export interface ApproverRow {
  factionId: FactionId
  reactedAt: string
}

export interface ApprovalStore {
  /**
   * Record an event id. Returns false if it was already recorded, which means
   * this delivery is a Slack retry and must not be processed again.
   */
  markEventSeen(eventId: string, receivedAt: Date): boolean

  /** Idempotent. postedAt and etDate are derived from messageTs, never from a clock. */
  recordPost(post: { messageTs: string; factionId: FactionId }): void

  /** Hides a post from every query. A no-op if the post was never recorded. */
  deletePost(messageTs: string): void

  /** Idempotent per (post, approver). The first reaction's timestamp wins. */
  recordApproval(approval: { messageTs: string; factionId: FactionId; reactedAt: string }): void

  removeApproval(messageTs: string, factionId: FactionId): void

  /** Live posts on an ET calendar date, ordered by post time then message ts. */
  postsOn(etDate: string): PostRow[]

  /** Distinct approvers of a post, ordered by reaction time then faction id. */
  approversOf(messageTs: string): ApproverRow[]
}
```

- [ ] **Step 4: Implement it in `src/store/sqlite.ts`**

Add `import { etDate, slackTsToIso } from "../time.js"` at the top, and these methods to the returned object:

```ts
    markEventSeen(eventId: string, receivedAt: Date): boolean {
      const res = db
        .prepare("INSERT OR IGNORE INTO slack_events (event_id, received_at) VALUES (?, ?)")
        .run(eventId, receivedAt.toISOString())
      return Number(res.changes) > 0
    },

    recordPost(post: { messageTs: string; factionId: FactionId }): void {
      // Both derived from the Slack ts, never from the write time: a post at
      // 20:59:59 delivered at 21:00:01 still belongs to that day.
      const postedAt = slackTsToIso(post.messageTs)
      db.prepare(
        `INSERT INTO posts (message_ts, faction_id, posted_at, et_date, deleted)
         VALUES (?, ?, ?, ?, 0)
         ON CONFLICT (message_ts) DO NOTHING`,
      ).run(post.messageTs, post.factionId, postedAt, etDate(new Date(postedAt)))
    },

    deletePost(messageTs: string): void {
      db.prepare("UPDATE posts SET deleted = 1 WHERE message_ts = ?").run(messageTs)
    },

    recordApproval(a: { messageTs: string; factionId: FactionId; reactedAt: string }): void {
      // OR IGNORE, not an upsert: the first reaction's timestamp is the one that
      // counts, because approvedAt is defined as the second distinct approver's
      // reaction and a re-reaction must not move it later.
      //
      // Stored as an ISO instant so it is directly comparable with the 21:00
      // cutoff. A raw Slack ts and an ISO string compare as strings and would
      // put every reaction on the wrong side of the cutoff, silently and in the
      // same direction every time.
      db.prepare(
        `INSERT OR IGNORE INTO reactions (message_ts, faction_id, reacted_at) VALUES (?, ?, ?)`,
      ).run(a.messageTs, a.factionId, slackTsToIso(a.reactedAt))
    },

    removeApproval(messageTs: string, factionId: FactionId): void {
      db.prepare("DELETE FROM reactions WHERE message_ts = ? AND faction_id = ?").run(
        messageTs,
        factionId,
      )
    },

    postsOn(date: string): PostRow[] {
      const rows = db
        .prepare(
          `SELECT message_ts, faction_id, posted_at, et_date
             FROM posts WHERE et_date = ? AND deleted = 0
            ORDER BY posted_at, message_ts`,
        )
        .all(date) as {
        message_ts: string
        faction_id: string
        posted_at: string
        et_date: string
      }[]
      return rows.map((r) => ({
        messageTs: r.message_ts,
        factionId: r.faction_id,
        postedAt: r.posted_at,
        etDate: r.et_date,
      }))
    },

    approversOf(messageTs: string): ApproverRow[] {
      const rows = db
        .prepare(
          `SELECT faction_id, reacted_at FROM reactions WHERE message_ts = ?
            ORDER BY reacted_at, faction_id`,
        )
        .all(messageTs) as { faction_id: string; reacted_at: string }[]
      return rows.map((r) => ({ factionId: r.faction_id, reactedAt: r.reacted_at }))
    },
```

Widen `openStore`'s return type to `SlateStore & RosterStore & ApprovalStore`.

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/store/sqlite.test.ts`
Expected: PASS, all seven new tests plus everything pre-existing.

- [ ] **Step 6: Commit**

```bash
git add src/store
git commit -m "feat(store): idempotent Slack post and approval persistence"
```

---

### Task 5: Deriving the day's approvals

The bridge from rows to `DailyContext`. This is where "two distinct other players before the cutoff" becomes a real query, and where the tick gets `postedToday`.

**Files:**
- Create: `src/slack/approvals.ts`
- Create: `src/slack/approvals.test.ts`

**Interfaces:**
- Consumes: `ApprovalStore`, `SlateStore` from `src/store/types.js`; `etDateAdd`, `etInstant`, `slackTsToIso` from `src/time.js`; `TICK_HOUR` from `src/slack/config.js`
- Produces: `dailyApprovals(store, seasonId, day): { approvals: ApprovedAction[]; postedToday: FactionId[] }`

- [ ] **Step 1: Write the failing tests**

Create `src/slack/approvals.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { openStore } from "../store/sqlite.js"
import { dailyApprovals } from "./approvals.js"

/** Slack ts for a wall-clock time in New York on 2026-08-09 (EDT, UTC-4). */
const ts = (hour: number, minute: number, seq = 1) =>
  `${Date.UTC(2026, 7, 9, hour + 4, minute) / 1000}.${String(seq).padStart(6, "0")}`

function seeded() {
  const store = openStore(":memory:")
  store.upsertSeason({ seasonId: "s1", startDate: "2026-08-06", lengthDays: 21 })
  for (const [u, f, n] of [["U1", "f1", "Ada"], ["U2", "f2", "Bex"], ["U3", "f3", "Cy"]] as const) {
    store.addRosterMember({ slackUserId: u, factionId: f, displayName: n })
  }
  return store
}

// day 3 of the season is 2026-08-09, since day 0 was dealt on 2026-08-06.
const DAY = 3

describe("dailyApprovals", () => {
  it("needs two distinct approvers before an action counts", () => {
    const store = seeded()
    const post = ts(7, 0)
    store.recordPost({ messageTs: post, factionId: "f1" })
    store.recordApproval({ messageTs: post, factionId: "f2", reactedAt: ts(8, 0) })

    // One approver: posted, but not approved.
    let out = dailyApprovals(store, "s1", DAY)
    expect(out.approvals).toEqual([])
    expect(out.postedToday).toEqual(["f1"])

    store.recordApproval({ messageTs: post, factionId: "f3", reactedAt: ts(9, 0) })
    out = dailyApprovals(store, "s1", DAY)
    expect(out.approvals).toEqual([
      {
        eventId: post,
        playerId: "f1",
        postedAt: new Date(Date.UTC(2026, 7, 9, 11, 0)).toISOString(),
        approvedAt: new Date(Date.UTC(2026, 7, 9, 13, 0)).toISOString(),
      },
    ])
  })

  it("dates approvedAt from the SECOND approver, not the last", () => {
    // Under the Wire keys on this. Taking the last approver would hand the
    // bonus to whoever happened to pile on late.
    const store = seeded()
    const post = ts(7, 0)
    store.recordPost({ messageTs: post, factionId: "f1" })
    store.recordApproval({ messageTs: post, factionId: "f2", reactedAt: ts(8, 0) })
    store.recordApproval({ messageTs: post, factionId: "f3", reactedAt: ts(9, 0) })
    store.recordApproval({ messageTs: post, factionId: "f4", reactedAt: ts(20, 0) })

    expect(dailyApprovals(store, "s1", DAY).approvals[0]!.approvedAt).toBe(
      new Date(Date.UTC(2026, 7, 9, 13, 0)).toISOString(),
    )
  })

  it("excludes an approval that landed after the 21:00 cutoff", () => {
    const store = seeded()
    const post = ts(7, 0)
    store.recordPost({ messageTs: post, factionId: "f1" })
    store.recordApproval({ messageTs: post, factionId: "f2", reactedAt: ts(20, 59) })
    store.recordApproval({ messageTs: post, factionId: "f3", reactedAt: ts(21, 1) })
    expect(dailyApprovals(store, "s1", DAY).approvals).toEqual([])
  })

  it("counts an approval at 20:59:59 no matter when it was delivered", () => {
    // The row's write time is irrelevant; only the Slack event_ts is read.
    const store = seeded()
    const post = ts(7, 0)
    store.recordPost({ messageTs: post, factionId: "f1" })
    store.recordApproval({ messageTs: post, factionId: "f2", reactedAt: ts(20, 59, 1) })
    store.recordApproval({ messageTs: post, factionId: "f3", reactedAt: ts(20, 59, 2) })
    expect(dailyApprovals(store, "s1", DAY).approvals).toHaveLength(1)
  })

  it("never counts a self-approval even if one was written", () => {
    // Defence in depth: interpretReaction already drops these, but an alt
    // account added to the roster after the fact would leave one on disk.
    const store = seeded()
    const post = ts(7, 0)
    store.recordPost({ messageTs: post, factionId: "f1" })
    store.recordApproval({ messageTs: post, factionId: "f1", reactedAt: ts(8, 0) })
    store.recordApproval({ messageTs: post, factionId: "f2", reactedAt: ts(9, 0) })
    expect(dailyApprovals(store, "s1", DAY).approvals).toEqual([])
  })

  it("drops a deleted post from both approvals and postedToday", () => {
    const store = seeded()
    const post = ts(7, 0)
    store.recordPost({ messageTs: post, factionId: "f1" })
    store.recordApproval({ messageTs: post, factionId: "f2", reactedAt: ts(8, 0) })
    store.recordApproval({ messageTs: post, factionId: "f3", reactedAt: ts(9, 0) })
    store.deletePost(post)
    expect(dailyApprovals(store, "s1", DAY)).toEqual({ approvals: [], postedToday: [] })
  })

  it("reports an unapproved post in postedToday", () => {
    // The elimination veto gates on posting alone. This is the case that makes
    // the two lists differ, and the reason postedToday exists.
    const store = seeded()
    store.recordPost({ messageTs: ts(7, 0), factionId: "f1" })
    expect(dailyApprovals(store, "s1", DAY)).toEqual({ approvals: [], postedToday: ["f1"] })
  })

  it("excludes a post made after the cutoff from postedToday", () => {
    const store = seeded()
    store.recordPost({ messageTs: ts(21, 30), factionId: "f1" })
    expect(dailyApprovals(store, "s1", DAY).postedToday).toEqual([])
  })

  it("returns each faction once in postedToday and sorts it", () => {
    const store = seeded()
    store.recordPost({ messageTs: ts(7, 0), factionId: "f2" })
    store.recordPost({ messageTs: ts(8, 0), factionId: "f2" })
    store.recordPost({ messageTs: ts(9, 0), factionId: "f1" })
    expect(dailyApprovals(store, "s1", DAY).postedToday).toEqual(["f1", "f2"])
  })

  it("returns approvals ordered by post time, ties on message ts", () => {
    const store = seeded()
    const approve = (post: string) => {
      store.recordApproval({ messageTs: post, factionId: "f2", reactedAt: ts(20, 0) })
      store.recordApproval({ messageTs: post, factionId: "f3", reactedAt: ts(20, 1) })
    }
    const later = ts(9, 0), earlierB = ts(7, 0, 2), earlierA = ts(7, 0, 1)
    for (const p of [later, earlierB, earlierA]) {
      store.recordPost({ messageTs: p, factionId: "f1" })
      approve(p)
    }
    expect(dailyApprovals(store, "s1", DAY).approvals.map((a) => a.eventId)).toEqual([
      earlierA, earlierB, later,
    ])
  })

  it("returns empty for a day with nothing on it", () => {
    expect(dailyApprovals(seeded(), "s1", 1)).toEqual({ approvals: [], postedToday: [] })
  })

  it("throws for an unknown season", () => {
    expect(() => dailyApprovals(seeded(), "nope", 1)).toThrow(/unknown season/)
  })
})
```

The `f4` reference in the second test is not on the roster; that is fine — the store does not enforce roster membership on a reaction row, and the query counts approvers by faction id. If you prefer, add `f4` to `seeded()`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/slack/approvals.test.ts`
Expected: FAIL — `Cannot find module './approvals.js'`.

- [ ] **Step 3: Write `src/slack/approvals.ts`**

```ts
import type { ApprovedAction, FactionId } from "../engine/index.js"
import type { ApprovalStore, SlateStore } from "../store/types.js"
import { etDateAdd, etInstant } from "../time.js"
import { TICK_HOUR } from "./config.js"

export interface DailyIrl {
  approvals: ApprovedAction[]
  postedToday: FactionId[]
}

/**
 * Everything the IRL channel contributes to one tick's DailyContext.
 *
 * Two lists rather than one because the two mechanics gate differently: the +1
 * soldier needs two distinct other players to react, while the elimination veto
 * needs only that the player showed up. See the spec's "Approval is social, not
 * adversarial".
 *
 * Both are filtered by Slack timestamps, never by database write time. A
 * reaction at 20:59:59 delivered at 21:00:01 must still count, or an eliminated
 * player's veto silently evaporates.
 */
export function dailyApprovals(
  store: ApprovalStore & SlateStore,
  seasonId: string,
  day: number,
): DailyIrl {
  const season = store.season(seasonId)
  if (season === undefined) throw new Error(`dailyApprovals: unknown season ${seasonId}`)

  const date = etDateAdd(season.startDate, day)
  const cutoff = etInstant(date, TICK_HOUR).toISOString()

  const posts = store.postsOn(date).filter((p) => p.postedAt <= cutoff)

  const approvals: ApprovedAction[] = []
  for (const post of posts) {
    const approvers = store
      .approversOf(post.messageTs)
      // "Two distinct OTHER players." interpretReaction drops a self-approval
      // at ingest; this is the second gate, for a row written before an alt
      // account was mapped onto the poster's faction.
      .filter((a) => a.factionId !== post.factionId && a.reactedAt <= cutoff)

    const second = approvers[1]
    if (second === undefined) continue

    approvals.push({
      // The post's own ts. Unique per action and stable, where a reaction's
      // event_ts moves whenever an approval is removed and re-added.
      eventId: post.messageTs,
      playerId: post.factionId,
      postedAt: post.postedAt,
      approvedAt: second.reactedAt,
    })
  }

  // postsOn already orders by posted_at then message_ts, and approvals follows
  // that order. postedToday is a set, so it is sorted independently.
  const postedToday = [...new Set(posts.map((p) => p.factionId))].sort()

  return { approvals, postedToday }
}
```

Every timestamp compared here is an ISO instant: `postsOn` returns `posted_at` from `slackTsToIso`, `recordApproval` converts on the way in, and `etInstant(...).toISOString()` produces the cutoff. If a comparison ever looks suspiciously one-sided — every reaction inside the cutoff, or none — check that a raw Slack ts has not leaked into one side.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/slack/approvals.test.ts src/store`
Expected: PASS. If the ordering test fails, check that `postsOn` orders by `posted_at, message_ts` and not by insertion.

- [ ] **Step 5: Commit**

```bash
git add src/slack/approvals.ts src/slack/approvals.test.ts src/store
git commit -m "feat(slack): derive the day's approvals and posters from Slack rows"
```

---

### Task 6: The Bolt app

Thin wiring. Everything it does is a call into Task 3 or Task 4, and its own tests are about what happens when the environment is wrong.

**Files:**
- Create: `src/slack/handlers.ts`
- Create: `src/slack/handlers.test.ts`
- Create: `src/slack/app.ts`
- Create: `src/slack/app.test.ts`
- Modify: `package.json` — add the runtime dependencies

**Interfaces:**
- Consumes: everything from Tasks 2–4
- Produces: `handleMessageEvent(input, deps)`, `handleReactionEvent(input, deps)`, `createSlackApp(deps): App`, `IngestDeps { store, scope, log }`

- [ ] **Step 1: Install the dependencies**

```bash
npm install @slack/bolt@^5 @slack/web-api@^8
```

`@slack/web-api` is a transitive dependency of Bolt but is imported directly by Task 8's poster, which runs in the job processes without a Bolt app. Depending on it directly is what keeps that import honest.

These are the project's first runtime dependencies. Confirm they landed under `dependencies`, not `devDependencies`:

```bash
node -e "const p=require('./package.json');console.log(p.dependencies)"
```

- [ ] **Step 2: Write the failing handler tests**

Create `src/slack/handlers.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { openStore } from "../store/sqlite.js"
import { dailyApprovals } from "./approvals.js"
import { handleMessageEvent, handleReactionEvent } from "./handlers.js"

const ts = (hour: number, minute: number, seq = 1) =>
  `${Date.UTC(2026, 7, 9, hour + 4, minute) / 1000}.${String(seq).padStart(6, "0")}`

function deps() {
  const store = openStore(":memory:")
  store.upsertSeason({ seasonId: "s1", startDate: "2026-08-06", lengthDays: 21 })
  for (const [u, f, n] of [["U1", "f1", "Ada"], ["U2", "f2", "Bex"], ["U3", "f3", "Cy"]] as const) {
    store.addRosterMember({ slackUserId: u, factionId: f, displayName: n })
  }
  return { store, scope: { teamId: "T1", channelId: "C1" }, log: () => {} }
}

const photo = (user: string, at: string) => ({
  eventId: `Ev-${at}`,
  teamId: "T1",
  event: {
    type: "message" as const,
    subtype: "file_share",
    channel: "C1",
    user,
    ts: at,
    files: [{ mimetype: "image/png" }],
  },
})

const thumbsUp = (user: string, post: string, at: string) => ({
  eventId: `Ev-${user}-${at}`,
  teamId: "T1",
  event: {
    type: "reaction_added" as const,
    user,
    reaction: "+1",
    item_user: "U1",
    item: { type: "message", channel: "C1", ts: post },
    event_ts: at,
  },
})

describe("ingest handlers", () => {
  it("turns a photo and two reactions into one approved action", () => {
    const d = deps()
    const post = ts(7, 0)
    handleMessageEvent(photo("U1", post), d)
    handleReactionEvent(thumbsUp("U2", post, ts(8, 0)), d)
    handleReactionEvent(thumbsUp("U3", post, ts(9, 0)), d)

    const out = dailyApprovals(d.store, "s1", 3)
    expect(out.approvals).toHaveLength(1)
    expect(out.approvals[0]!.playerId).toBe("f1")
    expect(out.postedToday).toEqual(["f1"])
    d.store.close()
  })

  it("ignores a redelivered reaction", () => {
    // Slack retries with the same event_id when the ack is slow. Two deliveries
    // of one reaction must not become two approvers.
    const d = deps()
    const post = ts(7, 0)
    handleMessageEvent(photo("U1", post), d)
    const retry = thumbsUp("U2", post, ts(8, 0))
    expect(handleReactionEvent(retry, d)).toMatchObject({ kind: "approve" })
    expect(handleReactionEvent(retry, d)).toEqual({ kind: "duplicate" })
    expect(d.store.approversOf(post)).toHaveLength(1)
    d.store.close()
  })

  it("un-approves on reaction_removed", () => {
    const d = deps()
    const post = ts(7, 0)
    handleMessageEvent(photo("U1", post), d)
    handleReactionEvent(thumbsUp("U2", post, ts(8, 0)), d)
    handleReactionEvent(thumbsUp("U3", post, ts(9, 0)), d)
    expect(dailyApprovals(d.store, "s1", 3).approvals).toHaveLength(1)

    const removal = thumbsUp("U3", post, ts(10, 0))
    handleReactionEvent(
      { ...removal, eventId: "Ev-remove", event: { ...removal.event, type: "reaction_removed" } },
      d,
    )
    expect(dailyApprovals(d.store, "s1", 3).approvals).toEqual([])
    d.store.close()
  })

  it("retracts an action when the photo is deleted", () => {
    const d = deps()
    const post = ts(7, 0)
    handleMessageEvent(photo("U1", post), d)
    handleReactionEvent(thumbsUp("U2", post, ts(8, 0)), d)
    handleReactionEvent(thumbsUp("U3", post, ts(9, 0)), d)

    handleMessageEvent(
      {
        eventId: "Ev-del",
        teamId: "T1",
        event: {
          type: "message" as const,
          subtype: "message_deleted",
          channel: "C1",
          ts: ts(11, 0),
          deleted_ts: post,
        },
      },
      d,
    )
    expect(dailyApprovals(d.store, "s1", 3)).toEqual({ approvals: [], postedToday: [] })
    d.store.close()
  })

  it("writes nothing for a dropped event but still marks it seen", () => {
    // Marking a dropped event seen is what stops three retries of the same DM
    // from re-running the scope checks all day.
    const d = deps()
    const dm = photo("U1", ts(7, 0))
    const out = handleMessageEvent({ ...dm, event: { ...dm.event, channel: "D9" } }, d)
    expect(out).toEqual({ kind: "drop", reason: "wrong-channel" })
    expect(d.store.markEventSeen(dm.eventId, new Date())).toBe(false)
    d.store.close()
  })

  it("drops a reaction on a post it never recorded", () => {
    // A 👍 on ordinary channel chatter. Storing it would leave an orphan row
    // that no query reads and every debugging session trips over.
    const d = deps()
    expect(handleReactionEvent(thumbsUp("U2", ts(7, 0), ts(8, 0)), d)).toEqual({
      kind: "drop", reason: "unknown-post",
    })
    d.store.close()
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/slack/handlers.test.ts`
Expected: FAIL — `Cannot find module './handlers.js'`.

- [ ] **Step 4: Write `src/slack/handlers.ts`**

```ts
import type { ApprovalStore, RosterStore } from "../store/types.js"
import { interpretMessage, interpretReaction, type DropReason } from "./events.js"

export interface IngestDeps {
  store: ApprovalStore & RosterStore
  scope: { teamId: string; channelId: string }
  log: (msg: string) => void
}

export type IngestOutcome =
  | { kind: "post" | "delete" | "approve" | "unapprove" }
  | { kind: "duplicate" }
  | { kind: "drop"; reason: DropReason | "unknown-post" }

interface Envelope<E> {
  eventId: string
  teamId: string
  event: E
}

/**
 * The roster is read per event rather than cached at boot: adding a player
 * mid-season should not need a service restart, and the table has six rows.
 */
const scopeFor = (deps: IngestDeps) => ({
  teamId: deps.scope.teamId,
  channelId: deps.scope.channelId,
  roster: new Set(deps.store.roster().map((m) => m.slackUserId)),
})

/**
 * Dedupe first, and dedupe dropped events too. Slack redelivers up to three
 * times when an ack is slow, and re-running the scope checks on every retry
 * buys nothing.
 */
function seen(deps: IngestDeps, eventId: string): boolean {
  return !deps.store.markEventSeen(eventId, new Date())
}

export function handleMessageEvent(
  input: Envelope<Parameters<typeof interpretMessage>[0]["event"]>,
  deps: IngestDeps,
): IngestOutcome {
  if (seen(deps, input.eventId)) return { kind: "duplicate" }

  const decision = interpretMessage({ teamId: input.teamId, event: input.event }, scopeFor(deps))
  if (decision.kind === "drop") return decision

  if (decision.kind === "delete") {
    deps.store.deletePost(decision.messageTs)
    return { kind: "delete" }
  }

  const factionId = deps.store.factionForSlackUser(decision.slackUserId)
  if (factionId === undefined) return { kind: "drop", reason: "not-on-roster" }

  deps.store.recordPost({ messageTs: decision.messageTs, factionId })
  deps.log(`post ${decision.messageTs} by ${factionId}`)
  return { kind: "post" }
}

export function handleReactionEvent(
  input: Envelope<Parameters<typeof interpretReaction>[0]["event"]>,
  deps: IngestDeps,
): IngestOutcome {
  if (seen(deps, input.eventId)) return { kind: "duplicate" }

  const decision = interpretReaction({ teamId: input.teamId, event: input.event }, scopeFor(deps))
  if (decision.kind === "drop") return decision

  // A reaction on ordinary channel chatter. Storing it would leave a row no
  // query reads.
  const post = deps.store.postFor(decision.messageTs)
  if (post === undefined) return { kind: "drop", reason: "unknown-post" }

  const factionId = deps.store.factionForSlackUser(decision.slackUserId)
  if (factionId === undefined) return { kind: "drop", reason: "not-on-roster" }

  if (decision.kind === "unapprove") {
    deps.store.removeApproval(decision.messageTs, factionId)
    deps.log(`unapprove ${decision.messageTs} by ${factionId}`)
    return { kind: "unapprove" }
  }

  deps.store.recordApproval({
    messageTs: decision.messageTs,
    factionId,
    reactedAt: decision.reactedAt,
  })
  deps.log(`approve ${decision.messageTs} by ${factionId}`)
  return { kind: "approve" }
}
```

This needs one more store method. Add to `ApprovalStore` in `src/store/types.ts`:

```ts
  /** A post by message ts, including a deleted one. Undefined if never recorded. */
  postFor(messageTs: string): PostRow | undefined
```

and to `src/store/sqlite.ts`:

```ts
    postFor(messageTs: string): PostRow | undefined {
      const r = db
        .prepare(
          "SELECT message_ts, faction_id, posted_at, et_date FROM posts WHERE message_ts = ?",
        )
        .get(messageTs) as
        | { message_ts: string; faction_id: string; posted_at: string; et_date: string }
        | undefined
      if (r === undefined) return undefined
      return {
        messageTs: r.message_ts,
        factionId: r.faction_id,
        postedAt: r.posted_at,
        etDate: r.et_date,
      }
    },
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/slack/handlers.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Write the failing app test**

Create `src/slack/app.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { openStore } from "../store/sqlite.js"
import { createSlackApp } from "./app.js"

const env = {
  signingSecret: "s3cret",
  botToken: "xoxb-token",
  teamId: "T1",
  channelId: "C1",
}

describe("createSlackApp", () => {
  it("builds an app without touching the network", () => {
    // deferInitialization keeps the constructor from calling auth.test. If this
    // test ever hangs or fails on a network error, that option was dropped.
    const store = openStore(":memory:")
    const app = createSlackApp({ env, store, log: () => {} })
    expect(typeof app.start).toBe("function")
    store.close()
  })

  it("refuses to build without a signing secret", () => {
    // A missing secret must never degrade into an unverified handler.
    const store = openStore(":memory:")
    expect(() => createSlackApp({ env: { ...env, signingSecret: "" }, store, log: () => {} })).toThrow(
      /signing secret/i,
    )
    store.close()
  })
})
```

- [ ] **Step 7: Run to verify it fails**

Run: `npx vitest run src/slack/app.test.ts`
Expected: FAIL — `Cannot find module './app.js'`.

- [ ] **Step 8: Write `src/slack/app.ts`**

```ts
import pkg from "@slack/bolt"
import type { App as AppType } from "@slack/bolt"
import type { ApprovalStore, RosterStore } from "../store/types.js"
import type { SlackEnv } from "./env.js"
import { handleMessageEvent, handleReactionEvent, type IngestDeps } from "./handlers.js"

// @slack/bolt is CommonJS; the named export is not reachable through a bare
// ESM named import under Node's interop.
const { App } = pkg

export interface SlackAppDeps {
  env: SlackEnv
  store: ApprovalStore & RosterStore
  log: (msg: string) => void
}

/**
 * The Events webhook. Validates scope, writes rows, and does nothing else.
 *
 * Bolt verifies X-Slack-Signature and rejects a request whose
 * X-Slack-Request-Timestamp is more than five minutes old. Both are on by
 * default; `signatureVerification` must never be set to false here.
 */
export function createSlackApp(deps: SlackAppDeps): AppType {
  if (deps.env.signingSecret === "") {
    throw new Error("createSlackApp: refusing to start without a signing secret")
  }

  const app = new App({
    signingSecret: deps.env.signingSecret,
    token: deps.env.botToken,
    // The constructor would otherwise call auth.test, which makes every test
    // that builds an app a network test. The entrypoint calls init() itself.
    deferInitialization: true,
    // Handlers are synchronous SQLite writes measured in microseconds, so the
    // work is done well inside Slack's 3-second ack window either way. Doing it
    // before the response means a write that throws is visible as a 500 in the
    // Slack app's event log rather than only in ours.
    processBeforeResponse: true,
  })

  const ingest: IngestDeps = {
    store: deps.store,
    scope: { teamId: deps.env.teamId, channelId: deps.env.channelId },
    log: deps.log,
  }

  app.event("message", async ({ body, event }) => {
    handleMessageEvent(
      { eventId: body.event_id, teamId: body.team_id, event: event as never },
      ingest,
    )
  })

  for (const name of ["reaction_added", "reaction_removed"] as const) {
    app.event(name, async ({ body, event }) => {
      handleReactionEvent(
        { eventId: body.event_id, teamId: body.team_id, event: event as never },
        ingest,
      )
    })
  }

  // Never let an exception's text reach Slack. Log it locally and let Bolt
  // return its generic 500.
  app.error(async (error) => {
    deps.log(`slack handler error: ${error.stack ?? String(error)}`)
  })

  return app
}
```

The `as never` casts are load-bearing but ugly: Bolt's `SlackEventMiddlewareArgs<"message">` is a seventeen-member union, and the handlers accept the narrow structural shape from Task 3 instead. The cast is safe because `interpretMessage` and `interpretReaction` treat every field as optional and validate before reading. Do not widen the handler signatures to Bolt's types — that would put `@slack/bolt` in the import graph of every test in this plan.

- [ ] **Step 9: Run to verify it passes**

Run: `npx vitest run src/slack/app.test.ts && npm run typecheck`
Expected: PASS. If the `import pkg from "@slack/bolt"` line fails to typecheck, check `tsconfig.json`'s `esModuleInterop` — the project sets it, but confirm rather than assume.

- [ ] **Step 10: Confirm the replay window is actually enforced**

The spec requires that "requests with an `X-Slack-Request-Timestamp` older than five minutes are rejected as replays". Bolt owns this, and the plan takes it on trust — so verify the trust rather than assuming it, because a default that changed in a major version would be invisible.

```bash
grep -n "requestTimestampMaxDeltaMin" node_modules/@slack/bolt/dist/receivers/verify-request.js
```

Expected, verified against `@slack/bolt` 5.0.0:

```
28:    const requestTimestampMaxDeltaMin = 5;
29:    const fiveMinutesAgoSec = Math.floor(nowMs / 1000) - 60 * requestTimestampMaxDeltaMin;
33:        throw new Error(`${verifyErrorPrefix}: x-slack-request-timestamp must differ from system time by no more than ${requestTimestampMaxDeltaMin} minutes or request is stale`);
```

It is a hard-coded constant, not an option — which is fine, because five minutes is exactly what the spec asks for. If a future version makes it configurable or changes the value, set it explicitly rather than leaving the requirement unmet, and record it in **Spec deltas**.

- [ ] **Step 11: Commit**

```bash
git add src/slack/handlers.ts src/slack/handlers.test.ts src/slack/app.ts src/slack/app.test.ts src/store package.json package-lock.json
git commit -m "feat(slack): Bolt events app over pure ingest handlers"
```

---

### Task 7: The recap renderer

The daily artifact everyone actually sees. Pure: `GameState` in, Block Kit out. No store, no clock, no Slack client.

**Files:**
- Create: `src/slack/text.ts`
- Create: `src/slack/text.test.ts`
- Create: `src/slack/recap.ts`
- Create: `src/slack/recap.test.ts`

**Interfaces:**
- Consumes: `GameState`, `TickEvent`, `Faction` from `src/engine/index.js`; `QUESTION_MAX_CHARS` from `src/config.js`; `MAX_RECAP_BLOCKS`, `RECAP_NAME_MAX_CHARS` from `src/slack/config.js`
- Produces: `safeText(value, max): string`; `renderRecap(input): { text: string; blocks: unknown[] }`; `RecapInput { state, previous, lengthDays, correction? }`

- [ ] **Step 1: Write the failing text tests**

Create `src/slack/text.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { safeText } from "./text.js"

describe("safeText", () => {
  it("passes ordinary text through", () => {
    expect(safeText("Ada L.", 40)).toBe("Ada L.")
  })

  it("caps at the limit with an ellipsis", () => {
    expect(safeText("x".repeat(50), 10)).toBe("xxxxxxxxx…")
    expect(safeText("x".repeat(50), 10)).toHaveLength(10)
  })

  it("neutralizes a channel ping", () => {
    // Block Kit plain_text does not parse this, but the fallback `text` field
    // and every future mrkdwn sink do. Defanging once here is cheaper than
    // proving every sink is safe.
    expect(safeText("<!channel> do my workout", 200)).toBe("‹!channel› do my workout")
  })

  it("strips control characters", () => {
    expect(safeText("a\u0000b\u001fc", 40)).toBe("abc")
  })

  it("collapses newlines to spaces", () => {
    // A 40-line title wrecks the recap layout even when correctly escaped.
    expect(safeText("a\nb\r\nc", 40)).toBe("a b c")
  })

  it("returns a placeholder for empty or whitespace-only input", () => {
    // Block Kit rejects a plain_text element with an empty string, which would
    // fail the whole recap post over one blank display name.
    expect(safeText("", 40)).toBe("—")
    expect(safeText("   ", 40)).toBe("—")
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/slack/text.test.ts`
Expected: FAIL — `Cannot find module './text.js'`.

- [ ] **Step 3: Write `src/slack/text.ts`**

```ts
/**
 * Make third-party or player-supplied text safe for a Slack payload and short
 * enough for the layout.
 *
 * Market questions come from Kalshi and display names from players. Block Kit
 * `plain_text` does not parse mrkdwn, so this is belt and braces — but the
 * message's fallback `text` field is not plain_text, and that is where an
 * unescaped <!channel> would ping the workspace every single day.
 */
export function safeText(value: string, max: number): string {
  const cleaned = value
    // Line breaks and tabs collapse to a single space FIRST. The control-char
    // strip below would otherwise delete them outright and run two lines
    // together with no gap: "squat\n3x5" would render as "squat3x5".
    .replace(/[\t\r\n]+/g, " ")
    // Every remaining C0 and C1 control character. Written as \u escapes on
    // purpose: a literal control character in source is invisible in review and
    // survives every subsequent reading of the file.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .replace(/</g, "‹")
    .replace(/>/g, "›")
    .replace(/ {2,}/g, " ")
    .trim()

  if (cleaned === "") return "—"
  if (cleaned.length <= max) return cleaned
  return `${cleaned.slice(0, max - 1)}…`
}
```

The `‹`/`›` substitution rather than `&lt;`/`&gt;` is deliberate: Slack renders `plain_text` literally, so an HTML entity would show up as the characters `&lt;` in the recap. The look-alikes read correctly and cannot open a Slack control sequence.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/slack/text.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Write the failing recap tests**

Create `src/slack/recap.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import type { Faction, GameState, TickEvent } from "../engine/index.js"
import { createSeason, RISK_MAP } from "../engine/index.js"
import { renderRecap } from "./recap.js"

const factions: Faction[] = [
  { id: "f1", playerName: "Ada", color: "#f00" },
  { id: "f2", playerName: "Bex", color: "#0f0" },
]

function stateWith(log: TickEvent[], day = 3): GameState {
  const base = createSeason("s1", factions, RISK_MAP.territories.map((t) => t.id))
  return { ...base, day, log }
}

/** Every plain_text string anywhere in the payload. */
function texts(blocks: unknown[]): string[] {
  const out: string[] = []
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return void node.forEach(walk)
    if (node === null || typeof node !== "object") return
    const o = node as Record<string, unknown>
    if (o.type === "plain_text" && typeof o.text === "string") out.push(o.text)
    Object.values(o).forEach(walk)
  }
  walk(blocks)
  return out
}

describe("renderRecap", () => {
  const previous = stateWith([], 2)

  it("names the day in the header", () => {
    const { blocks } = renderRecap({ state: stateWith([]), previous, lengthDays: 21 })
    expect(texts(blocks).join(" ")).toContain("Day 3")
  })

  it("uses only plain_text, never mrkdwn", () => {
    // A question containing <!channel> would ping the workspace daily.
    const { blocks } = renderRecap({
      state: stateWith([{ t: "income", faction: "f1", amount: 6 }]),
      previous,
      lengthDays: 21,
    })
    expect(JSON.stringify(blocks)).not.toContain("mrkdwn")
  })

  it("reports a capture with both players named", () => {
    const { blocks } = renderRecap({
      state: stateWith([
        { t: "attack", from: "alaska", to: "kamchatka", attacker: "f1", committed: 6, survivors: 2, captured: true },
      ]),
      previous,
      lengthDays: 21,
    })
    const all = texts(blocks).join("\n")
    expect(all).toContain("Ada")
    expect(all).toContain("Kamchatka")
  })

  it("surfaces every rejection", () => {
    // Silent validation is how a validator bug survives a whole season.
    const { blocks } = renderRecap({
      state: stateWith([
        { t: "rejected", faction: "f2", field: "deploys", reason: "exceeds reserve" },
      ]),
      previous,
      lengthDays: 21,
    })
    const all = texts(blocks).join("\n")
    expect(all).toContain("Bex")
    expect(all).toContain("exceeds reserve")
  })

  it("reveals protections", () => {
    const { blocks } = renderRecap({
      state: stateWith([{ t: "protected", territory: "brazil", byCount: 1 }]),
      previous,
      lengthDays: 21,
    })
    expect(texts(blocks).join("\n")).toContain("Brazil")
  })

  it("reports wager settlements", () => {
    const { blocks } = renderRecap({
      state: stateWith([{ t: "wagerSettle", wagerId: "w1", outcome: "yes", payout: 22 }]),
      previous,
      lengthDays: 21,
    })
    expect(texts(blocks).join("\n")).toContain("22")
  })

  it("caps and defangs a player name", () => {
    const hostile: Faction[] = [{ id: "f1", playerName: "<!channel>".repeat(20), color: "#f00" }]
    const state = { ...stateWith([{ t: "income", faction: "f1", amount: 5 }]), factions: hostile }
    const { blocks, text } = renderRecap({ state, previous, lengthDays: 21 })
    expect(JSON.stringify(blocks)).not.toContain("<!channel>")
    expect(text).not.toContain("<!channel>")
  })

  it("declares the winner on the final day", () => {
    const state = stateWith([], 21)
    const { blocks } = renderRecap({ state, previous: stateWith([], 20), lengthDays: 21 })
    expect(texts(blocks).join("\n")).toMatch(/wins|draw/i)
  })

  it("says nothing happened rather than rendering an empty message", () => {
    // Slack rejects a post with zero blocks.
    const { blocks } = renderRecap({ state: stateWith([]), previous, lengthDays: 21 })
    expect(blocks.length).toBeGreaterThan(0)
  })

  it("stays under Slack's block limit on a busy day", () => {
    const busy: TickEvent[] = Array.from({ length: 300 }, (_, i) => ({
      t: "attack" as const,
      from: "alaska",
      to: "kamchatka",
      attacker: i % 2 === 0 ? "f1" : "f2",
      committed: 3,
      survivors: 1,
      captured: false,
    }))
    const { blocks } = renderRecap({ state: stateWith(busy), previous, lengthDays: 21 })
    expect(blocks.length).toBeLessThanOrEqual(48)
  })

  it("marks a correction", () => {
    // A rerun posts a visible correction note rather than a silent second recap.
    const { blocks } = renderRecap({
      state: stateWith([]),
      previous,
      lengthDays: 21,
      correction: true,
    })
    expect(texts(blocks).join("\n")).toMatch(/correction/i)
  })
})
```

- [ ] **Step 6: Run to verify it fails**

Run: `npx vitest run src/slack/recap.test.ts`
Expected: FAIL — `Cannot find module './recap.js'`.

- [ ] **Step 7: Write `src/slack/recap.ts`**

```ts
import { territoriesOf, type FactionId, type GameState, type TickEvent } from "../engine/index.js"
import { MAX_RECAP_BLOCKS, RECAP_NAME_MAX_CHARS } from "./config.js"
import { safeText } from "./text.js"

export interface RecapInput {
  /** The post-tick state, day N. */
  state: GameState
  /** Day N-1, for standings movement. */
  previous: GameState
  lengthDays: number
  /** A rerun. Marked visibly rather than posted as a silent second recap. */
  correction?: boolean
}

/**
 * Minimal Block Kit shapes. Typed structurally rather than imported from
 * @slack/types so this file — and its tests — stay off the Bolt import graph.
 */
type Block =
  | { type: "header"; text: { type: "plain_text"; text: string; emoji: true } }
  | { type: "divider" }
  | { type: "section"; text: { type: "plain_text"; text: string; emoji: true } }
  | { type: "context"; elements: { type: "plain_text"; text: string; emoji: true }[] }

const plain = (text: string) => ({ type: "plain_text" as const, text, emoji: true as const })
const header = (text: string): Block => ({ type: "header", text: plain(text) })
const section = (text: string): Block => ({ type: "section", text: plain(text) })
const context = (lines: string[]): Block => ({ type: "context", elements: lines.map(plain) })

/** "eastern_united_states" -> "Eastern United States". */
function titleCase(id: string): string {
  return id
    .split("_")
    .map((w) => (w.length === 0 ? w : w[0]!.toUpperCase() + w.slice(1)))
    .join(" ")
}

export function renderRecap(input: RecapInput): { text: string; blocks: Block[] } {
  const { state, previous, lengthDays } = input

  const nameOf = (id: FactionId): string => {
    const f = state.factions.find((x) => x.id === id)
    return safeText(f?.playerName ?? id, RECAP_NAME_MAX_CHARS)
  }
  const place = (id: string) => safeText(titleCase(id), RECAP_NAME_MAX_CHARS)

  const blocks: Block[] = [header(`Day ${state.day} of ${lengthDays}`)]
  if (input.correction === true) {
    blocks.push(context(["Correction — this tick was re-run. It replaces the earlier recap."]))
  }

  const of = <T extends TickEvent["t"]>(t: T) =>
    state.log.filter((e): e is Extract<TickEvent, { t: T }> => e.t === t)

  // Reinforcements: income and IRL, one line per faction.
  const income = of("income")
  const irl = of("irl")
  if (income.length > 0 || irl.length > 0) {
    const byFaction = new Map<FactionId, string[]>()
    for (const e of income) {
      byFaction.set(e.faction, [...(byFaction.get(e.faction) ?? []), `+${e.amount} income`])
    }
    for (const e of irl) {
      const bonus = e.bonus > 0 ? ` +${e.bonus} timing` : ""
      byFaction.set(e.faction, [
        ...(byFaction.get(e.faction) ?? []),
        `+${e.actions} workout${e.actions === 1 ? "" : "s"}${bonus}`,
      ])
    }
    const lines = [...byFaction.keys()]
      .sort()
      .map((f) => `${nameOf(f)}: ${byFaction.get(f)!.join(", ")}`)
    blocks.push(section(`Reinforcements\n${lines.join("\n")}`))
  }

  const protections = of("protected")
  if (protections.length > 0) {
    // Picks are secret until now. This is the reveal.
    blocks.push(
      section(
        `Protected\n${protections
          .map((e) => `${place(e.territory)} — held by ${e.byCount} veto${e.byCount === 1 ? "" : "es"}`)
          .join("\n")}`,
      ),
    )
  }

  const field = of("fieldBattle")
  if (field.length > 0) {
    blocks.push(
      section(
        `Field battles\n${field
          .map(
            (e) =>
              `${place(e.a)} ↔ ${place(e.b)} — ${e.aContinues} and ${e.bContinues} continued on`,
          )
          .join("\n")}`,
      ),
    )
  }

  const attacks = of("attack")
  if (attacks.length > 0) {
    const lines = attacks.map((e) =>
      e.captured
        ? `${nameOf(e.attacker)} took ${place(e.to)} from ${place(e.from)} — ${e.committed} sent, ${e.survivors} held it`
        : `${nameOf(e.attacker)} failed against ${place(e.to)} — ${e.committed} sent, ${e.survivors} came back`,
    )
    blocks.push(section(`Battles\n${lines.join("\n")}`))
  }

  const settles = of("wagerSettle")
  if (settles.length > 0) {
    blocks.push(
      section(
        `Markets\n${settles
          .map((e) =>
            e.payout > 0
              ? `${e.wagerId} resolved ${e.outcome} — paid ${e.payout}`
              : `${e.wagerId} resolved ${e.outcome} — lost`,
          )
          .join("\n")}`,
      ),
    )
  }

  // Always surfaced. Silent validation is how a validator bug survives a season.
  const rejections = of("rejected")
  if (rejections.length > 0) {
    blocks.push(
      section(
        `Rejected orders\n${rejections
          .map((e) => `${nameOf(e.faction)} — ${safeText(e.field, 40)}: ${safeText(e.reason, 80)}`)
          .join("\n")}`,
      ),
    )
  }

  // Standings, with movement against yesterday.
  blocks.push({ type: "divider" })
  const standings = [...state.factions]
    .map((f) => ({
      id: f.id,
      name: nameOf(f.id),
      count: territoriesOf(state, f.id).length,
      was: territoriesOf(previous, f.id).length,
      reserve: state.reserves[f.id] ?? 0,
    }))
    .sort((a, b) => b.count - a.count || b.reserve - a.reserve || (a.id < b.id ? -1 : 1))

  blocks.push(
    section(
      `Standings\n${standings
        .map((s) => {
          const delta = s.count - s.was
          const move = delta === 0 ? "" : delta > 0 ? ` (+${delta})` : ` (${delta})`
          const dead = s.count === 0 ? " — eliminated" : ""
          return `${s.name}: ${s.count} territories${move}, ${s.reserve} in reserve${dead}`
        })
        .join("\n")}`,
    ),
  )

  if (state.day >= lengthDays) {
    const top = standings[0]!
    const tied = standings.filter((s) => s.count === top.count && s.reserve === top.reserve)
    blocks.push(
      section(
        tied.length > 1
          ? `The season is a draw between ${tied.map((s) => s.name).join(" and ")}.`
          : `${top.name} wins the season with ${top.count} territories.`,
      ),
    )
  }

  if (blocks.length === 1) blocks.push(section("A quiet day. No orders resolved."))

  // Slack rejects more than 50 blocks. A truncated recap beats no recap.
  const capped =
    blocks.length > MAX_RECAP_BLOCKS
      ? [...blocks.slice(0, MAX_RECAP_BLOCKS - 1), context(["Recap truncated — see the web app."])]
      : blocks

  return { text: `Riskety Rekt — day ${state.day} of ${lengthDays}`, blocks: capped }
}
```

- [ ] **Step 8: Run to verify it passes**

Run: `npx vitest run src/slack/recap.test.ts`
Expected: PASS, 11 tests. The block-limit test is the likeliest to fail: 300 attacks render as one `section` whose text exceeds Slack's 3,000-character limit long before the block count matters. If it does, cap the *lines* inside each section at 20 and append `…and N more` — and add a test asserting no single section's text exceeds 2,900 characters.

- [ ] **Step 9: Commit**

```bash
git add src/slack/text.ts src/slack/text.test.ts src/slack/recap.ts src/slack/recap.test.ts
git commit -m "feat(slack): pure Block Kit recap renderer"
```

---

### Task 8: Posting — the slate announcement and the recap

The only code in this plan that speaks to the Slack Web API, plus the wiring that makes the 08:00 job announce its slate.

**Files:**
- Create: `src/slack/announce.ts`
- Create: `src/slack/announce.test.ts`
- Create: `src/slack/post.ts`
- Create: `src/slack/post.test.ts`
- Create: `src/jobs/post-recap.ts`
- Create: `src/jobs/post-recap.test.ts`
- Modify: `src/jobs/publish-slate.ts` — add the optional `announce` dependency
- Modify: `src/jobs/publish-slate.test.ts`

**Interfaces:**
- Consumes: `renderRecap` from `src/slack/recap.js`; `Market` from `src/engine/index.js`
- Produces: `renderSlate(day, slate): { text, blocks }`; `Poster { post(message): Promise<void> }`; `createPoster(env): Poster`; `runPostRecap(deps): Promise<void>`

- [ ] **Step 1: Write the failing slate-announcement tests**

Create `src/slack/announce.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import type { Market } from "../engine/index.js"
import { renderSlate } from "./announce.js"

const market = (over: Partial<Market> = {}): Market => ({
  id: "KX-1",
  question: "Will it rain in Richmond today?",
  priceYes: 0.42,
  priceNo: 0.6,
  closeTime: "2026-08-09T20:00:00.000Z",
  ...over,
})

describe("renderSlate", () => {
  it("lists each market with both prices", () => {
    const { blocks } = renderSlate(3, [market()])
    const json = JSON.stringify(blocks)
    expect(json).toContain("Will it rain in Richmond today?")
    expect(json).toContain("42")
    expect(json).toContain("60")
  })

  it("uses only plain_text", () => {
    expect(JSON.stringify(renderSlate(3, [market()]).blocks)).not.toContain("mrkdwn")
  })

  it("defangs and caps a hostile question", () => {
    // Kalshi questions are third-party text. A 5,000-character title wrecks the
    // layout even when correctly escaped.
    const hostile = market({ question: `<!channel> ${"x".repeat(5000)}` })
    const json = JSON.stringify(renderSlate(3, [hostile]).blocks)
    expect(json).not.toContain("<!channel>")
    expect(json).not.toContain("x".repeat(300))
  })

  it("says so when the slate is empty", () => {
    // No market slate means the day runs as plain Risk. Post a note, carry on.
    const { blocks } = renderSlate(3, [])
    expect(JSON.stringify(blocks)).toMatch(/plain Risk|no markets/i)
    expect(blocks.length).toBeGreaterThan(0)
  })

  it("shows each market's own close time", () => {
    // Wagers lock per-market at that market's close, not at 21:00. Players
    // cannot plan around a window they cannot see.
    const { blocks } = renderSlate(3, [market()])
    expect(JSON.stringify(blocks)).toMatch(/4:00|16:00/)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/slack/announce.test.ts`
Expected: FAIL — `Cannot find module './announce.js'`.

- [ ] **Step 3: Write `src/slack/announce.ts`**

```ts
import { QUESTION_MAX_CHARS, TIMEZONE } from "../config.js"
import type { Market } from "../engine/index.js"
import { safeText } from "./text.js"

type Block =
  | { type: "header"; text: { type: "plain_text"; text: string; emoji: true } }
  | { type: "section"; text: { type: "plain_text"; text: string; emoji: true } }
  | { type: "context"; elements: { type: "plain_text"; text: string; emoji: true }[] }

const plain = (text: string) => ({ type: "plain_text" as const, text, emoji: true as const })

const CLOSE_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: TIMEZONE,
  hour: "numeric",
  minute: "2-digit",
})

/** The 08:00 slate post. Prices are shown as whole cents, the way Kalshi quotes them. */
export function renderSlate(day: number, slate: Market[]): { text: string; blocks: Block[] } {
  const blocks: Block[] = [
    { type: "header", text: plain(`Day ${day} — today's markets`) },
  ]

  if (slate.length === 0) {
    blocks.push({
      type: "section",
      text: plain("No markets cleared the filters today. The day runs as plain Risk."),
    })
    return { text: `Day ${day} — no markets today`, blocks }
  }

  for (const m of slate) {
    const closes = CLOSE_FMT.format(new Date(m.closeTime))
    blocks.push({
      type: "section",
      text: plain(
        `${safeText(m.question, QUESTION_MAX_CHARS)}\n` +
          `YES ${Math.round(m.priceYes * 100)}¢ · NO ${Math.round(m.priceNo * 100)}¢ · ` +
          `wagers lock ${closes}`,
      ),
    })
  }

  blocks.push({
    type: "context",
    elements: [
      plain("One wager per market. Wagers lock at each market's own close, not at 21:00."),
    ],
  })

  return { text: `Day ${day} — ${slate.length} markets`, blocks }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/slack/announce.test.ts`
Expected: PASS, 5 tests. If the close-time test fails, print what `CLOSE_FMT.format` actually returns for that instant and assert on that — the point is that a time appears, not which formatting Intl chose.

- [ ] **Step 5: Write the failing poster tests**

Create `src/slack/post.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest"
import { createPoster } from "./post.js"

const env = { signingSecret: "s", botToken: "xoxb-t", teamId: "T1", channelId: "C1" }

describe("createPoster", () => {
  it("posts to the configured channel with a fallback text", async () => {
    const chat = { postMessage: vi.fn().mockResolvedValue({ ok: true }) }
    const poster = createPoster(env, { chat } as never)
    await poster.post({ text: "fallback", blocks: [{ type: "divider" }] })

    expect(chat.postMessage).toHaveBeenCalledWith({
      channel: "C1",
      text: "fallback",
      blocks: [{ type: "divider" }],
      unfurl_links: false,
      unfurl_media: false,
    })
  })

  it("propagates a Slack failure rather than swallowing it", async () => {
    // A recap that failed to post must exit non-zero so the timer's failure is
    // visible. Silence here is how a season's recaps quietly stop.
    const chat = { postMessage: vi.fn().mockRejectedValue(new Error("channel_not_found")) }
    const poster = createPoster(env, { chat } as never)
    await expect(poster.post({ text: "x", blocks: [] })).rejects.toThrow("channel_not_found")
  })
})
```

- [ ] **Step 6: Run to verify it fails**

Run: `npx vitest run src/slack/post.test.ts`
Expected: FAIL — `Cannot find module './post.js'`.

- [ ] **Step 7: Write `src/slack/post.ts`**

```ts
import { WebClient } from "@slack/web-api"
import type { SlackEnv } from "./env.js"

export interface SlackMessage {
  text: string
  blocks: unknown[]
}

export interface Poster {
  post(message: SlackMessage): Promise<void>
}

/** The narrow slice of WebClient this file uses, so tests can fake it. */
interface ChatClient {
  chat: { postMessage(args: Record<string, unknown>): Promise<unknown> }
}

/**
 * The only code that speaks to the Slack Web API.
 *
 * `unfurl_links: false` matters more than it looks: a recap naming a market
 * would otherwise expand a Kalshi preview under every post, and the preview is
 * fetched live — which is to say, it can show an outcome the recap deliberately
 * has not stated yet.
 */
export function createPoster(env: SlackEnv, client?: ChatClient): Poster {
  const web: ChatClient = client ?? (new WebClient(env.botToken) as unknown as ChatClient)
  return {
    async post(message: SlackMessage): Promise<void> {
      await web.chat.postMessage({
        channel: env.channelId,
        text: message.text,
        blocks: message.blocks,
        unfurl_links: false,
        unfurl_media: false,
      })
    },
  }
}
```

- [ ] **Step 8: Run to verify it passes**

Run: `npx vitest run src/slack/post.test.ts`
Expected: PASS, 2 tests. Neither makes a network call — `WebClient` is only constructed when no client is injected.

- [ ] **Step 9: Wire the announcement into the 08:00 job**

Add an optional dependency to `PublishDeps` in `src/jobs/publish-slate.ts`:

```ts
export interface PublishDeps {
  store: SlateStore
  adapter: MarketAdapter
  seasonId: string
  now: Date
  log?: (msg: string) => void
  /**
   * Optional so the job's existing tests stay offline and unchanged. Called
   * only after the slate is persisted: a Slack outage must never cost the day
   * its slate, and a slate announced but not stored would be a lie.
   */
  announce?: (day: number, slate: Market[]) => Promise<void>
}
```

At the end of the function, after the successful `publishSlate` call and before returning `{ status: "published", ... }`:

```ts
  if (deps.announce !== undefined) {
    try {
      await deps.announce(day, slate)
    } catch (err) {
      // The slate is already persisted and the game is playable. A failed
      // announcement is worth a loud log and a non-zero exit, but not a retry
      // that would try to re-publish an already-published slate.
      log(`slate published but the Slack announcement failed: ${String(err)}`)
    }
  }
```

Add two tests to `src/jobs/publish-slate.test.ts`, reusing that file's existing `fresh()`, `stubAdapter()`, `cand()` helpers and its `AT_0800_DAY3` constant:

```ts
  it("announces the slate it persisted", async () => {
    const store = fresh()
    const announced: { day: number; ids: string[] }[] = []
    await runPublishSlate({
      store,
      adapter: stubAdapter([cand("A-1", 900), cand("B-1", 800)]),
      seasonId: "s1",
      now: AT_0800_DAY3,
      announce: async (day, slate) => {
        announced.push({ day, ids: slate.map((m) => m.id) })
      },
    })
    expect(announced).toEqual([{ day: 3, ids: ["A-1", "B-1"] }])
    store.close()
  })

  it("keeps the published slate when the announcement fails", async () => {
    // Slack being down must not cost the day its slate -- the game is playable
    // without the announcement, and a retry would hit already-published.
    const store = fresh()
    const out = await runPublishSlate({
      store,
      adapter: stubAdapter([cand("A-1", 900)]),
      seasonId: "s1",
      now: AT_0800_DAY3,
      announce: async () => {
        throw new Error("slack is down")
      },
    })
    expect(out.status).toBe("published")
    expect(store.slatePublished("s1", 3)).toBe(true)
    store.close()
  })
```

The first test's expected market ids depend on how many candidates clear `SLATE_MIN`; read the neighbouring tests to see what `cand("A-1", 900)` actually yields before asserting on the ids.

- [ ] **Step 10: Write the recap job**

Create `src/jobs/post-recap.ts`:

```ts
import type { GameState } from "../engine/index.js"
import { renderRecap } from "../slack/recap.js"
import type { Poster } from "../slack/post.js"

export interface PostRecapDeps {
  poster: Poster
  state: GameState
  previous: GameState
  lengthDays: number
  correction?: boolean
  log?: (msg: string) => void
}

/**
 * Post the day's recap.
 *
 * Deliberately separate from resolution, and never called by `resolve()`. Plan
 * 4's tick runner saves state first and calls this afterwards, so a Slack
 * outage cannot stall or double-run a tick. A rerun passes `correction: true`
 * rather than posting a silent second recap.
 */
export async function runPostRecap(deps: PostRecapDeps): Promise<void> {
  const log = deps.log ?? (() => {})
  const message = renderRecap({
    state: deps.state,
    previous: deps.previous,
    lengthDays: deps.lengthDays,
    correction: deps.correction,
  })
  await deps.poster.post(message)
  log(`recap posted for day ${deps.state.day}`)
}
```

Create `src/jobs/post-recap.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest"
import { createSeason, RISK_MAP, type Faction } from "../engine/index.js"
import { runPostRecap } from "./post-recap.js"

const factions: Faction[] = [{ id: "f1", playerName: "Ada", color: "#f00" }]
const state = (day: number) => ({
  ...createSeason("s1", factions, RISK_MAP.territories.map((t) => t.id)),
  day,
  log: [],
})

describe("runPostRecap", () => {
  it("posts the rendered recap", async () => {
    const post = vi.fn().mockResolvedValue(undefined)
    await runPostRecap({ poster: { post }, state: state(3), previous: state(2), lengthDays: 21 })
    expect(post).toHaveBeenCalledOnce()
    expect(post.mock.calls[0]![0].text).toContain("day 3")
  })

  it("marks a correction", async () => {
    const post = vi.fn().mockResolvedValue(undefined)
    await runPostRecap({
      poster: { post },
      state: state(3),
      previous: state(2),
      lengthDays: 21,
      correction: true,
    })
    expect(JSON.stringify(post.mock.calls[0]![0].blocks)).toMatch(/Correction/i)
  })

  it("propagates a posting failure", async () => {
    const post = vi.fn().mockRejectedValue(new Error("ratelimited"))
    await expect(
      runPostRecap({ poster: { post }, state: state(3), previous: state(2), lengthDays: 21 }),
    ).rejects.toThrow("ratelimited")
  })
})
```

- [ ] **Step 11: Run the whole suite**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add src/slack/announce.ts src/slack/announce.test.ts src/slack/post.ts src/slack/post.test.ts src/jobs
git commit -m "feat(slack): slate announcement, recap posting, and the 08:00 wiring"
```

---

### Task 9: Entrypoints, deployment, and documentation

The bot becomes a running service, and the docs stop lying about what exists.

**Files:**
- Create: `src/slack/cli.ts`
- Create: `deploy/riskety-slack.service`
- Modify: `src/jobs/cli.ts` — announce the slate, add `post-recap` guidance
- Modify: `package.json`
- Modify: `deploy/README.md`
- Modify: `README.md`
- Modify: `HANDOFF.md`

**Interfaces:**
- Consumes: `createSlackApp`, `loadSlackEnv`, `openStore`, `createPoster`, `renderSlate`

- [ ] **Step 1: Write the bot entrypoint**

Create `src/slack/cli.ts`:

```ts
/**
 * The long-running Slack Events bot.
 *
 *   tsx src/slack/cli.ts
 *
 * Configuration comes from the environment:
 *   RR_DB_PATH             path to the SQLite file      (required)
 *   SLACK_SIGNING_SECRET   Events request verification  (required)
 *   SLACK_BOT_TOKEN        xoxb- token                  (required)
 *   SLACK_TEAM_ID          workspace id                 (required)
 *   SLACK_CHANNEL_ID       the game channel             (required)
 *   PORT                   listen port, default 3001
 *
 * Any missing variable kills the process at boot. A missing signing secret must
 * never degrade into an unverified handler.
 */
import { createSlackApp } from "./app.js"
import { loadSlackEnv } from "./env.js"
import { openStore } from "../store/sqlite.js"

const dbPath = process.env.RR_DB_PATH
if (dbPath === undefined || dbPath === "") {
  console.error("RR_DB_PATH is not set — refusing to start.")
  process.exit(1)
}

const env = loadSlackEnv()
const store = openStore(dbPath)
const app = createSlackApp({ env, store, log: (msg) => console.log(msg) })

const port = Number(process.env.PORT ?? 3001)

// deferInitialization is set in createSlackApp, so init() is ours to call.
await app.init()
await app.start(port)
console.log(`slack bot listening on ${port}, channel ${env.channelId}`)

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void app.stop().finally(() => {
      store.close()
      process.exit(0)
    })
  })
}
```

- [ ] **Step 2: Verify it fails loudly with no environment**

```bash
RR_DB_PATH=/tmp/rr-plan3.db npx tsx src/slack/cli.ts
```

Expected: exits non-zero with `SLACK_SIGNING_SECRET is not set — refusing to start.` and no listening socket. This is the security-critical behaviour of the whole plan; confirm it by eye, not by assumption.

Then confirm the empty-string case, which is what a systemd `EnvironmentFile` actually produces for a blank line:

```bash
RR_DB_PATH=/tmp/rr-plan3.db SLACK_SIGNING_SECRET= SLACK_BOT_TOKEN=x SLACK_TEAM_ID=T SLACK_CHANNEL_ID=C \
  npx tsx src/slack/cli.ts
```

Expected: the same refusal. Then `rm -f /tmp/rr-plan3.db*`.

- [ ] **Step 3: Wire the announcement into the jobs CLI**

In `src/jobs/cli.ts`, in the `publish-slate` branch, pass an `announce` callback. Import at the top:

```ts
import { renderSlate } from "../slack/announce.js"
import { createPoster } from "../slack/post.js"
import { loadSlackEnv } from "../slack/env.js"
```

and in the branch:

```ts
  } else if (command === "publish-slate") {
    // Optional: a workspace that is not configured yet should still be able to
    // publish a slate to the database and the web app.
    const announce =
      process.env.SLACK_BOT_TOKEN === undefined
        ? undefined
        : async (day: number, slate: Market[]) => {
            const poster = createPoster(loadSlackEnv())
            await poster.post(renderSlate(day, slate))
          }

    const out = await runPublishSlate({
      store,
      adapter: createKalshiAdapter({ onTruncate }),
      seasonId: required("RR_SEASON_ID"),
      now: new Date(),
      log,
      announce,
    })
```

Add `import type { Market } from "../engine/index.js"` if it is not already imported.

- [ ] **Step 4: Add the npm scripts**

```json
    "slack": "tsx src/slack/cli.ts",
```

- [ ] **Step 5: Write the systemd unit**

Create `deploy/riskety-slack.service`, matching the style of the existing units in that directory:

```ini
[Unit]
Description=Riskety Rekt — Slack events bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=riskety
WorkingDirectory=/opt/riskety-rekt
# Mode 0600, outside the repo tree. Holds SLACK_SIGNING_SECRET and
# SLACK_BOT_TOKEN, and must not contain any NEXT_PUBLIC_ variable — Next.js
# inlines those into the browser bundle, and the process asserts that at boot.
EnvironmentFile=/etc/riskety/env
Environment=PORT=3001
ExecStart=/usr/bin/npx tsx src/slack/cli.ts

# Unlike the timers, this one restarts: a dropped webhook is silently missed
# approvals, and Slack does not backfill beyond its three retries.
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 6: Document deployment**

Add a section to `deploy/README.md`:

````markdown
## The Slack bot

A long-running service, not a timer. Slack retries a failed event delivery three
times over about half an hour and then gives up, so downtime is silently missed
approvals.

### Slack app configuration

Create the app at api.slack.com/apps with these bot scopes:

| Scope | Why |
|---|---|
| `channels:history` | read `message` events in the public game channel |
| `reactions:read` | read `reaction_added` / `reaction_removed` |
| `chat:write` | post the slate and the recap |

Subscribe to these bot events: `message.channels`, `reaction_added`,
`reaction_removed`. Point the Request URL at
`https://<host>/slack/events` — Bolt's default path.

Invite the bot to the channel. Slack sends `message.channels` only for channels
the app is a member of, and there is no error if it is not — approvals simply
never arrive.

### Environment

Added to `/etc/riskety/env` (mode 0600):

```
SLACK_SIGNING_SECRET=...
SLACK_BOT_TOKEN=xoxb-...
SLACK_TEAM_ID=T01ABCDEF
SLACK_CHANNEL_ID=C01ABCDEF
```

The service refuses to start if any is missing **or empty** — a blank line in an
EnvironmentFile yields `""`, and treating that as present is how a bot boots
with signature verification effectively disabled.

No variable in this file may begin with `NEXT_PUBLIC_`. Next.js inlines those
into the browser bundle; `loadSlackEnv` asserts it at boot.

### Seed the roster

Slack user ids are opaque. Read one from a player's profile → "Copy member ID".

```bash
export RR_DB_PATH=/var/lib/riskety/riskety.db RR_SEASON_ID=season-1
npm run roster:add -- U01ABCDEF f1 "Ada L."
npm run roster:list
```

A faction may map to exactly one Slack user. The second attempt fails on the
unique constraint — which is the point: a player with two mapped accounts could
approve their own post, since the self-approval check keys on faction id.

### Install

```bash
sudo cp deploy/riskety-slack.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now riskety-slack
journalctl -u riskety-slack -f
```

Caddy needs to route `/slack/events` to port 3001.

### Operating notes

- **Verify the round trip before the season starts.** Post a photo in the
  channel, react twice from two other accounts, then check the database:

  ```bash
  sqlite3 /var/lib/riskety/riskety.db \
    "SELECT p.faction_id, p.et_date, COUNT(r.faction_id) FROM posts p
       LEFT JOIN reactions r ON r.message_ts = p.message_ts
      WHERE p.deleted = 0 GROUP BY p.message_ts;"
  ```

  Two reactions from distinct factions on a live post is an approved action.

- **A retried event is not an error.** Slack redelivers when an ack is slow; the
  `slack_events` table absorbs it.

- **Approvals are read by Slack timestamp, never by write time.** A reaction at
  20:59:59 delivered at 21:00:01 still counts for that day. Do not "fix" a
  seemingly late row.
````

- [ ] **Step 7: Update `README.md`**

Add the new commands to the existing command block:

```bash
# slack — see deploy/README.md
npm run roster:add -- U01ABCDEF f1 "Ada L."
npm run roster:list
npm run slack                       # the events bot, a long-running service
```

and add `src/slack/` to the architecture list:

```
src/slack/     Bolt ingress, approval derivation, and Block Kit rendering
```

- [ ] **Step 8: Update `HANDOFF.md`**

Three edits, all factual:

1. The **Current state** section: Plan 3 is done; the tick runner and web UI remain. Update the test count from `npm test`'s real output — do not guess it.
2. The **What's next** section: mark Plan 3 done with a one-line summary, and note that Plan 4's tick runner must call `dailyApprovals(store, seasonId, day)` for both `approvals` and `postedToday`, and `runPostRecap` after saving state.
3. The **Rules a newcomer will get wrong** section: add the post gate.

```markdown
**The elimination veto needs a *post*, not an approval.** `DailyContext` carries
`postedToday` alongside `approvals` because the two mechanics gate differently:
the +1 soldier needs two distinct other players to react, the veto needs only
that the player showed up. Gating the veto on approval would give living
factions a concrete reason to withhold the 👍 from someone whose veto they fear.
Both halves of the condition live in `combat.ts` on purpose — the golden file
only pins what crosses the engine boundary.
```

Also add to **Gotchas**:

```markdown
- **The project has runtime dependencies now.** `@slack/bolt` and
  `@slack/web-api`, added in Plan 3 because the spec names Bolt. Only
  `src/slack/app.ts` imports Bolt, and it is CommonJS — hence the
  `import pkg from "@slack/bolt"` default-import dance. Everything else in
  `src/slack/` is pure and stays off that import graph, which is what keeps the
  test suite offline.
- **Bolt's `App` is always built with `deferInitialization: true`.** Without it
  the constructor calls `auth.test`, and every test that builds an app becomes a
  network test. `src/slack/cli.ts` calls `await app.init()` itself.
```

- [ ] **Step 9: Full verification**

```bash
npm test
npm run typecheck
npm run sim          # the sim consumes postedToday now; confirm the balance run still works
```

Expected: all tests pass. The sim's headline numbers should be close to the balance-run doc's — Arbitrageur near 0.1%, no policy outside 9–21%. The protection gate can move them slightly, since an eliminated `Slacker` now loses its veto.

If the numbers moved meaningfully, that is a real finding, not a failure: record it in `docs/superpowers/reviews/` and note it in `HANDOFF.md`.

- [ ] **Step 10: Commit**

```bash
git add src/slack/cli.ts src/jobs/cli.ts deploy README.md HANDOFF.md package.json
git commit -m "feat(slack): bot entrypoint, systemd unit, and deployment docs"
```

---

## Spec deltas

Recorded the way Plan 2 recorded its own, so they are not re-litigated.

| Spec says | This plan does | Why |
|---|---|---|
| `DailyContext { slate, approvals, settlements }` | Adds `postedToday: FactionId[]` | The spec's elimination veto "gates on the post, not on peer approval", which the original three fields cannot express. |
| `Store.recordApproval(action)` writes `ApprovedAction` rows | The store records raw posts and reactions; `dailyApprovals` derives `ApprovedAction` at read time | An approval is a *property of two rows* — post plus two distinct reactors. Writing derived rows means a `reaction_removed` has to retract an approval that may or may not exist, which is a state machine. Deriving makes removal a single `DELETE`. |
| `ApprovedAction.eventId` is "Slack `event_ts`" | It is the post's `message_ts` | Ambiguous in the spec, since an approved action involves three events. The post's ts is the only one that is stable: a reaction's `event_ts` changes whenever an approval is removed and re-added, and `eventId` is a tie-break key. |
| Roster membership is implied | An explicit `roster` table, seeded by CLI, one faction per Slack user | Slack user ids are opaque and per-season. The uniqueness constraint is load-bearing: two accounts on one faction would defeat the self-approval check. |
| "Use Block Kit `plain_text`, which does not parse mrkdwn" | `plain_text` everywhere **and** `<`/`>` replaced with `‹`/`›` in `safeText` | The message's fallback `text` field is not `plain_text`, and it is what appears in notifications. |
| — | `unfurl_links: false` on every post | A recap naming a market would otherwise expand a live Kalshi preview under the post — which can show an outcome the recap has deliberately not stated. |

## What this plan does not build

- **The 21:00 tick runner.** Plan 4. It calls `dailyApprovals` for both context
  fields, `resolve()`, `saveState`, then `runPostRecap` — in that order, so a
  Slack outage cannot stall a tick.
- **The board image.** The recap is text-only. Plan 4's SVG renderer supplies the
  map, and the recap gains an image block then.
- **Slack OAuth for the web app.** Plan 4. This plan's bot token is a workspace
  bot token, unrelated to player sessions.
- **Photo proxying.** The recap never links a workout photo. If Plan 4's web app
  displays them, it proxies server-side — the bot token and signed Slack file
  URLs never reach a browser.
- **`claimTick` and the order lock.** Plan 4. Nothing here writes orders.
- **The generic tick-failure note.** The spec requires that a failed tick posts a
  note whose text is generic while the exception is logged locally. The ingest
  side of that rule is done — `app.error` logs and never echoes — but the tick
  has no failure path to guard yet. Plan 4 wraps `runPostRecap` and posts the
  note; the renderer it needs is one `section` block and belongs with the caller.
