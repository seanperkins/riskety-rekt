import {
  MAX_FACTIONS,
  MAX_TERRITORIES_PER_FACTION,
  MIN_FACTIONS,
  MIN_TERRITORIES_PER_FACTION,
} from "./config.js"
import { TICK_HOUR } from "./slack/config.js"
import { etDate, etDateAdd, etDaysBetween, etInstant } from "./time.js"
import type { SeasonRow } from "./store/types.js"

export type DealProblem =
  | { kind: "roster-size"; factions: number }
  | { kind: "too-few-territories"; perFaction: number }
  | { kind: "too-many-territories"; perFaction: number }

/**
 * The season day for an instant. THE single derivation — publish-slate,
 * dailyApprovals, the order writers and the tick all key off this.
 *
 * A second, state-derived clock ("highest saved day + 1") agrees with this one
 * only while no tick is ever missed. After one miss it shears permanently: the
 * tick runs a day behind the calendar forever, reading slates whose markets
 * settled the previous evening, with no catch-up and no alarm.
 */
export function currentDay(season: SeasonRow, now: Date): number {
  return etDaysBetween(season.startDate, etDate(now))
}

/**
 * The 21:00 America/New_York instant of a season day — the order deadline.
 *
 * Goes through `etInstant` rather than adding hours, so a season spanning a DST
 * transition still locks at 21:00 wall-clock on both sides of it.
 */
export function tickInstant(season: SeasonRow, day: number): Date {
  return etInstant(etDateAdd(season.startDate, day), TICK_HOUR)
}

/**
 * Whether a deal is playable. Two-sided on purpose.
 *
 * Upper: income is `max(5, floor(t/2))`, flat at 5 for t in [1, 11], so 11 is
 * exactly where a deal would start above the floor. Round-robin's largest
 * holding is `ceil(t/f)`, which is what the bound is applied to.
 *
 * Lower: 2–3 territories is 4–6 troops, eliminated by one focused attack, with
 * no continent reachable. Income does NOT distinguish 2.8 per faction from 7.0 —
 * both sit at the floor, and the design intends the deal to sit there — so the
 * lower bound is about survivability, not economy.
 */
export function checkDeal(factionCount: number, territoryCount: number): DealProblem | null {
  if (factionCount < MIN_FACTIONS || factionCount > MAX_FACTIONS) {
    return { kind: "roster-size", factions: factionCount }
  }
  const smallest = Math.floor(territoryCount / factionCount)
  const largest = Math.ceil(territoryCount / factionCount)
  if (smallest < MIN_TERRITORIES_PER_FACTION) {
    return { kind: "too-few-territories", perFaction: smallest }
  }
  if (largest > MAX_TERRITORIES_PER_FACTION) {
    return { kind: "too-many-territories", perFaction: largest }
  }
  return null
}
