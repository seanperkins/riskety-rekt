> Generated: 2026-08-19 | Token-lean format for LLM context

# Jobs (`src/jobs/`) and deployment

Every job takes its clock as `now: Date`. Exit codes are three-valued: 0
success or deliberate skip, 1 system failure (systemd retries), 2 operator
mistake or a write the rules rejected — always via `UsageError` (`flags.ts`),
caught once in `cli.ts` and mapped to exit 2 (`ParseError` from
`order-entry.ts` maps the same way). **Tick refusals exit 0** — the condition
never clears with time; non-zero would restart-loop all night. An unknown
`RR_SEASON_ID` is a `UsageError` in every job module, not a plain `Error`, for
the same reason: it used to exit 1 and restart-looped the tick 778 times on
the live droplet.

| Job | Cadence | Entry |
|---|---|---|
| `runSeasonInit` | once | `season-init.ts` — roster → deal day 0; validates modules |
| `runPublishSlate` | 08:00 daily | `publish-slate.ts` |
| `runPublishRules` | 08:05 daily | `publish-rules.ts` — the rule-vote offer |
| `runPollSettlements` | every 30 min (`*:00/30`) | `poll-settlements.ts` |
| `runPollPrices` | every 30 min (`*:15/30`, offset) | `poll-prices.ts` — reuses `getCandidates`, writes `market_prices` |
| `runTick` | 00:05:30 daily, resolves `calendarDay - 1` | `tick.ts` |
| `runRerun` | operator | `rerun.ts` — replay from `tick_context` |
| `runModulesSet` | operator | `modules-set.ts` — mid-season module change |
| `runMapResync` | operator | `map-resync.ts` — rewrite frozen `states.map` after an adjacency regen |
| `runRosterSync` | operator | `roster-sync.ts` — additive roster sync from the Slack channel |
| `runPostRecap` | after the tick | `post-recap.ts`, via the `recaps` claim-then-post ledger |

## tick (`runTick`)

Guards, in load-bearing order: `no-deal` refusal (before everything) →
`missing-days` refusal (BEFORE the after-season skip, or a missed final day
confiscates day-13 wagers) → before-season / after-season / already-run skips →
before-cutoff (a 14:00 manual run must not resolve an open day). Then ONE
transaction: `stateExists` re-check (concurrency belt) → `assembleOrders` +
`loadSlate` + `dailyApprovals` → settlements for slate ∪ `marketIdsOf(previous)`
(prior pending markets are not on today's slate) → context
`{…, tickInstant, modules: season.modules, rules: dailyRuleSelection(...)}`
→ `resolve` → `saveState` → `saveTickContext`. No lock table — see CLAUDE.md.

The rule tally runs INSIDE the transaction: a `rule_reactions` row counts only
if present when the transaction reads AND `reacted_at <= tickInstant`. The
second half is what stops a delayed tick from counting post-midnight votes.

A successful tick calls `postRecapFor` (unforced, non-correction) once the
transaction has committed — a Slack outage can neither stall nor roll back a
resolved day.

## rerun (`runRerun`)

Replays `day .. min(calendarDay − 1, lengthDays)` against recorded contexts;
one transaction with `deleteStatesFrom` after reading every context into
memory. Engine-version mismatch is logged and proceeded, never refused.
`--assemble-missing` builds a live context for a day that never ticked. Each
replayed day gets a `postRecapFor(..., correction: true, force: false)` call
after the transaction commits.

**`backfillContext`**: frozen rows written before the module system lack
`tickInstant`/`modules`/`rules`. Synthesized as exactly: the calendar
`tickInstant` (startDate is immutable), the LITERAL `["markets","irl","veto"]`
(**never the season row** — rerun re-saves contexts, and a row read would
launder a mid-season module change into frozen history), and `[]`. Nothing
else is ever defaulted.

## modules-set (`runModulesSet`)

Validates against `MODULE_REGISTRY` (unknown ids, veto-without-irl → refused,
exit 2 at the CLI). Disabling a module is refused while `escrowed(own) > 0` —
the gate is the escrow, not slot presence (`{pending: []}` is idle). A
permitted disable needs no slot surgery: `resolve` rebuilds `moduleState` from
active modules, so the slot drops at the next tick and re-enable starts fresh.
Applied between ticks; visible in the NEXT day's frozen context only.

## map-resync (`runMapResync`, NEW)

A season freezes its map into every `states` row at the deal, so regenerating
`src/map/adjacency.ts` (`npm run build:shapes`) does not reach a running
season — this job is the fix-up. Report-then-write, `roster-sync`'s pattern:
`takeBool(["--confirm"])` runs before `parseFlags` (a bare `--confirm` would
otherwise be eaten as `parseFlags`'s value). One `survey()` walks
`0..latestSavedDay`, and for each saved day recomputes that day's territory
neighbours from the corrected map (`WORLD` at the CLI), filtered to ids still
present in that day's frozen territory list and sorted; a territory absent
from the corrected map keeps its frozen neighbours unchanged (logged). Result
is one of `MapResyncOutcome`: `"unchanged"` (no day differs), `"planned"`
(differs, `--confirm` absent — nothing written), `"rewritten"` (differs,
written). Without `--confirm`, `survey()` runs once outside any transaction.
With it, the **same `survey()` reruns INSIDE `store.transaction`** — it
surveys again under the write lock rather than trusting the pre-transaction
read — and only then calls the one and only `UPDATE` against `states`,
`store.updateStateMap(seasonId, day, map)`, per surveyed day.
`assertSymmetric` throws a plain (non-`UsageError`) `Error`, exit 1, if any
resulting neighbour pair isn't mutual both ways — a bug in the corrected map
or this job, not a fact to write into a live season. `regions` and each
faction's `bonus` are left exactly as dealt; recomputing them mid-season would
move scoring under the players. Unknown season → `UsageError`, exit 2. No
systemd unit — operator-only, run after a `build:shapes` regen.

## publish-rules (`runPublishRules`)

The 08:05 offer. Seeded draw (`(season.seed ^ day·0x9e3779b9) >>> 0`, stored on
every row) over `eligibleRules(season.modules)`, sliced to
**`RULES_PER_OFFER = 3`** — a thirteen-rule ballot would decide most days by
one or two votes and truncate the rest away. Three is also the balance lever:
each rule then wins ~1/13 of days instead of ~1/3. **Claim-then-post**, the recap ledger's pattern:
rows land with `message_ts` NULL, then the post, then the ts. A crash BEFORE
the post replays cleanly and re-posts with supersession copy; a crash AFTER it
orphans that message's reactions — bounded, accepted, and NOT asserted away.
Days `1..lengthDays` inclusive: rules apply to the same night's tick, unlike a
slate whose wagers settle a tick later. No poster configured → `claimed`.

## publish-slate / pollers

- All three **skip deliberately (exit 0) when `markets` is off**, touching no
  network (tested against an adapter that throws on contact).
- publish-slate: skip guards → `slatePublished` check BEFORE fetching →
  `getCandidates(window)` → `selectSlate` → `publishSlate` → optional
  `announce` (renders through `slack/table.ts`'s fenced monospace table via
  `renderSlate`; failure logged, never thrown). Adapter failure throws and
  writes nothing — an empty slate is only recorded after a successful fetch.
  Late-day runs legitimately publish nothing; judge by an 08:00 run.
- poll-settlements: never throws; unsettled markets retry next run; a wager
  unsettled two ticks refunds. This chain is why the tick may be offline.
- poll-prices: refreshes `market_prices`; the published slate stays frozen —
  `order_wagers.price` snapshots the placement price (the stale-price fix).

## order entry (`order-entry.ts`)

`npm run order|wager -- f1 --file x.json` (or `--stdin`; never a shell arg).
`parseOrderBody` bounds counts and list sizes. Writes go through the store's
`orderGate` (day range, midnight deadline, day-already-resolved, per-market
`stillOpen` lock, `markets-off`). Unknown season → `UsageError`, exit 2; a
`ParseError` from a malformed body also maps to exit 2.

## roster-sync (`runRosterSync`)

Reads Slack channel membership (`Directory.membersOf`) instead of collecting
`U0…` ids by hand. **Additive only, in both directions**: a member new to the
roster is `added`; a roster row whose Slack display name now differs is
`unchanged` and REPORTED ONLY, never rewritten (a player's self-chosen `/name`
must not be reverted by a re-run); a roster member no longer in the channel is
`absent` and left alone. Report-then-write: `apply` (CLI: `--confirm`, via
`takeBool` before `parseFlags`) gates every store write; without it nothing is
written regardless of what would change.

## CLI (`src/jobs/cli.ts`)

```
season-init <YYYY-MM-DD> [--length N] [--seed N]   modules-set <id...>
tick   recap <day> [--kind correction] [--force]
tick-rerun <day> [--confirm] [--assemble-missing]   map-resync [--confirm]
order|wager <faction> --file|--stdin
roster-add <slack-id> <faction> [name]   roster-sync [--confirm]   roster-list
publish-slate | publish-rules | poll-prices | poll-settlements
```

Flags parse by name (`flags.ts`'s `parseFlags`), never by position — the
historical bug this replaced read a flag by `argv` index and dealt a season of
`NaN` days. Bare boolean flags (`--force`, `--confirm`, `--stdin`,
`--assemble-missing`) are pulled out by `takeBool` BEFORE `parseFlags` runs,
because `parseFlags` reads strict `--name value` pairs and would otherwise
consume the next flag as `--force`'s value. `recap`'s `--force` was unreachable
under the old ordering; `takeBool` now runs first there too, and the
suppression hint it emits (`recap ... --force`) works. **Never
`process.exit()` with the store open** — set `exitCode`, fall through, close,
then `process.exit(exitCode)`.

## systemd (`deploy/`)

`riskety-publish-slate.timer` 08:00; `riskety-publish-rules.timer` 08:05, five
minutes after the slate so the two morning posts land in order;
`riskety-poll-settlements.timer` `*:00/30`;
`riskety-poll-prices.timer` `*:15/30` (offset, not simultaneous — avoids write
lock contention, though the settlement poller's loop is transactional now
too); `riskety-tick.timer` `00:05:30` — five minutes of Slack delivery grace
while the cutoff stays frozen at 00:00, the `:30` a second layer against the
settlement poller's `*:00/30`; deploy code before timer, never the reverse
(refusals exit 0 on purpose, so `Restart=on-failure` cannot loop — old code
under the new timer hits `before-cutoff` and stalls the season outright, with
no 21:00 run left to catch it). Every retrying unit
(`tick`, `publish-slate`, `publish-rules`) sets `RestartPreventExitStatus=2`
so an operator mistake (exit 2) is final rather than restart-looped like a
system failure. `riskety-slack.service` and `riskety-web.service` long-running
(`Restart=always` / `Restart=on-failure` respectively); a Caddyfile routes the
public HTTPS side. All read `/etc/riskety-rekt/env`. Target is a droplet, not
App Platform — an ephemeral filesystem wipes SQLite. `map-resync` and every
`roster-*`/`order`/`wager` command are operator-run, no timer. Demo tooling:
`riskety-demo-web.service`, `seed-demo.sh`. Full setup in `deploy/README.md`.
