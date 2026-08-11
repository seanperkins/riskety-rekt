/**
 * Mint a demo login link.
 *
 * Demo database only — there is no Slack user behind these factions, so a
 * token has to be minted directly rather than through /login.
 *
 *   tsx demo-link.ts <factionId>
 */
import { hashToken, newToken } from "../src/auth/token.js"
import { openStore } from "../src/store/sqlite.js"

const factionId = process.argv[2] ?? "vanguard"
const dbPath = process.env.RR_DB_PATH ?? ""
if (!dbPath.endsWith("demo.db")) {
  console.error("refusing: not the demo database")
  process.exit(1)
}

const store = openStore(dbPath)
const raw = newToken()
store.mintLoginToken({
  slackUserId: `UDEMO-${factionId}`,
  factionId,
  tokenHash: hashToken(raw),
  // Long-lived on purpose: this is a demo link to be opened at leisure, not a
  // credential guarding anything real.
  expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
})
console.log(`https://demo.riskety.com/login/${raw}`)
store.close()
