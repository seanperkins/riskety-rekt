import { RULE_REGISTRY, eligibleRules } from "../engine/rules/index.js"
import { makeRng, shuffle } from "../rng.js"
import { etDate, etDaysBetween } from "../time.js"
import { renderRuleOffer } from "../slack/offer.js"
import type { Poster } from "../slack/post.js"
import type { RuleVoteStore, SeasonStore, Transactional } from "../store/types.js"

/**
 * Ballot size.
 *
 * Three, not "every eligible rule". With a thirteen-rule catalogue and eight
 * players a nine-option ballot decides most days by one or two votes with ties
 * falling to the lowest rule id, and truncates the remaining rules away
 * entirely — they would never appear. Three against ~8 voters produces real
 * pluralities, keeps the Slack message readable, and makes scarcity its own
 * strategic event.
 *
 * It is also the balance lever: each rule then wins roughly 1/13 of days
 * rather than 1/3, diluting any single rule's contribution to the catalogue's
 * measured swing.
 */
export const RULES_PER_OFFER = 3

export type PublishRulesSkipReason =
  | "before-season"
  | "after-season"
  | "already-posted"
  | "no-candidates"

export type PublishRulesOutcome =
  | { status: "posted"; day: number; ruleIds: string[] }
  /** Rows claimed but nothing posted (no Slack token). A later run posts. */
  | { status: "claimed"; day: number; ruleIds: string[] }
  | { status: "skipped"; day: number; reason: PublishRulesSkipReason }

export interface PublishRulesDeps {
  store: SeasonStore & RuleVoteStore & Transactional
  seasonId: string
  /** Injected: the job holds no clock of its own, so tests can pin the day. */
  now: Date
  /** Optional, same concession postRecapFor makes for an unconfigured workspace. */
  poster?: Poster
  log?: (msg: string) => void
}

/**
 * The 08:05 job: draw the day's rule candidates, claim them, post the offer.
 *
 * Claim-then-post, the recap ledger's pattern. The guarantee, stated honestly
 * (spec, "Voting"): a crash BEFORE the post replays cleanly — the next run
 * finds claimed rows with message_ts NULL and posts them. A crash AFTER the
 * post but before recordOfferMessage orphans that message: its ts exists
 * nowhere, its reactions can never map to a row, and they are lost by
 * construction — one systemd retry wide, accepted rather than papered over.
 * The re-post marks supersession so players move to the live message.
 *
 * Rules apply to the SAME day's tick, so the final day IS offered — unlike
 * the slate, whose wagers would settle at a tick that never runs. A late-day
 * run still posts; votes after the tick instant never count, so the worst
 * case is a wasted message. Judge this job by an 08:05 run.
 */
export async function runPublishRules(deps: PublishRulesDeps): Promise<PublishRulesOutcome> {
  const { store, seasonId, now } = deps
  const log = deps.log ?? (() => {})

  const season = store.season(seasonId)
  if (season === undefined) throw new Error(`publish-rules: unknown season ${seasonId}`)

  const day = etDaysBetween(season.startDate, etDate(now))
  if (day < 1) return { status: "skipped", day, reason: "before-season" }
  if (day > season.lengthDays) return { status: "skipped", day, reason: "after-season" }

  let offers = store.ruleOffersFor(seasonId, day)
  const recovering = offers.length > 0 && offers.every((o) => o.messageTs === null)
  if (offers.length > 0 && !recovering) {
    return { status: "skipped", day, reason: "already-posted" }
  }

  if (!recovering) {
    const modules = season.modules ?? ["markets", "irl", "veto"]
    const eligible = eligibleRules(modules)
    if (eligible.length === 0) return { status: "skipped", day, reason: "no-candidates" }
    // Deterministic and auditable: the seed derives from the season seed and
    // the day, and is stored on every offer row.
    const seedNum = ((season.seed ?? 0) ^ (day * 0x9e3779b9)) >>> 0
    const draw = shuffle([...eligible], makeRng(seedNum)).slice(0, RULES_PER_OFFER)
    store.claimRuleOffers(
      seasonId,
      day,
      draw.map((r) => r.id),
      String(seedNum),
    )
    offers = store.ruleOffersFor(seasonId, day)
    log(`day ${day}: offering ${draw.map((r) => r.id).join(", ")} (seed ${seedNum})`)
  }

  const ruleIds = offers.map((o) => o.ruleId)
  if (deps.poster === undefined) {
    log(`day ${day}: offer claimed; no Slack token, so nothing was posted`)
    return { status: "claimed", day, ruleIds }
  }

  const message = renderRuleOffer(
    day,
    offers.map((o) => {
      const r = RULE_REGISTRY.get(o.ruleId)!
      return { ordinal: o.ordinal, name: r.name, description: r.description }
    }),
    { ...(recovering ? { supersedes: true } : {}) },
  )
  const ts = await deps.poster.post(message)
  if (ts !== undefined) store.recordOfferMessage(seasonId, day, ts)
  log(`day ${day}: rule offer posted${ts === undefined ? " (no ts returned)" : ""}`)
  return { status: "posted", day, ruleIds }
}
