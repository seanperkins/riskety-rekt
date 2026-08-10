import { describe, expect, it } from "vitest"
import { SLATE_MAX } from "../config.js"
import { ParseError, parseOrderBody, parseWagers } from "./order-entry.js"

const opts = { territoryCount: 42 }
const order = (o: unknown) => parseOrderBody(JSON.stringify(o), opts)

describe("parseOrderBody", () => {
  it("parses a full body", () => {
    expect(
      order({
        deploys: [{ territory: "alaska", count: 3 }],
        attacks: [{ from: "alaska", to: "alberta", count: 2 }],
        protect: "peru",
      }),
    ).toEqual({
      deploys: [{ territory: "alaska", count: 3 }],
      attacks: [{ from: "alaska", to: "alberta", count: 2 }],
      protect: "peru",
    })
  })

  it("fills in absent arrays and a null protect", () => {
    expect(order({})).toEqual({ deploys: [], attacks: [], protect: null })
  })

  it("rejects an unknown field rather than ignoring it", () => {
    // A typo'd "protects" that parsed as "no protect" would silently drop the
    // one order a player cannot resubmit after 21:00.
    expect(() => order({ protects: "peru" })).toThrow(/unknown field "protects"/)
    expect(() => order({ deploys: [{ territory: "a", count: 1, extra: 1 }] })).toThrow(
      /unknown field "extra"/,
    )
  })

  it("caps deploys and attacks at the map's territory count", () => {
    // orders.body is unbounded TEXT and flows straight into
    // tick_context.orders, so an uncapped array is a storage amplifier as well
    // as a recap flood.
    const many = Array.from({ length: 43 }, () => ({ territory: "alaska", count: 1 }))
    expect(() => order({ deploys: many })).toThrow(/cap is 42/)
    expect(() => order({ deploys: many.slice(0, 42) })).not.toThrow()
  })

  it("rejects a non-integer or missing count", () => {
    expect(() => order({ deploys: [{ territory: "a", count: 1.5 }] })).toThrow(/must be an integer/)
    expect(() => order({ deploys: [{ territory: "a" }] })).toThrow(/must be an integer/)
    expect(() => order({ attacks: [{ from: "a", to: "b", count: "3" }] })).toThrow(
      /must be an integer/,
    )
  })

  it("rejects a non-string territory", () => {
    expect(() => order({ deploys: [{ territory: 7, count: 1 }] })).toThrow(/non-empty string/)
    expect(() => order({ attacks: [{ from: "a", to: "", count: 1 }] })).toThrow(/non-empty string/)
  })

  it("rejects a body that is not an object, and invalid JSON", () => {
    expect(() => parseOrderBody("[]", opts)).toThrow(/must be a JSON object/)
    expect(() => parseOrderBody("null", opts)).toThrow(/must be a JSON object/)
    expect(() => parseOrderBody("{oops", opts)).toThrow(ParseError)
    expect(() => parseOrderBody("{oops", opts)).toThrow(/not valid JSON/)
  })

  it("normalises an empty-string protect to null", () => {
    expect(order({ protect: "" }).protect).toBeNull()
    expect(order({ protect: null }).protect).toBeNull()
    expect(() => order({ protect: 7 })).toThrow(/territory id or null/)
  })

  it("does not validate game rules", () => {
    // The engine owns those, and its rejections surface publicly in the recap.
    // A deploy of 9,999 onto a territory you do not own parses fine here.
    expect(order({ deploys: [{ territory: "not-a-place", count: 9999 }] }).deploys).toHaveLength(1)
  })
})

describe("parseWagers", () => {
  it("parses a single wager", () => {
    expect(parseWagers('{"marketId":"KX-1","side":"yes","stake":5}')).toEqual([
      { marketId: "KX-1", side: "yes", stake: 5 },
    ])
  })

  it("parses a batch", () => {
    expect(
      parseWagers(JSON.stringify({ wagers: [{ marketId: "KX-1", side: "no", stake: 2 }] })),
    ).toEqual([{ marketId: "KX-1", side: "no", stake: 2 }])
  })

  it("caps a batch at SLATE_MAX", () => {
    // A faction cannot legally have more open wagers than the slate has markets.
    const many = Array.from({ length: SLATE_MAX + 1 }, (_, i) => ({
      marketId: `KX-${i}`,
      side: "yes",
      stake: 1,
    }))
    expect(() => parseWagers(JSON.stringify({ wagers: many }))).toThrow(
      new RegExp(`cap is ${SLATE_MAX}`),
    )
  })

  it("rejects a bad side, a bad stake and an unknown field", () => {
    expect(() => parseWagers('{"marketId":"KX-1","side":"maybe","stake":5}')).toThrow(/"yes"/)
    expect(() => parseWagers('{"marketId":"KX-1","side":"yes","stake":0}')).toThrow(
      /positive integer/,
    )
    expect(() => parseWagers('{"marketId":"KX-1","side":"yes","stake":1.5}')).toThrow(
      /positive integer/,
    )
    expect(() => parseWagers('{"marketId":"KX-1","side":"yes","stake":5,"x":1}')).toThrow(
      /unknown field "x"/,
    )
  })

  it("rejects an empty market id", () => {
    expect(() => parseWagers('{"marketId":"","side":"yes","stake":5}')).toThrow(/non-empty string/)
  })
})
