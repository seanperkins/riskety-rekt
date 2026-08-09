import { runMany } from "./run.js"

const roster = process.argv.slice(2)
const names =
  roster.length > 0
    ? roster
    : ["Turtle", "Blitz", "GymRat", "Slacker", "Gambler", "Arbitrageur"]

const SEASONS = 2000
const report = runMany(names, SEASONS)

console.log(`seasons: ${report.seasons}   roster: ${names.join(", ")}`)
console.log(`day-3 leader goes on to win: ${(report.day3LeaderWinRate * 100).toFixed(1)}%`)
console.log("")
for (const [name, w] of Object.entries(report.wins).sort((a, b) => b[1] - a[1])) {
  const pct = ((w / report.seasons) * 100).toFixed(1)
  const mean = report.meanFinalTerritories[name]!.toFixed(1)
  console.log(`  ${name.padEnd(14)} ${pct.padStart(5)}%   mean territories ${mean.padStart(5)}`)
}
