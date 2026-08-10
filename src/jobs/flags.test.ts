import { describe, expect, it } from "vitest"
import { parseFlags, seedFromDate } from "./flags.js"

describe("parseFlags", () => {
  it("reads --name value pairs", () => {
    expect(parseFlags(["--seed", "4711", "--length", "14"], ["seed", "length"])).toEqual({
      seed: "4711",
      length: "14",
    })
  })

  it("is empty for no arguments", () => {
    expect(parseFlags([], ["seed"])).toEqual({})
  })

  it("rejects an unknown flag rather than ignoring it", () => {
    // A typo'd --sed would otherwise parse as "no seed given" and deal a
    // different board than the operator asked for, silently.
    expect(() => parseFlags(["--sed", "4711"], ["seed"])).toThrow(/unknown flag/)
  })

  it("rejects a positional argument", () => {
    // The bug this replaced: season-init read Number(argv[4]) as the length, so
    // `season-init <date> --seed 4711` dealt a season of NaN days.
    expect(() => parseFlags(["4711"], ["seed"])).toThrow(/unexpected argument/)
  })

  it("rejects a flag with no value, and a repeated flag", () => {
    expect(() => parseFlags(["--seed"], ["seed"])).toThrow(/needs a value/)
    expect(() => parseFlags(["--seed", "1", "--seed", "2"], ["seed"])).toThrow(/twice/)
  })
})

describe("seedFromDate", () => {
  it("is stable for a date and different across dates", () => {
    // Deterministic on purpose: a clock-derived default would make the deal
    // unreproducible from the recorded arguments.
    expect(seedFromDate("2026-09-01")).toBe(seedFromDate("2026-09-01"))
    expect(seedFromDate("2026-09-01")).not.toBe(seedFromDate("2026-09-02"))
  })

  it("is always a safe positive integer", () => {
    for (const d of ["2026-09-01", "1999-12-31", "2026-01-01", "2030-06-15"]) {
      const seed = seedFromDate(d)
      expect(Number.isSafeInteger(seed)).toBe(true)
      expect(seed).toBeGreaterThan(0)
    }
  })
})
