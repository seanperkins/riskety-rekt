// The committed balance rerun for the pluggable-mechanics change.
// Usage: npx tsx scripts/balance-run.ts [seasons]
import { runMany } from "../src/sim/run.js"

const AUTHORITATIVE = ["Blitz", "Consolidator", "Hunter", "Slacker", "GymRat", "Gambler"]
const seasons = Number(process.argv[2] ?? 10_000)

const rep = runMany(AUTHORITATIVE, seasons)
console.log(`seasons: ${rep.seasons}   roster: ${AUTHORITATIVE.join(", ")}`)
console.log(`mean board: ${rep.meanTerritories.toFixed(1)} territories`)
console.log(`day-3 leader converts: ${(rep.day3LeaderWinRate * 100).toFixed(1)}%`)
for (const [name, w] of Object.entries(rep.wins).sort((a, b) => b[1] - a[1])) {
  const pct = ((w / rep.seasons) * 100).toFixed(1)
  console.log(`  ${name.padEnd(14)} ${pct.padStart(5)}%   mean terr ${rep.meanFinalTerritories[name]!.toFixed(1)}`)
}
