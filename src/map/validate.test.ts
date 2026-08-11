import { describe, expect, it } from "vitest"
import { RISK_MAP } from "../engine/index.js"
import type { GameMap } from "../engine/index.js"
import { validateMap } from "./validate.js"

/** Two regions of four, in a line, fully legal. */
const good = (): GameMap => ({
  regions: [
    { id: "x", name: "X", bonus: 2 },
    { id: "y", name: "Y", bonus: 2 },
  ],
  territories: [
    { id: "x1", name: "X1", region: "x", neighbors: ["x2"] },
    { id: "x2", name: "X2", region: "x", neighbors: ["x1", "x3"] },
    { id: "x3", name: "X3", region: "x", neighbors: ["x2", "x4"] },
    { id: "x4", name: "X4", region: "x", neighbors: ["x3", "y1"] },
    { id: "y1", name: "Y1", region: "y", neighbors: ["y2", "x4"] },
    { id: "y2", name: "Y2", region: "y", neighbors: ["y1", "y3"] },
    { id: "y3", name: "Y3", region: "y", neighbors: ["y2", "y4"] },
    { id: "y4", name: "Y4", region: "y", neighbors: ["y3"] },
  ],
})

describe("validateMap", () => {
  it("passes a minimal legal map", () => {
    expect(validateMap(good())).toEqual([])
  })

  it("passes RISK_MAP apart from Asia's size", () => {
    // Classic Risk's Asia is 12 territories, outside the 4-9 band the generated
    // world holds to. RISK_MAP predates that rule and is grandfathered: it is
    // the golden fixture and createSeason's default, and is never selected from.
    expect(validateMap(RISK_MAP)).toEqual([{ kind: "region-size", region: "as", size: 12 }])
  })

  it("catches an asymmetric border", () => {
    // The most likely hand-authoring mistake: you add Kenya to Uganda's list and
    // forget Uganda in Kenya's.
    const m = good()
    m.territories[0]!.neighbors = ["x2", "y4"]
    expect(validateMap(m)).toContainEqual({ kind: "asymmetric", id: "x1", neighbor: "y4" })
  })

  it("catches an unknown neighbour, a self-loop and a duplicate neighbour", () => {
    const m = good()
    m.territories[0]!.neighbors = ["x2", "nowhere", "x1", "x2"]
    const out = validateMap(m)
    expect(out).toContainEqual({ kind: "unknown-neighbor", id: "x1", neighbor: "nowhere" })
    expect(out).toContainEqual({ kind: "self-loop", id: "x1" })
    expect(out).toContainEqual({ kind: "duplicate-neighbor", id: "x1", neighbor: "x2" })
  })

  it("catches a duplicate territory id", () => {
    const m = good()
    m.territories.push({ ...m.territories[0]!, name: "dupe" })
    expect(validateMap(m)).toContainEqual({ kind: "duplicate-territory", id: "x1" })
  })

  it("catches an empty region and one outside the 4-9 band", () => {
    const m = good()
    m.regions.push({ id: "z", name: "Z", bonus: 1 })
    m.territories = m.territories.filter((t) => t.id !== "y4")
    m.territories.find((t) => t.id === "y3")!.neighbors = ["y2"]
    const out = validateMap(m)
    expect(out).toContainEqual({ kind: "empty-region", region: "z" })
    expect(out).toContainEqual({ kind: "region-size", region: "y", size: 3 })
  })

  it("catches a territory in a region that does not exist", () => {
    const m = good()
    m.territories[0]!.region = "ghost"
    expect(validateMap(m)).toContainEqual({
      kind: "unknown-region",
      id: "x1",
      region: "ghost",
    })
  })

  it("catches a region split into two pieces", () => {
    // Contiguity is what makes a region bonus a real objective. A region
    // in two halves is two separate conquests paying one bonus -- and selection
    // relies on whole regions being internally connected, so a split one
    // would let a selected board fail its own connectivity check.
    const m = good()
    m.territories.find((t) => t.id === "x2")!.neighbors = ["x1"]
    m.territories.find((t) => t.id === "x3")!.neighbors = ["x4"]
    expect(validateMap(m)).toContainEqual({ kind: "region-split", region: "x" })
  })

  it("catches a disconnected map", () => {
    const m = good()
    m.territories.find((t) => t.id === "x4")!.neighbors = ["x3"]
    m.territories.find((t) => t.id === "y1")!.neighbors = ["y2"]
    expect(validateMap(m)).toContainEqual({ kind: "disconnected", reachable: 4, total: 8 })
  })

  it("reports every problem at once, not just the first", () => {
    // A hand-authored world has several mistakes on its first pass, and fixing
    // them one run at a time is miserable.
    const m = good()
    m.territories[0]!.neighbors = ["x2", "nowhere"]
    m.territories[5]!.region = "ghost"
    expect(validateMap(m).length).toBeGreaterThan(1)
  })

  it("does not mutate the map it is given", () => {
    const m = good()
    const before = JSON.stringify(m)
    validateMap(m)
    expect(JSON.stringify(m)).toBe(before)
  })
})
