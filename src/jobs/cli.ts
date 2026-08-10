/**
 * Entrypoint for the systemd timers.
 *
 *   tsx src/jobs/cli.ts publish-slate
 *   tsx src/jobs/cli.ts poll-settlements
 *   tsx src/jobs/cli.ts season-init <start-date> [--length N] [--seed N]
 *
 * Configuration comes from the environment:
 *   RR_DB_PATH    path to the SQLite file  (required)
 *   RR_SEASON_ID  the active season id     (required)
 *
 * Exit codes: 0 success or a deliberate skip, 1 failure worth a systemd retry.
 */
import { SEASON_LENGTH } from "../config.js"
import { createKalshiAdapter } from "../adapters/kalshi/index.js"
import { openStore } from "../store/sqlite.js"
import { runPublishSlate } from "./publish-slate.js"
import { runPollSettlements } from "./poll-settlements.js"
import { runSeasonInit } from "./season-init.js"
import { UsageError, parseFlags, seedFromDate } from "./flags.js"
import { renderSlate } from "../slack/announce.js"
import { createPoster } from "../slack/post.js"
import { loadSlackEnv } from "../slack/env.js"
import type { Market } from "../engine/index.js"

function required(name: string): string {
  const v = process.env[name]
  if (v === undefined || v === "") throw new UsageError(`${name} is not set`)
  return v
}

const command = process.argv[2]
const log = (msg: string) => console.log(msg)

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
        `expected one of: publish-slate, poll-settlements, season-init, ` +
          `roster-add, roster-list`,
    )
  }
} catch (err) {
  // Exit 1 so systemd's Restart=on-failure can retry. The publish job in
  // particular is worth retrying: an early failure still leaves hours before
  // the 21:00 lock.
  console.error(
    err instanceof UsageError ? err.message : err instanceof Error ? err.stack : String(err),
  )
  exitCode = 1
} finally {
  store?.close()
}

process.exit(exitCode)
