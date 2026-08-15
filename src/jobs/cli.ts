/**
 * Entrypoint for the systemd timers.
 *
 *   tsx src/jobs/cli.ts publish-slate
 *   tsx src/jobs/cli.ts publish-rules
 *   tsx src/jobs/cli.ts poll-settlements
 *   tsx src/jobs/cli.ts poll-prices
 *   tsx src/jobs/cli.ts season-init <start-date> [--length N] [--seed N]
 *   tsx src/jobs/cli.ts tick
 *   tsx src/jobs/cli.ts recap <day> [--kind correction] [--force]
 *   tsx src/jobs/cli.ts tick-rerun <day> [--confirm] [--assemble-missing]
 *   tsx src/jobs/cli.ts order <faction> --file order.json | --stdin
 *   tsx src/jobs/cli.ts wager <faction> --file wager.json | --stdin
 *
 * Configuration comes from the environment:
 *   RR_DB_PATH    path to the SQLite file  (required)
 *   RR_SEASON_ID  the active season id     (required)
 *
 * Exit codes:
 *   0  success, or a deliberate skip
 *   1  system failure, worth a systemd retry
 *   2  operator error — bad usage, or a write the rules rejected
 *
 * A REFUSAL exits 0, not 1. It is a deliberate stop whose condition never
 * clears with time, and the units use Restart=on-failure with RestartSec=300 —
 * exiting 1 would restart every five minutes all night, reopening the database
 * and writing a stack trace each time.
 */
import { readFileSync } from "node:fs"
import { SEASON_LENGTH } from "../config.js"
import { createKalshiAdapter } from "../adapters/kalshi/index.js"
import { openStore } from "../store/sqlite.js"
import { runPublishSlate } from "./publish-slate.js"
import { runPublishRules } from "./publish-rules.js"
import { runPollSettlements } from "./poll-settlements.js"
import { runPollPrices } from "./poll-prices.js"
import { runSeasonInit } from "./season-init.js"
import { runModulesSet } from "./modules-set.js"
import { runTick } from "./tick.js"
import { runRerun } from "./rerun.js"
import type { RerunRefusal } from "./rerun.js"
import { runPostRecap } from "./post-recap.js"
import { ParseError, parseOrderBody, parseWagers } from "./order-entry.js"
import { UsageError, parseFlags, seedFromDate } from "./flags.js"
import { currentDay } from "../season.js"
import { renderSlate } from "../slack/announce.js"
import { createDirectory, createPoster } from "../slack/post.js"
import { runRosterSync } from "./roster-sync.js"
import { loadSlackEnv } from "../slack/env.js"
import { RISK_MAP } from "../engine/index.js"
import type { GameState, Market } from "../engine/index.js"

function required(name: string): string {
  const v = process.env[name]
  if (v === undefined || v === "") throw new UsageError(`${name} is not set`)
  return v
}

const command = process.argv[2]
const log = (msg: string) => console.log(msg)

/**
 * Pull boolean flags out of argv before `parseFlags` sees it. `parseFlags`
 * reads strict `--name value` pairs, so a bare `--confirm` would eat the next
 * flag as its value.
 */
function takeBool(names: string[]): boolean {
  let found = false
  for (const name of names) {
    const i = process.argv.indexOf(name)
    if (i !== -1) {
      process.argv.splice(i, 1)
      found = true
    }
  }
  return found
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString("utf8")
}

function describeRerunRefusal(r: RerunRefusal): string {
  switch (r.reason) {
    case "bad-day":
      return `day must be an integer in [1, ${r.lengthDays}]; got ${r.day}`
    case "no-deal":
      return `the season has no dealt board`
    case "missing-context":
      return `day ${r.day} has no recorded context; pass --assemble-missing to build one from live tables`
    case "day-not-over":
      return `day ${r.day} has not finished yet`
    case "within-grace":
      return (
        `day ${r.day} ended less than six minutes ago; assembling now would read ` +
        `approvals and votes Slack may still be delivering, and the saved state ` +
        `would make tonight's tick skip the day. Wait for the tick, or re-run after 00:06`
      )
  }
}

/**
 * The recap, through the ledger, always AFTER the state is committed — so a
 * Slack outage can neither stall nor roll back a resolved day.
 */
async function postRecapFor(
  s: ReturnType<typeof openStore>,
  seasonId: string,
  state: GameState,
  previous: GameState,
  correction: boolean,
  force: boolean,
): Promise<void> {
  const season = s.season(seasonId)
  if (season === undefined) throw new UsageError(`unknown season ${seasonId}`)
  // Same concession publish-slate makes: a workspace that is not configured yet
  // must still be able to run a season. A resolved day is already committed by
  // the time we get here, so throwing on a missing token would turn a
  // successful tick into a non-zero exit and a systemd retry that can only ever
  // return already-run.
  if (process.env.SLACK_BOT_TOKEN === undefined || process.env.SLACK_BOT_TOKEN === "") {
    log(`day ${state.day} resolved; SLACK_BOT_TOKEN is not set, so no recap was posted`)
    return
  }
  // The day's winning rule, from the frozen context — the recap announces it.
  const ruleIds = s.loadTickContext(seasonId, state.day)?.context.rules ?? []
  const out = await runPostRecap({
    poster: createPoster(loadSlackEnv()),
    state,
    previous,
    lengthDays: season.lengthDays,
    ledger: s,
    seasonId,
    now: new Date(),
    correction,
    force,
    ...(ruleIds.length === 0 ? {} : { ruleIds }),
    // Roster names, not the copies createSeason froze at the deal. Every
    // Markets line names a player, so a renamed player would otherwise be
    // addressed by a name they no longer use.
    names: Object.fromEntries(s.roster().map((m) => [m.factionId, m.displayName])),
    marketTitles: s.marketQuestions(seasonId),
    log,
  })
  if (out.status === "suppressed") {
    log(`recap for day ${state.day} already recorded; pass --force to post another`)
  }
}

/**
 * Never call process.exit() with the database open: it terminates immediately
 * and skips the finally block, leaving the WAL file behind on every bad
 * invocation. Set the code, fall through, close, then exit.
 */
let exitCode = 0
let store: ReturnType<typeof openStore> | undefined

/**
 * A truncated candidate walk still yields a playable slate, so this warns
 * rather than failing. But it must never pass silently: the first sampling run
 * against the live API returned exactly MAX_PAGES x 1000 markets on seven
 * consecutive days and looked entirely like real data.
 */
const onTruncate = (pages: number, collected: number) =>
  console.error(
    `WARNING: stopped at the ${pages}-page cap with ${collected} markets and more pending;` +
      ` today's candidate set is incomplete. Raise MAX_PAGES.`,
  )

try {
  store = openStore(required("RR_DB_PATH"))

  if (command === "season-init") {
    // Flags are parsed by name, not by position. The previous version read
    // `Number(process.argv[4] ?? SEASON_LENGTH)`, so `season-init <date> --seed
    // 4711` put "--seed" in argv[4] and dealt a season of NaN days.
    const startDate = process.argv[3]
    if (startDate === undefined || startDate.startsWith("--")) {
      throw new UsageError("usage: season-init <YYYY-MM-DD> [--length N] [--seed N]")
    }
    const flags = parseFlags(process.argv.slice(4), ["length", "seed"])
    const lengthDays = flags.length === undefined ? SEASON_LENGTH : Number(flags.length)
    // A seed is optional, but an ABSENT one still has to be recorded, so the
    // deal stays reproducible. Derived from the date rather than a clock, so
    // re-running the same command is the same board.
    const seed = flags.seed === undefined ? seedFromDate(startDate) : Number(flags.seed)

    const out = runSeasonInit({
      store,
      seasonId: required("RR_SEASON_ID"),
      startDate,
      lengthDays,
      seed,
    })
    if (out.status === "refused") throw new UsageError(`season-init refused: ${out.reason}`)
    log(
      `season ${required("RR_SEASON_ID")}: day 0 dealt ${startDate}, ${lengthDays} ticks, ` +
        `${out.factions} factions on ${out.territories} territories, seed ${out.seed}`,
    )
  } else if (command === "modules-set") {
    // The operator's mid-season module change, between ticks. Refusals exit 2
    // (an operator mistake or a write the rules rejected), via UsageError.
    const modules = process.argv.slice(3).filter((a) => !a.startsWith("--"))
    const out = runModulesSet({ store, seasonId: required("RR_SEASON_ID"), modules, log })
    if (out.status === "refused") throw new UsageError(`modules-set refused: ${out.reason}`)
    log(`modules set to [${out.modules.join(", ")}]`)
  } else if (command === "tick") {
    const seasonId = required("RR_SEASON_ID")
    const out = runTick({ store, seasonId, now: new Date(), log })
    if (out.status === "skipped") {
      log(`skipped day ${out.day}: ${out.reason}`)
    } else if (out.status === "refused") {
      // Exit 0. See the exit-code note above: this condition never clears with
      // time, so a non-zero exit would restart-loop until morning.
      console.error(
        out.reason === "no-deal"
          ? `REFUSED: season ${seasonId} has no dealt board. Run "npm run season:init".`
          : `REFUSED: day${out.from === out.to ? "" : "s"} ${out.from}${
              out.from === out.to ? "" : `-${out.to}`
            } never ticked. Run "npm run tick:rerun -- ${out.from} --confirm".`,
      )
    } else {
      await postRecapFor(store, seasonId, out.next, out.previous, false, false)
    }
  } else if (command === "recap") {
    const seasonId = required("RR_SEASON_ID")
    const day = Number(process.argv[3])
    const flags = parseFlags(process.argv.slice(4), ["kind"])
    const force = takeBool(["--force"])
    if (!Number.isSafeInteger(day)) throw new UsageError("usage: recap <day> [--kind correction] [--force]")
    const correction = flags.kind === "correction"
    const state = store.loadState(seasonId, day)
    const previous = store.loadState(seasonId, day - 1)
    if (state === undefined || previous === undefined) {
      throw new UsageError(`no saved state for day ${day}${previous === undefined ? " or the day before it" : ""}`)
    }
    await postRecapFor(store, seasonId, state, previous, correction, force)
  } else if (command === "tick-rerun") {
    const seasonId = required("RR_SEASON_ID")
    const day = Number(process.argv[3])
    const confirm = takeBool(["--confirm"])
    const assembleMissing = takeBool(["--assemble-missing"])
    parseFlags(process.argv.slice(4), [])
    const out = runRerun({
      store,
      seasonId,
      day,
      now: new Date(),
      confirm,
      assembleMissing,
      log,
    })
    if (out.status === "refused") {
      throw new UsageError(`tick-rerun refused: ${describeRerunRefusal(out.refusal)}`)
    }
    if (out.status === "replayed") {
      // Correction recaps only after the transaction commits.
      for (const s of out.states) {
        await postRecapFor(store, seasonId, s.next, s.previous, true, false)
      }
    }
  } else if (command === "order" || command === "wager") {
    const seasonId = required("RR_SEASON_ID")
    const factionId = process.argv[3]
    if (factionId === undefined || factionId.startsWith("--")) {
      throw new UsageError(`usage: ${command} <faction-id> --file <path> | --stdin`)
    }
    const stdin = takeBool(["--stdin"])
    const flags = parseFlags(process.argv.slice(4), ["file"])
    if (stdin === (flags.file !== undefined)) {
      throw new UsageError("give exactly one of --file <path> or --stdin")
    }
    // Never a shell argument. `npm run X -- args` composes a string executed by
    // sh, and both the body and the market id are third-party text.
    const json = stdin ? await readStdin() : readFileSync(flags.file!, "utf8")

    const season = store.season(seasonId)
    if (season === undefined) throw new UsageError(`unknown season ${seasonId}`)
    const now = new Date()
    const day = currentDay(season, now)

    let result
    if (command === "order") {
      const territoryCount =
        store.loadState(seasonId, 0)?.map.territories.length ?? RISK_MAP.territories.length
      result = store.saveOrder(seasonId, day, factionId, parseOrderBody(json, { territoryCount }), now)
      if (result.ok) log(`order recorded for ${factionId}, day ${day}`)
    } else {
      const wagers = parseWagers(json)
      result = { ok: true } as ReturnType<typeof store.saveWager>
      for (const w of wagers) {
        result = store.saveWager(seasonId, day, factionId, w, now)
        if (!result.ok) break
        log(`wager recorded for ${factionId}, day ${day}: ${w.marketId} ${w.side} ${w.stake}`)
      }
    }
    if (!result.ok) {
      // Exit 2, not 1. A lock rejection is the rules working, not a system
      // failure, and a wrapper script must be able to tell them apart.
      console.error(`rejected: ${result.reason}`)
      exitCode = 2
    }
  } else if (command === "roster-add") {
    const [slackUserId, factionId, ...nameParts] = process.argv.slice(3)
    let displayName = nameParts.join(" ")
    if (!slackUserId || !factionId) {
      throw new UsageError("usage: roster-add <slack-user-id> <faction-id> [display name]")
    }
    if (displayName === "") {
      // Slack already knows what this person is called; asking an operator to
      // retype it is how a roster ends up with "Sean " and "sean".
      const token = required("SLACK_BOT_TOKEN")
      const found = await createDirectory(token).nameFor(slackUserId)
      if (found === undefined) {
        throw new UsageError(
          `Slack has no readable name for ${slackUserId} — pass one: roster-add ${slackUserId} ${factionId} "Their Name"`,
        )
      }
      displayName = found
    }
    store.addRosterMember({ slackUserId, factionId, displayName })
    log(`roster: ${slackUserId} -> ${factionId} (${displayName})`)
  } else if (command === "roster-sync") {
    // Everyone joins the channel; this reads it. Reports by default and writes
    // only with --confirm, because the faction ids it invents are what every
    // later log line and saved state will carry.
    const apply = takeBool(["--confirm"])
    const out = await runRosterSync({
      store,
      directory: createDirectory(required("SLACK_BOT_TOKEN")),
      channelId: required("SLACK_CHANNEL_ID"),
      apply,
      log,
    })
    // `unchanged` is a report and is never written, so it must not decide
    // whether there is anything to confirm — a roster whose only difference is
    // a Slack rename is already in its final state, and offering --confirm
    // would promise a write that never happens.
    if (!apply) {
      log(
        out.added.length === 0
          ? "roster already has everyone in the channel"
          : "\nnothing written — re-run with --confirm",
      )
    } else {
      log(`\nroster: ${out.added.length} added`)
    }
    if (out.unchanged.length > 0) {
      log(`${out.unchanged.length} name(s) differ from Slack and were kept as they are`)
    }
  } else if (command === "roster-list") {
    for (const m of store.roster()) {
      log(`${m.factionId}\t${m.slackUserId}\t${m.displayName}`)
    }
  } else if (command === "publish-slate") {
    // Optional: a workspace that is not configured yet should still be able to
    // publish a slate to the database and the web app.
    const announce =
      process.env.SLACK_BOT_TOKEN === undefined || process.env.SLACK_BOT_TOKEN === ""
        ? undefined
        : async (day: number, slate: Market[]) => {
            await createPoster(loadSlackEnv()).post(renderSlate(day, slate))
          }

    const out = await runPublishSlate({
      store,
      adapter: createKalshiAdapter({ onTruncate }),
      seasonId: required("RR_SEASON_ID"),
      now: new Date(),
      log,
      ...(announce === undefined ? {} : { announce }),
    })
    if (out.status === "skipped") log(`skipped day ${out.day}: ${out.reason}`)
  } else if (command === "publish-rules") {
    // Optional poster, same concession as the slate announcement: an
    // unconfigured workspace still claims the day's draw, and a later
    // configured run posts it.
    const poster =
      process.env.SLACK_BOT_TOKEN === undefined || process.env.SLACK_BOT_TOKEN === ""
        ? undefined
        : createPoster(loadSlackEnv())
    const out = await runPublishRules({
      store,
      seasonId: required("RR_SEASON_ID"),
      now: new Date(),
      log,
      ...(poster === undefined ? {} : { poster }),
    })
    if (out.status === "skipped") log(`skipped day ${out.day}: ${out.reason}`)
  } else if (command === "poll-prices") {
    const out = await runPollPrices({
      store,
      adapter: createKalshiAdapter({ onTruncate }),
      seasonId: required("RR_SEASON_ID"),
      now: new Date(),
      log,
    })
    if (out.markets === 0) log("no slate today; nothing to price")
  } else if (command === "poll-settlements") {
    const out = await runPollSettlements({
      store,
      adapter: createKalshiAdapter({ onTruncate }),
      seasonId: required("RR_SEASON_ID"),
      now: new Date(),
      log,
    })
    if (out.checked === 0) log("nothing awaiting settlement")
  } else {
    throw new UsageError(
      `unknown command: ${String(command)}\n` +
        `expected one of: publish-slate, publish-rules, poll-settlements, poll-prices, ` +
          `season-init, tick, recap, tick-rerun, order, wager, roster-add, roster-sync, roster-list`,
    )
  }
} catch (err) {
  // Exit 1 so systemd's Restart=on-failure can retry. The publish job in
  // particular is worth retrying: an early failure still leaves hours before
  // the midnight lock.
  const operatorError = err instanceof UsageError || err instanceof ParseError
  console.error(operatorError ? (err as Error).message : err instanceof Error ? err.stack : String(err))
  // 2 for an operator mistake, 1 for a system failure worth a systemd retry.
  // A wrapper script must be able to tell "you typed it wrong" from "the disk
  // is full", and Restart=on-failure should not retry the former.
  exitCode = operatorError ? 2 : 1
} finally {
  store?.close()
}

process.exit(exitCode)
