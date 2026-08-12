> Generated: 2026-08-11 | Token-lean format for LLM context

# Jobs (`src/jobs/`) and deployment

Every job takes its clock as `now: Date`. Exit codes are three-valued: 0
success or deliberate skip, 1 system failure (systemd retries), 2 operator
mistake or a write the rules rejected. **Tick refusals exit 0** — the condition
never clears with time; non-zero would restart-loop all night.

| Job | Cadence | Entry |
|---|---|---|
| `runSeasonInit` | once | `season-init.ts` — roster → deal day 0; validates modules |
| `runPublishSlate` | 08:00 daily | `publish-slate.ts` |
| `runPollSettlements` | every 30 min | `poll-settlements.ts` |
| `runPollPrices` | every 30 min | `poll-prices.ts` — reuses `getCandidates`, writes `market_prices` |
| `runTick` | 21:00 daily | `tick.ts` |
| `runRerun` | operator | `rerun.ts` — replay from `tick_context` |
| `runModulesSet` | operator | `modules-set.ts` — mid-season module change |
| `runPostRecap` | after the tick | `post-recap.ts`, via the `recaps` claim-then-post ledger |

## tick (`runTick`)

Guards, in load-bearing order: `no-deal` refusal (before everything) →
`missing-days` refusal (BEFORE the after-season skip, or a missed final day
confiscates day-13 wagers) → before-season / after-season / already-run skips →
before-cutoff (a 14:00 manual run must not resolve an open day). Then ONE
transaction: `stateExists` re-check (concurrency belt) → `assembleOrders` +
`loadSlate` + `dailyApprovals` → settlements for slate ∪ `marketIdsOf(previous)`
(prior pending markets are not on today's slate) → context
`{…, tickInstant: tickInstant(season, day).toISOString(), modules: season.modules, rules: []}`
→ `resolve` → `saveState` → `saveTickContext`. No lock table — see CLAUDE.md.

## rerun (`runRerun`)

Replays `day .. min(calendarDay − 1, lengthDays)` against recorded contexts;
one transaction with `deleteStatesFrom` after reading every context into
memory. Engine-version mismatch is logged and proceeded, never refused.
`--assemble-missing` builds a live context for a day that never ticked.

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

## publish-slate / pollers

- All three **skip deliberately (exit 0) when `markets` is off**, touching no
  network (tested against an adapter that throws on contact).
- publish-slate: skip guards → `slatePublished` check BEFORE fetching →
  `getCandidates(window)` → `selectSlate` → `publishSlate` → optional
  `announce` (failure logged, never thrown). Adapter failure throws and writes
  nothing — an empty slate is only recorded after a successful fetch. Late-day
  runs legitimately publish nothing; judge by an 08:00 run.
- poll-settlements: never throws; unsettled markets retry next run; a wager
  unsettled two ticks refunds. This chain is why the tick may be offline.
- poll-prices: refreshes `market_prices`; the published slate stays frozen —
  `order_wagers.price` snapshots the placement price (the stale-price fix).

## order entry (`order-entry.ts`)

`npm run order|wager -- f1 --file x.json` (or `--stdin`; never a shell arg).
`parseOrderBody` bounds counts and list sizes. Writes go through the store's
`orderGate` (day range, 21:00 deadline, day-already-resolved, per-market
`stillOpen` lock, `markets-off`).

## CLI (`src/jobs/cli.ts`)

```
season-init <YYYY-MM-DD> [--length N] [--seed N]   modules-set <id...>
tick   recap <day> [--force]   tick-rerun <day> [--confirm] [--assemble-missing]
order|wager <faction> --file|--stdin   roster-add | roster-list
publish-slate | poll-prices | poll-settlements
```

Flags parse by name (`flags.ts`), never by position. **Never
`process.exit()` with the store open** — set `exitCode`, fall through, close.

## systemd (`deploy/`)

`riskety-publish-slate.timer` 08:00; `riskety-poll-settlements.timer` `*:00/30`;
`riskety-poll-prices.timer` `*:15/30` (offset, not simultaneous);
`riskety-tick.timer` `21:00:30` (refusals exit 0 on purpose, so
`Restart=on-failure` cannot loop); `riskety-slack.service` and
`riskety-web.service` long-running; a Caddyfile routes the public HTTPS side.
All read `/etc/riskety-rekt/env`. Target is a droplet, not App Platform — an
ephemeral filesystem wipes SQLite. Demo tooling: `riskety-demo-web.service`,
`seed-demo.sh`. Full setup in `deploy/README.md`.
