import { cmp } from "./sort.js"
import type {
  DailyContext,
  FactionId,
  GameState,
  Order,
  TerritoryId,
  TickEvent,
} from "./types.js"

export type ModuleId = string

/**
 * A module's cross-tick state, opaque to the engine. Must survive a JSON
 * round-trip — the store asserts that on every save, because a value that
 * stringifies lossily (undefined, cycles) would corrupt the season silently.
 */
export type ModuleStateValue = unknown

export interface Contribution {
  faction: FactionId
  /** Engine-validated: a non-negative integer. A bad value refuses the tick. */
  amount: number
  /** Logged verbatim when the grant lands. */
  event: TickEvent
}

/**
 * A claim against a faction's reserve, honored in ascending order of the
 * PARSED lockedAt instant — never string order, which inverts against
 * non-ISO fixtures and offset-form instants.
 *
 * `event` is logged only when the claim is honored, and only if present:
 * a deploy logs its `deploy` event; wager escrow is silent (the pending list
 * is the record), exactly as it is today. That is why SpendClaim does not
 * extend Contribution — TS cannot widen a required field to optional.
 */
export interface SpendClaim {
  faction: FactionId
  amount: number
  /** When this commitment became irrevocable, as an ISO instant. */
  lockedAt: string
  /** Identifies the order item this claim funds, for the rejection log. */
  ref: string
  event?: TickEvent
}

export interface LockResult {
  territory: TerritoryId
  /**
   * Logged by the engine when the lock lands. Optional deliberately: the
   * veto supplies `protected` events with parity counts; a rule locking the
   * whole map supplies none rather than burying the log.
   */
  event?: TickEvent
}

export interface CombatDials {
  /** Extra troops lost per attack MOVEMENT at departure. Clamped 0–2. */
  attackDepartureCost: number
}

/**
 * The dial clamp is not what protects the garrison floor — the in-cap charge
 * does that for any cost. What it bounds is who can act at all: a 1-troop
 * attack needs `1 + k <= g - 1`, so k = 2 puts the minimum acting garrison
 * at 4. Larger and most border garrisons freeze outright.
 */
export const MAX_DEPARTURE_COST = 2

export interface Mechanic {
  id: ModuleId

  /** Step 1: soldiers into a faction's reserve (incl. settlement payouts). */
  grant?(state: GameState, ctx: DailyContext): Contribution[]
  /** Step 2: claims against reserves, resolved in step 3's allocation. */
  spend?(state: GameState, orders: Order[], ctx: DailyContext): SpendClaim[]
  /** Order-shape rules this mechanic owns, run alongside core checks. */
  validate?(state: GameState, order: Order, ctx: DailyContext): TickEvent[]
  /** Step 4: territories no attack may enter this tick. */
  lock?(state: GameState, orders: Order[], ctx: DailyContext): LockResult[]
  /** Step 6: the one bounded combat dial. */
  combatDials?(state: GameState, ctx: DailyContext): Partial<CombatDials>
  /**
   * Step 7: returns this module's complete next state value, which REPLACES
   * `moduleState[id]`. Receives the validated orders and the subset of ITS
   * OWN claims that were honored — without those it cannot append escrow.
   * A mechanic that implements `advance` MUST also implement `escrowed`;
   * the registry refuses otherwise, because the one-sided conservation
   * check passes silently when escrowed soldiers go uncounted.
   */
  advance?(
    state: GameState,
    orders: Order[],
    ctx: DailyContext,
    honored: SpendClaim[],
  ): ModuleStateValue
  /** Soldiers currently sitting in this module's escrow, from its own state. */
  escrowed?(own: ModuleStateValue): number
}

export type RuleId = string

/**
 * A rule is a mechanic with a one-day lifetime, display fields for the vote
 * and the recap, and a narrow offer filter. `needs` is a DISPLAY-side filter —
 * the daily draw skips rules whose modules are off, so the vote can never
 * select a rule the engine would refuse — not a dependency system.
 */
export interface Rule extends Mechanic {
  id: RuleId
  /** Shown in the vote offer and the recap. */
  name: string
  /** One line; every render sink caps and escapes it itself. */
  description: string
  /** Modules this rule's OFFER requires. Checked at catalogue load. */
  needs?: ModuleId[]
}

/**
 * Engine-internal: a claim tagged with the mechanic that returned it. The tag
 * is applied by the engine as it collects hook results — never asserted by
 * the claim itself — and drives both the tie-break and the routing of honored
 * claims back to their owner's `advance`. Core deploys carry "" so they sort
 * first at an equal instant (unreachable in production; the slate publisher
 * guarantees strictly-earlier closes).
 */
export interface OwnedClaim extends SpendClaim {
  mechanicId: string
  index: number
}

export function parseInstant(s: string): number {
  const ms = Date.parse(s)
  if (!Number.isFinite(ms)) {
    throw new Error(`lockedAt does not parse as an instant: ${JSON.stringify(s)}`)
  }
  return ms
}

export function sortClaims(claims: OwnedClaim[]): OwnedClaim[] {
  return [...claims].sort(
    (a, b) =>
      parseInstant(a.lockedAt) - parseInstant(b.lockedAt) ||
      cmp(a.mechanicId, b.mechanicId) ||
      a.index - b.index,
  )
}

export function checkContribution(
  c: { faction: FactionId; amount: number },
  factions: ReadonlySet<string>,
): void {
  if (!Number.isSafeInteger(c.amount) || c.amount < 0) {
    throw new Error(`mechanic returned a bad amount ${c.amount} for ${c.faction}`)
  }
  if (!factions.has(c.faction)) {
    throw new Error(`mechanic returned a claim for unknown faction ${c.faction}`)
  }
}
