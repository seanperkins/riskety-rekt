import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { PRICE_CEIL, PRICE_FLOOR } from "./engine/index.js"
import { RULE_CATALOGUE } from "./engine/rules/index.js"
import {
  MAX_FACTIONS,
  MAX_TERRITORIES_PER_FACTION,
  MIN_FACTIONS,
  MIN_TERRITORIES_PER_FACTION,
  PRICE_MAX,
  PRICE_MIN,
  RULES_PER_OFFER,
  SLATE_MAX,
  SLATE_MIN,
  VOLUME_FLOOR,
  WINDOW_CLOSE_HOUR,
} from "./config.js"
import { PALETTE } from "./jobs/season-init.js"

describe("config", () => {
  it("draws the same ballot in the simulator as in the season", () => {
    // The sim's voted arm and the offer job must slice the catalogue to the
    // SAME size. Each rule's share of days is the catalogue's main balance
    // lever, so a sim offering nine while production offers three measures a
    // game nobody plays — and the gate would clear a catalogue on a dilution
    // the season never applies. Both read this one constant; this pins that
    // they do, and that it is small enough to matter against the catalogue.
    expect(RULES_PER_OFFER).toBeGreaterThan(0)
    expect(RULES_PER_OFFER).toBeLessThan(RULE_CATALOGUE.length)
    for (const src of [
      readFileSync("src/sim/run.ts", "utf8"),
      readFileSync("src/jobs/publish-rules.ts", "utf8"),
    ]) {
      expect(src).toContain("RULES_PER_OFFER")
      // Neither may re-hardcode a slice width beside the shared constant.
      expect(src).not.toMatch(/\.slice\(0,\s*\d+\)/)
    }
  })

  it("keeps the slate price band identical to the engine payout clamp", () => {
    // If these drift, a market is published at a price the engine clamps away,
    // and a player's payout silently stops matching the odds they were shown.
    expect(PRICE_MIN).toBe(PRICE_FLOOR)
    expect(PRICE_MAX).toBe(PRICE_CEIL)
  })

  it("has a sane slate size", () => {
    expect(SLATE_MIN).toBeGreaterThan(0)
    expect(SLATE_MAX).toBeGreaterThanOrEqual(SLATE_MIN)
  })

  it("has one palette color per faction the roster bounds allow", () => {
    // A roster larger than the palette deals a board where two factions share a
    // color, and the only place that shows is the map -- which the web app has
    // not been built yet, so nothing else would catch it.
    expect(PALETTE).toHaveLength(MAX_FACTIONS)
    expect(new Set(PALETTE).size).toBe(PALETTE.length)
  })

  it("keeps the faction bounds ordered and the territory bounds satisfiable", () => {
    expect(MIN_FACTIONS).toBeLessThanOrEqual(MAX_FACTIONS)
    expect(MIN_TERRITORIES_PER_FACTION).toBeLessThanOrEqual(MAX_TERRITORIES_PER_FACTION)
  })

  it("has a volume floor above zero", () => {
    // The observed median same-day volume is 0.00; a zero floor admits the
    // ~75% of markets that never trade.
    expect(VOLUME_FLOOR).toBeGreaterThan(0)
  })

  it("keeps the slate close window strictly inside the season day", () => {
    // Load-bearing for claim seniority: the publisher rejects markets closing
    // at or after WINDOW_CLOSE_HOUR, which is what guarantees every wager
    // claim's lockedAt is strictly earlier than a deploy's tickInstant.
    //
    // This was `toBe(TICK_HOUR)` while the tick ran at 21:00. The boundary is
    // now the midnight ENDING the day -- hour 24 of it -- so equality is the
    // wrong shape and only the inequality was ever the point. Raising this to
    // 24 would let a market close exactly at the boundary and silently reopen
    // the deploy-inflation exploit for late-closing markets.
    expect(WINDOW_CLOSE_HOUR).toBeGreaterThan(0)
    expect(WINDOW_CLOSE_HOUR).toBeLessThan(24)
  })
})
