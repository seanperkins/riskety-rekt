import { describe, expect, it } from "vitest"
import { PRICE_CEIL, PRICE_FLOOR } from "./engine/index.js"
import { PRICE_MAX, PRICE_MIN, SLATE_MAX, SLATE_MIN, VOLUME_FLOOR } from "./config.js"

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

  it("has a volume floor above zero", () => {
    // The observed median same-day volume is 0.00; a zero floor admits the
    // ~75% of markets that never trade.
    expect(VOLUME_FLOOR).toBeGreaterThan(0)
  })
})
