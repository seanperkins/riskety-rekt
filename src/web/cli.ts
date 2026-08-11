/**
 * The web app.
 *
 *   npm run web          # PORT defaults to 3002
 *
 * The Slack bot holds 3001, so these can run side by side on one droplet.
 */
import { openStore } from "../store/sqlite.js"
import { createWebServer } from "./server.js"

function required(name: string): string {
  const v = process.env[name]
  if (v === undefined || v === "") {
    console.error(`${name} is not set`)
    process.exit(1)
  }
  return v
}

const port = Number(process.env.PORT ?? 3002)
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  console.error(`PORT must be a port number, got ${String(process.env.PORT)}`)
  process.exit(1)
}

// Never call process.exit() with the store open -- it skips the close and
// leaves a WAL file behind. The signal handlers below close first.
const store = openStore(required("RR_DB_PATH"))
const seasonId = required("RR_SEASON_ID")

const server = createWebServer({ port, store, seasonId, log: (m) => console.error(m) })
server.listen(port, () => console.log(`riskety-rekt web on http://localhost:${port}`))

// Without this a container stop waits for the shutdown timeout on every deploy.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () =>
    server.close(() => {
      store.close()
      process.exit(0)
    }),
  )
}
