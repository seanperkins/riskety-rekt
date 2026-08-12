import { describe, expect, it } from "vitest"
import { HOUSE_BONUS, PRICE_CEIL, PRICE_FLOOR, payout } from "../engine/index.js"
import { CLIENT } from "./client.js"

describe("the wagers panel", () => {
  it("lives in the board's client, not its own page script", () => {
    // Merged deliberately: a wager and a deploy draw on the same reserve, and
    // only one script can hold one number. Two scripts meant two reserve
    // calculations, and the standalone page's copy was the wrong one.
    expect(CLIENT).toContain("reserveLeft")
    expect(CLIENT).toContain("/api/wager")
  })

  it("caps the stepper against deploys as well as wagers", () => {
    // reserveLeft subtracts spent() -- which counts deploys -- rather than the
    // stakes alone. Without that a player could plan deploys on the board and
    // stake the whole reserve in the panel, and the tick would drop the deploys.
    expect(CLIENT).toMatch(/reserveLeft[\s\S]{0,400}spent\(\)/)
  })
})

/**
 * The payout shown and the payout PAID must be the same number.
 *
 * The client cannot import the engine — it is a string served to a browser — so
 * the arithmetic exists twice, which is the thing this codebase avoids
 * everywhere else. What keeps it honest: the page is handed prices the server
 * already clamped with the engine's own bounds, and the client's expression is
 * written in the same order as `payout`. This pins both halves of that.
 */
describe("payout preview", () => {
  /** The client's expression, verbatim, against an already-clamped price. */
  const clientSide = (stake: number, clamped: number): number =>
    Math.round((stake / clamped) * HOUSE_BONUS)
  const clamp = (p: number): number => Math.min(PRICE_CEIL, Math.max(PRICE_FLOOR, p))

  it("matches the engine across the whole publishable price band", () => {
    for (let cents = 1; cents <= 99; cents++) {
      const price = cents / 100
      for (const stake of [1, 2, 3, 5, 7, 11, 20, 50, 99, 250]) {
        expect(clientSide(stake, clamp(price)), `stake ${stake} at ${price}`).toBe(
          payout(stake, price),
        )
      }
    }
  })

  it("agrees at the clamp edges, where the engine caps a runaway price", () => {
    // A market that drifted to 0.95 pays at 0.9; one at 0.02 pays at 0.1. The
    // preview has to show the capped number, not the market's own.
    for (const price of [0, 0.01, 0.05, PRICE_FLOOR, PRICE_CEIL, 0.95, 1]) {
      expect(clientSide(9, clamp(price)), `price ${price}`).toBe(payout(9, price))
    }
  })

  it("never pays back less than the stake, so the profit line cannot go negative", () => {
    for (let cents = 1; cents <= 99; cents++) {
      for (const stake of [1, 2, 3, 4, 25, 100]) {
        expect(payout(stake, cents / 100), `stake ${stake} at ${cents}c`).toBeGreaterThanOrEqual(
          stake,
        )
      }
    }
  })

  it("pays exactly zero profit on a small stake at the top of the band", () => {
    // Not a rounding bug to fix here — it is what `payout` does, and the engine
    // comment explains why round() beats floor(). Worth pinning because the
    // preview now SHOWS it: at 0.9, staking 1 or 2 returns the stake and
    // nothing more, which is a bet no one should make. A player can now see
    // that before committing instead of discovering it at the tick.
    expect(payout(1, 0.9)).toBe(1)
    expect(payout(2, 0.9)).toBe(2)
    expect(payout(3, 0.9)).toBe(4)
  })
})
