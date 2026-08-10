import { describe, expect, it } from "vitest"
import { selectSlate } from "./select.js"
import type { Candidate } from "../adapters/types.js"

function cand(id: string, volume: number, series = id.split("-")[0]!): Candidate {
  return {
    id,
    question: `q ${id}`,
    priceYes: 0.4,
    priceNo: 0.6,
    closeTime: "2026-08-10T18:00:00Z",
    volume,
    series,
  }
}

describe("selectSlate", () => {
  it("returns at most SLATE_MAX markets", () => {
    const out = selectSlate([
      cand("A-1", 900),
      cand("B-1", 800),
      cand("C-1", 700),
      cand("D-1", 600),
      cand("E-1", 500),
      cand("F-1", 400),
    ])
    expect(out).toHaveLength(5)
  })

  it("takes the most-traded markets", () => {
    const out = selectSlate([cand("A-1", 10), cand("B-1", 5000), cand("C-1", 900)], 2)
    expect(out.map((m) => m.id).sort()).toEqual(["B-1", "C-1"])
  })

  it("takes at most one market per series", () => {
    // The real failure this prevents: a same-day window is dominated by strike
    // ladders, so a naive top-5-by-volume publishes five rungs of one SOL
    // ladder -- five bets on one number.
    const out = selectSlate([
      cand("KXSOLE-B74", 9000),
      cand("KXSOLE-B75", 8900),
      cand("KXSOLE-B76", 8800),
      cand("KXBTC-T1", 100),
      cand("KXNFL-G1", 90),
    ])
    expect(out.map((m) => m.id)).toEqual(["KXBTC-T1", "KXNFL-G1", "KXSOLE-B74"])
  })

  it("keeps the highest-volume member of a series", () => {
    const out = selectSlate([cand("KXSOLE-B74", 10), cand("KXSOLE-B75", 9000)], 5)
    expect(out.map((m) => m.id)).toEqual(["KXSOLE-B75"])
  })

  it("breaks volume ties on id ascending", () => {
    const out = selectSlate([cand("B-1", 500), cand("A-1", 500)], 1)
    expect(out.map((m) => m.id)).toEqual(["A-1"])
  })

  it("returns the slate sorted by market id", () => {
    // The spec asks for a deterministic order in the persisted slate; volume
    // ordering is a selection rule, id ordering is the storage rule.
    const out = selectSlate([cand("Z-1", 900), cand("A-1", 800), cand("M-1", 700)])
    expect(out.map((m) => m.id)).toEqual(["A-1", "M-1", "Z-1"])
  })

  it("strips the selection-only fields", () => {
    const out = selectSlate([cand("A-1", 900)])
    expect(out[0]).toEqual({
      id: "A-1",
      question: "q A-1",
      priceYes: 0.4,
      priceNo: 0.6,
      closeTime: "2026-08-10T18:00:00Z",
    })
    expect(out[0]).not.toHaveProperty("volume")
    expect(out[0]).not.toHaveProperty("series")
  })

  it("returns an empty slate for no candidates", () => {
    expect(selectSlate([])).toEqual([])
  })

  it("publishes a short slate rather than nothing when few survive", () => {
    // A 2-market day is still a playable day; an empty one is plain Risk.
    expect(selectSlate([cand("A-1", 900), cand("B-1", 800)])).toHaveLength(2)
  })

  it("does not mutate its input", () => {
    const input = [cand("B-1", 100), cand("A-1", 200)]
    const copy = structuredClone(input)
    selectSlate(input)
    expect(input).toEqual(copy)
  })

  it("is deterministic across input orderings", () => {
    const pool = [cand("A-1", 500), cand("B-1", 500), cand("C-1", 900), cand("A-2", 700, "A")]
    const forward = selectSlate(pool, 2)
    const backward = selectSlate([...pool].reverse(), 2)
    expect(forward).toEqual(backward)
  })
})
