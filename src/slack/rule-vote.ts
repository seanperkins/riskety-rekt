import type { RuleOfferRow, RuleReactionRow, RuleVoteStore } from "../store/types.js"

/**
 * Derive the day's winning rule from RAW reaction rows, at the 21:00 tally.
 * Never stored — the frozen ctx.rules is the durable record of what won.
 *
 * The cutoff predicate is explicit and two-part: a row counts only if it is
 * present when the tick's transaction reads AND reacted_at <= tickInstant.
 * Both sides are ISO instants (slackTsToIso at write), so the comparison is
 * a plain string compare — a delayed tick must not count a 21:00:01 reaction
 * just because its webhook landed before the transaction began.
 */
export function tallyRuleVote(
  offers: RuleOfferRow[],
  reactions: RuleReactionRow[],
  tickInstantIso: string,
): string | undefined {
  const byOrdinal = new Map(offers.map((o) => [o.ordinal, o.ruleId]))

  // One vote per player: the latest still-present numeral inside the cutoff.
  // A same-instant tie breaks on the lower ordinal — Slack ts precision makes
  // it near-unreachable, but replay must be deterministic.
  const latest = new Map<string, { ordinal: number; reactedAt: string }>()
  for (const r of reactions) {
    if (r.reactedAt > tickInstantIso) continue
    if (!byOrdinal.has(r.ordinal)) continue
    const cur = latest.get(r.factionId)
    if (
      cur === undefined ||
      r.reactedAt > cur.reactedAt ||
      (r.reactedAt === cur.reactedAt && r.ordinal < cur.ordinal)
    ) {
      latest.set(r.factionId, { ordinal: r.ordinal, reactedAt: r.reactedAt })
    }
  }

  const counts = new Map<string, number>()
  for (const v of latest.values()) {
    const ruleId = byOrdinal.get(v.ordinal)!
    counts.set(ruleId, (counts.get(ruleId) ?? 0) + 1)
  }

  let winner: string | undefined
  let best = 0
  for (const [ruleId, n] of counts) {
    if (n > best || (n === best && winner !== undefined && ruleId < winner)) {
      winner = ruleId
      best = n
    }
  }
  return winner
}

/** What the tick freezes into ctx.rules: [] or [winner]. */
export function dailyRuleSelection(
  store: RuleVoteStore,
  seasonId: string,
  day: number,
  tickInstantIso: string,
): string[] {
  const offers = store.ruleOffersFor(seasonId, day)
  if (offers.length === 0) return []
  const winner = tallyRuleVote(offers, store.ruleReactionsFor(seasonId, day), tickInstantIso)
  return winner === undefined ? [] : [winner]
}
