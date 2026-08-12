import { irlModule } from "./irl.js"
import { marketsModule } from "./markets.js"
import { vetoModule } from "./veto.js"
import type { Mechanic } from "../mechanics.js"

export { marketIdsOf, marketsStateOf, pendingWagersOf } from "./markets.js"
export { irlModule, marketsModule, vetoModule }

export const MODULE_REGISTRY: Map<string, Mechanic> = new Map(
  [marketsModule, irlModule, vetoModule].map((m) => [m.id, m]),
)

export const DEFAULT_MODULES = ["markets", "irl", "veto"] as const
