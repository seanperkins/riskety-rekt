/**
 * The long-running Slack Events bot.
 *
 *   tsx src/slack/cli.ts
 *
 * Configuration comes from the environment:
 *   RR_DB_PATH             path to the SQLite file      (required)
 *   RR_SEASON_ID           which season /login checks   (required)
 *   SLACK_SIGNING_SECRET   Events request verification  (required)
 *   SLACK_BOT_TOKEN        xoxb- token                  (required)
 *   SLACK_TEAM_ID          workspace id                 (required)
 *   SLACK_CHANNEL_ID       the game channel             (required)
 *   PORT                   listen port, default 3001
 *
 * Any missing variable kills the process at boot. A missing signing secret must
 * never degrade into an unverified handler.
 */
import { openStore } from "../store/sqlite.js"
import { createSlackApp } from "./app.js"
import { loadSlackEnv } from "./env.js"
import { createDirectory } from "./post.js"

const dbPath = process.env.RR_DB_PATH
if (dbPath === undefined || dbPath === "") {
  console.error("RR_DB_PATH is not set — refusing to start.")
  process.exit(1)
}

// Loaded before the store is opened, so a misconfigured service leaves no WAL
// file behind. A configuration error is not a crash — print the one line an
// operator needs, not a stack trace into systemd's journal.
let env
try {
  env = loadSlackEnv()
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}

const seasonId = process.env.RR_SEASON_ID
if (seasonId === undefined || seasonId === "") {
  console.error("RR_SEASON_ID is not set — refusing to start.")
  process.exit(1)
}

const store = openStore(dbPath)
// Built here rather than in `app.ts`: `createDirectory` is in `post.ts`, the
// one file allowed to import the Web API client.
const app = createSlackApp({
  env,
  store,
  seasonId,
  directory: createDirectory(env.botToken),
  log: (msg) => console.log(msg),
})

const port = Number(process.env.PORT ?? 3001)

// deferInitialization is set in createSlackApp, so init() is ours to call.
await app.init()
await app.start(port)
console.log(`slack bot listening on ${port}, channel ${env.channelId}`)

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void app
      .stop()
      .catch((err: unknown) => console.error(`stop failed: ${String(err)}`))
      .finally(() => {
        store.close()
        process.exit(0)
      })
  })
}
