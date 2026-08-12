// The committed balance rerun.
// Usage: npx tsx scripts/balance-run.ts [seasons] [policy...]
//
// With no roster it runs BOTH the authoritative six and the extended roster
// that adds Swarm (the only policy attacking more than once per tick) and
// Ghost (the only one that reliably dies). The pair is the point: the
// authoritative figures are only interpretable next to a roster that can
// actually punish a leader.
import { runMany, type Deal, type Report } from "../src/sim/run.js"

const AUTHORITATIVE = ["Blitz", "Consolidator", "Hunter", "Slacker", "GymRat", "Gambler"]
const EXTENDED = [...AUTHORITATIVE, "Swarm", "Ghost"]

const seasons = Number(process.argv[2] ?? 10_000)
const rest = process.argv.slice(3)
// `--shuffled` swaps in the pre-contiguous deal, the arm that isolates how
// much of the day-3 leader's persistence is the clustered holding.
const deal: Deal = rest.includes("--shuffled") ? "shuffled" : "clustered"
const roster = rest.filter((a) => !a.startsWith("--"))

function show(label: string, names: string[], rep: Report): void {
  console.log(`\n=== ${label} ===`)
  console.log(`seasons: ${rep.seasons}   roster: ${names.join(", ")}`)
  console.log(`mean board: ${rep.meanTerritories.toFixed(1)} territories`)
  const baseline = (100 / names.length).toFixed(1)
  console.log(`day-3 leader converts: ${(rep.day3LeaderWinRate * 100).toFixed(1)}%  (baseline ${baseline}%)`)
  for (const [name, w] of Object.entries(rep.wins).sort((a, b) => b[1] - a[1])) {
    const pct = ((w / rep.seasons) * 100).toFixed(1)
    const terr = rep.meanFinalTerritories[name]!.toFixed(1)
    const dead = ((rep.eliminationRate[name] ?? 0) * 100).toFixed(1)
    console.log(`  ${name.padEnd(14)} ${pct.padStart(5)}%   mean terr ${terr.padStart(5)}   eliminated ${dead.padStart(5)}%`)
  }
  // The veto's post gate: an offer from a faction that did not post is dropped
  // silently by the lock hook, so `gated` is the only evidence it ran at all.
  console.log(
    `veto offers: ${rep.vetoesOffered}   gated (no post): ${rep.vetoesGated}   protections applied: ${rep.protectionsApplied}`,
  )
}

const suffix = deal === "shuffled" ? " [scattered deal]" : ""
if (roster.length > 0) {
  show(`custom${suffix}`, roster, runMany(roster, seasons, { deal }))
} else {
  show(`authoritative six${suffix}`, AUTHORITATIVE, runMany(AUTHORITATIVE, seasons, { deal }))
  show(`extended (+ Swarm, Ghost)${suffix}`, EXTENDED, runMany(EXTENDED, seasons, { deal }))
}
