import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { slackTsToIso } from "../time.js"
import { openStore } from "./sqlite.js"

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "rr-rule-votes-"))
  dirs.push(dir)
  return { path: join(dir, "riskety.db"), store: openStore(join(dir, "riskety.db")) }
}

describe("rule offers", () => {
  it("claims the day's draw with message_ts NULL, ordinals 1..n, and the seed", () => {
    const { store } = freshStore()
    store.claimRuleOffers("s1", 3, ["boom", "truce", "attrition"], "4711")
    expect(store.ruleOffersFor("s1", 3)).toEqual([
      { ruleId: "boom", ordinal: 1, seed: "4711", messageTs: null },
      { ruleId: "truce", ordinal: 2, seed: "4711", messageTs: null },
      { ruleId: "attrition", ordinal: 3, seed: "4711", messageTs: null },
    ])
    store.close()
  })

  it("refuses an unknown rule id and writes nothing — the catalogue-validation security claim", () => {
    const { store } = freshStore()
    expect(() => store.claimRuleOffers("s1", 3, ["boom", "ghost"], "1")).toThrow(/unknown rule/)
    expect(store.ruleOffersFor("s1", 3)).toEqual([])
    store.close()
  })

  it("records the posted message ts on every row, and maps the ts back to the day", () => {
    const { store } = freshStore()
    store.claimRuleOffers("s1", 3, ["boom", "truce"], "1")
    store.recordOfferMessage("s1", 3, "1756758000.000100")
    expect(store.ruleOffersFor("s1", 3).every((o) => o.messageTs === "1756758000.000100")).toBe(
      true,
    )
    expect(store.offerForMessage("1756758000.000100")).toEqual({
      seasonId: "s1",
      day: 3,
      ordinals: [1, 2],
    })
    expect(store.offerForMessage("999.000")).toBeUndefined()
    store.close()
  })
})

describe("rule reactions", () => {
  it("stores reacted_at through slackTsToIso", () => {
    const { store } = freshStore()
    store.recordRuleReaction({
      seasonId: "s1",
      day: 3,
      factionId: "f1",
      ordinal: 2,
      reactedAt: "1756758000.000100",
    })
    expect(store.ruleReactionsFor("s1", 3)).toEqual([
      { factionId: "f1", ordinal: 2, reactedAt: slackTsToIso("1756758000.000100") },
    ])
    store.close()
  })

  it("re-adding the same numeral REWRITES the timestamp — latest wins, unlike approvals", () => {
    const { store } = freshStore()
    const base = { seasonId: "s1", day: 3, factionId: "f1", ordinal: 2 }
    store.recordRuleReaction({ ...base, reactedAt: "1756758000.000100" })
    store.recordRuleReaction({ ...base, reactedAt: "1756759999.000500" })
    expect(store.ruleReactionsFor("s1", 3)).toEqual([
      { factionId: "f1", ordinal: 2, reactedAt: slackTsToIso("1756759999.000500") },
    ])
    store.close()
  })

  it("removal deletes exactly the named row", () => {
    const { store } = freshStore()
    store.recordRuleReaction({
      seasonId: "s1", day: 3, factionId: "f1", ordinal: 1, reactedAt: "1756758000.000100",
    })
    store.recordRuleReaction({
      seasonId: "s1", day: 3, factionId: "f1", ordinal: 2, reactedAt: "1756758001.000100",
    })
    store.removeRuleReaction("s1", 3, "f1", 2)
    expect(store.ruleReactionsFor("s1", 3)).toEqual([
      { factionId: "f1", ordinal: 1, reactedAt: slackTsToIso("1756758000.000100") },
    ])
    store.close()
  })
})

describe("migration", () => {
  it("is idempotent across reopen and the tables survive", () => {
    const { path, store } = freshStore()
    store.claimRuleOffers("s1", 1, ["boom"], "1")
    store.close()
    const reopened = openStore(path)
    expect(reopened.ruleOffersFor("s1", 1)).toHaveLength(1)
    reopened.close()
  })
})
