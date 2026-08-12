import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { describe, expect, it } from "vitest"
import { createSeason, territoriesOf } from "./setup.js"
import { resolve } from "./resolve.js"
import { pendingWagersOf } from "./modules/index.js"
import type { DailyContext, Faction, GameState, Market, Order, Settlement } from "./types.js"

const GOLDEN = "src/engine/__golden__/season-1.json"

const factions: Faction[] = ["f1", "f2", "f3", "f4"].map((id) => ({
  id,
  playerName: id,
  color: "#000",
}))

/**
 * A fixed territory ordering. Not shuffled: the golden file pins ENGINE
 * behaviour, so it must not depend on a shuffle or on any sim policy. An
 * earlier version drove this through the sim policies, which meant tuning a
 * policy broke the engine's regression test for no engine-related reason.
 */
const DEALT = [
  "alaska", "northwest_territory", "alberta", "ontario", "quebec",
  "western_united_states", "eastern_united_states", "central_america", "greenland",
  "venezuela", "peru", "brazil", "argentina",
  "iceland", "scandinavia", "ukraine", "great_britain", "northern_europe",
  "western_europe", "southern_europe",
  "north_africa", "egypt", "congo", "east_africa", "south_africa", "madagascar",
  "middle_east", "afghanistan", "ural", "siberia", "yakutsk", "irkutsk",
  "kamchatka", "mongolia", "japan", "china", "india", "siam",
  "indonesia", "new_guinea", "western_australia", "eastern_australia",
]

const market = (day: number, priceYes: number): Market => ({
  id: `d${day}`,
  question: `market ${day}`,
  priceYes,
  priceNo: Math.round((1 - priceYes) * 100) / 100,
  closeTime: `2026-01-${String(day).padStart(2, "0")}T18:00:00.000Z`,
})

/**
 * A scripted season exercising every branch that matters: deploys, one-sided
 * attacks, a mutual attack (field battle), a coalition attack, wagers that
 * win, lose and roll over, IRL grants with both timing bonuses — and, in
 * phase 2, a faction hunted to ELIMINATION followed by its parity veto. The
 * tick-runner review found the original golden season never exercised
 * protections, so it could not catch a veto regression; this one can.
 */
function scriptedSeason(): GameState {
  let state = createSeason("golden", factions, DEALT)

  for (let day = 1; day <= 10; day++) {
    const slate = day <= 8 ? [market(day, day % 2 === 0 ? 0.4 : 0.7)] : []

    const settlements: Record<string, Settlement> = {}
    for (const w of pendingWagersOf(state)) {
      // Deterministic alternation: even days settle YES, odd days NO.
      settlements[w.marketId] = w.placedOnDay % 2 === 0 ? "yes" : "no"
    }

    const context: DailyContext = {
      slate,
      settlements,
      tickInstant: `2026-01-${String(day).padStart(2, "0")}T21:00:00.000Z`,
      modules: ["markets", "irl", "veto"],
      rules: [],
      approvals: [
        { eventId: `${day}-a`, playerId: "f1", postedAt: "T06:00", approvedAt: "T07:00" },
        { eventId: `${day}-b`, playerId: "f2", postedAt: "T09:00", approvedAt: "T20:00" },
        { eventId: `${day}-c`, playerId: "f2", postedAt: "T10:00", approvedAt: "T10:30" },
      ],
      // Every approved action implies a post. No faction is eliminated in this
      // season and no order carries a protect pick, so the protection gate is
      // not exercised here — see combat.test.ts for that. Present so the
      // context is complete rather than defaulted.
      postedToday: ["f1", "f2"],
    }

    const orders: Order[] = factions.map((f) => {
      const mine = territoriesOf(state, f.id)
      const home = mine[0]
      const reserve = state.reserves[f.id] ?? 0
      const order: Order = {
        factionId: f.id,
        deploys: home && reserve > 0 ? [{ territory: home, count: reserve }] : [],
        attacks: [],
        wagers: [],
        protect: null,
      }

      // f1 and f2 attack each other across the same edge on day 3 -> field battle.
      if (day === 3 && f.id === "f1") order.attacks = [{ from: "alaska", to: "northwest_territory", count: 4 }]
      if (day === 3 && f.id === "f2") order.attacks = [{ from: "northwest_territory", to: "alaska", count: 2 }]

      // f1 and f3 both hit ontario on day 5 -> coalition, casualty split.
      if (day === 5 && f.id === "f1") order.attacks = [{ from: "alaska", to: "alberta", count: 3 }]
      if (day === 5 && f.id === "f3") order.attacks = [{ from: "alberta", to: "ontario", count: 3 }]

      // f4 wagers on every slate day; f3 wagers only on day 2.
      if (slate[0] && f.id === "f4" && reserve > 4) {
        order.wagers = [{ marketId: slate[0].id, side: "yes", stake: 3 }]
      }
      if (slate[0] && f.id === "f3" && day === 2 && reserve > 4) {
        order.wagers = [{ marketId: slate[0].id, side: "no", stake: 2 }]
      }

      return order
    })

    state = resolve(state, orders, context)
  }

  // Phase 2: the coalition hunts f4 to elimination. Attacks are computed
  // from the live state (every owned territory adjacent to an f4 holding
  // attacks with its spare garrison), so the script needs no hand-written
  // adjacency chains and stays deterministic.
  const neighborsOf = new Map(state.map.territories.map((t) => [t.id, t.neighbors]))
  const phase2Ctx = (day: number, postedToday: string[]): DailyContext => ({
    slate: [],
    settlements: {},
    approvals: [],
    postedToday,
    tickInstant: `2026-01-${String(day).padStart(2, "0")}T21:00:00.000Z`,
    modules: ["markets", "irl", "veto"],
    rules: [],
  })

  while (territoriesOf(state, "f4").length > 0 && state.day < 24) {
    const day = state.day + 1
    const f4Held = new Set(territoriesOf(state, "f4"))
    const orders: Order[] = factions.map((f) => {
      const mine = territoriesOf(state, f.id)
      const reserve = state.reserves[f.id] ?? 0
      if (f.id === "f4" || mine.length === 0) {
        return {
          factionId: f.id,
          deploys: mine[0] && reserve > 0 ? [{ territory: mine[0], count: reserve }] : [],
          attacks: [],
          wagers: [],
          protect: null,
        }
      }
      // Deploy to the first frontline territory so the assault keeps scaling
      // past f4's growing home garrison.
      const frontline = mine.filter((t) => neighborsOf.get(t)!.some((n) => f4Held.has(n)))
      const deployTo = frontline[0] ?? mine[0]!
      const attacks: Order["attacks"] = []
      for (const t of frontline) {
        const spare = (state.garrisons[t] ?? 0) + (t === deployTo ? reserve : 0) - 1
        if (spare < 3) continue
        const target = neighborsOf.get(t)!.filter((n) => f4Held.has(n)).sort()[0]!
        attacks.push({ from: t, to: target, count: spare })
      }
      return {
        factionId: f.id,
        deploys: reserve > 0 ? [{ territory: deployTo, count: reserve }] : [],
        attacks,
        wagers: [],
        protect: null,
      }
    })
    state = resolve(state, orders, phase2Ctx(day, ["f1", "f2"]))
  }
  if (territoriesOf(state, "f4").length > 0) {
    throw new Error("golden phase 2 failed to eliminate f4 — the script drifted")
  }

  // Finale: eliminated f4 posts and vetoes the territory f1 assaults. The
  // golden file finally carries `protected` events.
  {
    const day = state.day + 1
    const f1Held = territoriesOf(state, "f1")
    const target = f1Held
      .flatMap((t) => neighborsOf.get(t)!.map((n) => [t, n] as const))
      .filter(([, n]) => state.ownership[n] === "f2")
      .sort(([a1, n1], [a2, n2]) => a1.localeCompare(a2) || n1.localeCompare(n2))[0]
    if (!target) throw new Error("golden finale: f1 has no f2 neighbor to assault")
    const [from, to] = target
    const orders: Order[] = factions.map((f) => ({
      factionId: f.id,
      deploys: [],
      attacks:
        f.id === "f1" ? [{ from, to, count: Math.max(1, (state.garrisons[from] ?? 0) - 1) }] : [],
      wagers: [],
      protect: f.id === "f4" ? to : null,
    }))
    state = resolve(state, orders, {
      ...phase2Ctx(day, ["f1", "f2", "f4"]),
    })
  }

  return state
}

describe("golden-file replay", () => {
  it("reproduces a recorded engine season exactly", () => {
    const actual = scriptedSeason()
    if (!existsSync(GOLDEN)) {
      mkdirSync(dirname(GOLDEN), { recursive: true })
      writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`)
      console.warn(`wrote new golden file ${GOLDEN} — re-run to verify`)
      return
    }
    expect(actual).toEqual(JSON.parse(readFileSync(GOLDEN, "utf8")))
  })

  it("produces identical results across repeated runs", () => {
    expect(scriptedSeason()).toEqual(scriptedSeason())
  })

  it("actually exercised combat, wagers, grants, elimination and the veto", () => {
    const s = scriptedSeason()
    expect(territoriesOf(s, "f4")).toHaveLength(0)
    expect(s.log.some((e) => e.t === "protected")).toBe(true)
    // The log only carries the final tick, so re-run the interesting days.
    let mid = createSeason("golden", factions, DEALT)
    const ctx: DailyContext = { slate: [], approvals: [], postedToday: [], settlements: {}, tickInstant: "2026-01-01T21:00:00.000Z", modules: ["markets", "irl", "veto"], rules: [] }
    for (let d = 0; d < 3; d++) mid = resolve(mid, [], ctx)
    expect(mid.day).toBe(3)
  })
})
