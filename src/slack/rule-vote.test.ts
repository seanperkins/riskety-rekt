import { describe, expect, it } from "vitest"
import { tallyRuleVote } from "./rule-vote.js"
import type { RuleOfferRow, RuleReactionRow } from "../store/types.js"

const TICK = "2026-09-01T21:00:00.000Z"
const offers: RuleOfferRow[] = [
  { ruleId: "boom", ordinal: 1, seed: "7", messageTs: "111.000" },
  { ruleId: "truce", ordinal: 2, seed: "7", messageTs: "111.000" },
  { ruleId: "attrition", ordinal: 3, seed: "7", messageTs: "111.000" },
]
const rx = (factionId: string, ordinal: number, reactedAt: string): RuleReactionRow => ({
  factionId,
  ordinal,
  reactedAt,
})

describe("tallyRuleVote", () => {
  it("a player's vote is their latest still-present numeral", () => {
    const r = [rx("f1", 1, "2026-09-01T10:00:00.000Z"), rx("f1", 2, "2026-09-01T12:00:00.000Z")]
    expect(tallyRuleVote(offers, r, TICK)).toBe("truce")
  })

  it("removal un-votes and an earlier still-present numeral resurrects", () => {
    // The 12:00 row was deleted (reaction_removed) — only the 10:00 row remains.
    expect(tallyRuleVote(offers, [rx("f1", 1, "2026-09-01T10:00:00.000Z")], TICK)).toBe("boom")
  })

  it("re-add records the new timestamp and outranks an intermediate vote", () => {
    // f1 voted 2 at 11:00, then re-added 1 at 13:00 (the upsert rewrote 1's row).
    const r = [rx("f1", 1, "2026-09-01T13:00:00.000Z"), rx("f1", 2, "2026-09-01T11:00:00.000Z")]
    expect(tallyRuleVote(offers, r, TICK)).toBe("boom")
  })

  it("the delayed-tick regression: a reaction after 21:00 never counts, even if stored", () => {
    // The 21:00:01 row is PRESENT (a late tick's transaction read it) — the
    // cutoff predicate excludes it; f1's earlier vote stands.
    const r = [rx("f1", 1, "2026-09-01T20:59:00.000Z"), rx("f1", 2, "2026-09-01T21:00:01.000Z")]
    expect(tallyRuleVote(offers, r, TICK)).toBe("boom")
  })

  it("one vote per player; plurality wins", () => {
    const r = [
      rx("f1", 2, "2026-09-01T10:00:00.000Z"),
      rx("f2", 2, "2026-09-01T10:01:00.000Z"),
      rx("f3", 1, "2026-09-01T10:02:00.000Z"),
    ]
    expect(tallyRuleVote(offers, r, TICK)).toBe("truce")
  })

  it("ties break on the LOWEST rule id", () => {
    const r = [
      rx("f1", 2, "2026-09-01T10:00:00.000Z"), // truce
      rx("f2", 3, "2026-09-01T10:01:00.000Z"), // attrition
    ]
    expect(tallyRuleVote(offers, r, TICK)).toBe("attrition")
  })

  it("no votes selects nothing", () => {
    expect(tallyRuleVote(offers, [], TICK)).toBeUndefined()
  })

  it("a reaction on an ordinal with no offer row is ignored (defense in depth)", () => {
    expect(tallyRuleVote(offers, [rx("f1", 9, "2026-09-01T10:00:00.000Z")], TICK)).toBeUndefined()
  })

  it("a same-instant pair for one faction breaks on the lower ordinal, deterministically", () => {
    const t = "2026-09-01T10:00:00.000Z"
    expect(tallyRuleVote(offers, [rx("f1", 3, t), rx("f1", 2, t)], TICK)).toBe("truce")
  })
})
