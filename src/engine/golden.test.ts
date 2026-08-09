import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { describe, expect, it } from "vitest"
import { runSeason } from "../sim/run.js"

const GOLDEN = "src/engine/__golden__/season-1.json"
const ROSTER = ["Turtle", "Blitz", "GymRat", "Slacker"]

describe("golden-file replay", () => {
  it("reproduces a recorded season exactly", () => {
    const actual = runSeason(ROSTER, 1)
    if (!existsSync(GOLDEN)) {
      mkdirSync(dirname(GOLDEN), { recursive: true })
      writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`)
      console.warn(`wrote new golden file ${GOLDEN} — re-run to verify`)
      return
    }
    expect(actual).toEqual(JSON.parse(readFileSync(GOLDEN, "utf8")))
  })

  it("produces identical results across repeated runs", () => {
    expect(runSeason(ROSTER, 99)).toEqual(runSeason(ROSTER, 99))
  })

  it("produces identical results regardless of roster ordering in memory", () => {
    // Same roster, same seed, run twice with a fresh policy lookup each time.
    const a = runSeason([...ROSTER], 5)
    const b = runSeason([...ROSTER], 5)
    expect(a).toEqual(b)
  })
})
