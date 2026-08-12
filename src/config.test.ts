import { describe, expect, it } from "vitest"
import { PRICE_CEIL, PRICE_FLOOR } from "./engine/index.js"
import {
  MAX_FACTIONS,
  MAX_TERRITORIES_PER_FACTION,
  MIN_FACTIONS,
  MIN_TERRITORIES_PER_FACTION,
  PRICE_MAX,
  PRICE_MIN,
  SLATE_MAX,
  SLATE_MIN,
  VOLUME_FLOOR,
  WINDOW_CLOSE_HOUR,
} from "./config.js"
import { TICK_HOUR } from "./slack/config.js"
import { PALETTE } from "./jobs/season-init.js"

describe("config", () => {
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

  it("pins the slate close window to the tick hour", () => {
    // Two constants in two modules, and their equality is load-bearing for
    // claim seniority: the publisher rejects markets closing at or after
    // WINDOW_CLOSE_HOUR, which is what guarantees every wager claim's
    // lockedAt is strictly earlier than a deploy's tickInstant. Raising
    // WINDOW_CLOSE_HOUR past TICK_HOUR would silently reopen the
    // deploy-inflation exploit for late-closing markets.
    expect(WINDOW_CLOSE_HOUR).toBe(TICK_HOUR)
  })
})
