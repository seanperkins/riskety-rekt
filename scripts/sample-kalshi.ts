/**
 * Developer tool. Samples real Kalshi markets to derive VOLUME_FLOOR, and
 * records a page of live responses as a test fixture.
 *
 *   npm run sample:kalshi          # 7 days
 *   npm run sample:kalshi -- 14    # 14 days
 *
 * It issues exactly the query the 08:00 job issues -- status=open over a
 * 09:00-21:00 ET close window -- for each of the next N days. Forward, not
 * retrospective: a `status=settled` walk over past days returns far more
 * markets than any sane page cap allows, and the first attempt at this script
 * came back with exactly MAX_PAGES x 1000 markets on all seven days, which is
 * a truncation artifact wearing the costume of data. This shape completes.
 *
 * It under-counts slightly, because many same-day markets do not open until
 * the small hours of their own day. That bias is conservative: the real 08:00
 * pool is at least as large as what this reports.
 *
 * On the floor itself: the spec said to use the median of same-day markets.
 * Do not. Roughly half never trade, so that median sits near zero and admits
 * every untraded rung of every strike ladder. Use the median of markets that
 * actually traded, and sanity-check it against the distinct-series count --
 * that second number is what matters, because the slate takes at most one
 * market per series.
 */
import { writeFileSync } from "node:fs"
import {
  PAGE_LIMIT,
  SLATE_MAX,
  VOLUME_FLOOR,
  WINDOW_CLOSE_HOUR,
  WINDOW_OPEN_HOUR,
} from "../src/config.js"
import { etDate, etInstant } from "../src/time.js"
import { getAllMarkets } from "../src/adapters/kalshi/client.js"
import { seriesOf, toCandidate } from "../src/adapters/kalshi/parse.js"
import type { RawKalshiMarket } from "../src/adapters/kalshi/raw.js"

const days = Number(process.argv[2] ?? "7")
const unix = (d: Date) => String(Math.floor(d.getTime() / 1000))
const quantile = (sorted: number[], q: number) =>
  sorted.length === 0 ? 0 : sorted[Math.min(Math.floor(sorted.length * q), sorted.length - 1)]!

const FLOORS = [0, 100, 250, 500, 1000, 2500, 5000]

const allVolumes: number[] = []
let fixture: RawKalshiMarket[] = []
const perDay: { date: string; raw: number; truncated: boolean; byFloor: Map<number, number> }[] = []

for (let ahead = 0; ahead < days; ahead++) {
  const date = etDate(new Date(Date.now() + ahead * 86_400_000))
  const opensAfter = etInstant(date, WINDOW_OPEN_HOUR)
  const closesBefore = etInstant(date, WINDOW_CLOSE_HOUR)

  let truncated = false
  const raw = await getAllMarkets(
    {
      limit: String(PAGE_LIMIT),
      status: "open",
      min_close_ts: unix(opensAfter),
      max_close_ts: unix(closesBefore),
    },
    { onTruncate: () => (truncated = true) },
  )

  const byFloor = new Map<number, number>()
  for (const floor of FLOORS) {
    const series = new Set<string>()
    for (const m of raw) {
      const r = toCandidate(m, { opensAfter, closesBefore }, floor)
      if (r.ok) series.add(seriesOf(r.candidate.id))
    }
    byFloor.set(floor, series.size)
  }

  // Only count volumes of markets that clear the structural filters; the
  // untraded combo markets are noise the job never considers anyway.
  for (const m of raw) {
    const r = toCandidate(m, { opensAfter, closesBefore }, 0)
    if (r.ok) allVolumes.push(r.candidate.volume)
  }

  // Build the fixture from a spread across filter outcomes, not the first 40
  // rows -- those are invariably 40 rungs of one untraded ladder, which
  // exercises exactly one code path.
  if (fixture.length === 0 && raw.length > 0) {
    const buckets = new Map<string, RawKalshiMarket[]>()
    for (const m of raw) {
      const r = toCandidate(m, { opensAfter, closesBefore }, VOLUME_FLOOR)
      const key = r.ok ? "accepted" : r.reason
      const bucket = buckets.get(key) ?? []
      if (bucket.length < 6) bucket.push(m)
      buckets.set(key, bucket)
    }
    fixture = [...buckets.keys()].sort().flatMap((k) => buckets.get(k) ?? [])
    console.log(
      `  fixture buckets: ${[...buckets.entries()]
        .sort()
        .map(([k, v]) => `${k}=${v.length}`)
        .join(" ")}`,
    )
  }
  perDay.push({ date, raw: raw.length, truncated, byFloor })
  console.log(`${date}  ${String(raw.length).padStart(6)} markets${truncated ? "  TRUNCATED" : ""}`)
}

if (perDay.some((d) => d.truncated)) {
  console.log(`\n!! at least one day hit the page cap; raise MAX_PAGES before trusting this`)
}

const sorted = [...allVolumes].sort((a, b) => a - b)
const nonZero = sorted.filter((v) => v > 0)

console.log(`\n${sorted.length} markets passed the structural filters over ${days} days`)
console.log(
  `  never traded:       ${sorted.length - nonZero.length} (${(
    (1 - nonZero.length / Math.max(sorted.length, 1)) *
    100
  ).toFixed(1)}%)`,
)
console.log(`  median (all):       ${quantile(sorted, 0.5).toFixed(2)}   <- the spec's rule`)
console.log(`  median (traded):    ${quantile(nonZero, 0.5).toFixed(2)}   <- use this`)
console.log(`  p75 (traded):       ${quantile(nonZero, 0.75).toFixed(2)}`)

console.log(`\ndistinct series surviving, per day, by floor:`)
console.log(`  floor  ${perDay.map((d) => d.date.slice(5)).join("  ")}   min`)
for (const floor of FLOORS) {
  const counts = perDay.map((d) => d.byFloor.get(floor) ?? 0)
  console.log(
    `  ${String(floor).padStart(5)}  ${counts.map((c) => String(c).padStart(5)).join("  ")}   ${Math.min(
      ...counts,
    )}`,
  )
}
console.log(`\nPick the highest floor whose worst day still clears SLATE_MAX (${SLATE_MAX}) series.`)

writeFileSync(
  new URL("../src/adapters/kalshi/__fixtures__/candidates-page.json", import.meta.url),
  `${JSON.stringify({ markets: fixture }, null, 2)}\n`,
)
console.log(`\nwrote __fixtures__/candidates-page.json (${fixture.length} markets)`)
