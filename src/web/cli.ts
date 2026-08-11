/**
 * The web app.
 *
 *   npm run web          # PORT defaults to 3002
 *
 * The Slack bot holds 3001, so these can run side by side on one droplet.
 */
import { createWebServer } from "./server.js"

const port = Number(process.env.PORT ?? 3002)
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  console.error(`PORT must be a port number, got ${String(process.env.PORT)}`)
  process.exit(1)
}

const server = createWebServer({ port, log: (m) => console.error(m) })
server.listen(port, () => console.log(`riskety-rekt web on http://localhost:${port}`))

// Without this a container stop waits for the shutdown timeout on every deploy.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
