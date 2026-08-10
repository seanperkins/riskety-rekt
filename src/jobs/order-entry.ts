import { SLATE_MAX } from "../config.js"
import type { OrderBody, WagerInput } from "../store/types.js"

/**
 * Parsing and shape-checking for the two entry commands.
 *
 * Neither command takes the body as a shell argument. `npm run X -- args`
 * composes a string executed by `sh`, and both the order body and the market id
 * are third-party text — a Kalshi ticker reaches `slate_markets.market_id`, is
 * rendered into the Slack slate, and is then copy-pasted onto a command line by
 * an operator. Ingest validates the ticker now (`^[A-Za-z0-9._-]{1,64}$`); this
 * side simply never puts it through a shell.
 *
 * These functions check SHAPE, not game rules. The engine owns the rules, and
 * its rejections surface publicly in the recap.
 */

export class ParseError extends Error {}

const bad = (why: string): never => {
  throw new ParseError(why)
}

const isCount = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n)

function object(raw: unknown, what: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return bad(`${what} must be a JSON object`)
  }
  return raw as Record<string, unknown>
}

/**
 * Unknown fields are rejected rather than ignored. A typo'd `"protects"` that
 * parsed as "no protect" would silently drop the one order a player cannot
 * resubmit after 21:00.
 */
function only(obj: Record<string, unknown>, allowed: string[], what: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      bad(`${what}: unknown field "${key}" (expected ${allowed.join(", ")})`)
    }
  }
}

function array(raw: unknown, what: string, cap: number): unknown[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) return bad(`${what} must be an array`)
  // orders.body is unbounded TEXT and flows straight into tick_context.orders,
  // so an uncapped array is a storage amplifier as well as a recap flood.
  if (raw.length > cap) bad(`${what} has ${raw.length} entries; the cap is ${cap}`)
  return raw
}

export interface ParseOrderOptions {
  /** The season map's territory count — the cap for deploys and attacks. */
  territoryCount: number
}

export function parseOrderBody(json: string, opts: ParseOrderOptions): OrderBody {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch (err) {
    return bad(`not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  const obj = object(raw, "order")
  only(obj, ["deploys", "attacks", "protect"], "order")

  const deploys = array(obj["deploys"], "deploys", opts.territoryCount).map((d, i) => {
    const e = object(d, `deploys[${i}]`)
    only(e, ["territory", "count"], `deploys[${i}]`)
    if (typeof e["territory"] !== "string" || e["territory"] === "") {
      bad(`deploys[${i}].territory must be a non-empty string`)
    }
    if (!isCount(e["count"])) bad(`deploys[${i}].count must be an integer`)
    return { territory: e["territory"] as string, count: e["count"] as number }
  })

  const attacks = array(obj["attacks"], "attacks", opts.territoryCount).map((a, i) => {
    const e = object(a, `attacks[${i}]`)
    only(e, ["from", "to", "count"], `attacks[${i}]`)
    for (const key of ["from", "to"]) {
      if (typeof e[key] !== "string" || e[key] === "") {
        bad(`attacks[${i}].${key} must be a non-empty string`)
      }
    }
    if (!isCount(e["count"])) bad(`attacks[${i}].count must be an integer`)
    return { from: e["from"] as string, to: e["to"] as string, count: e["count"] as number }
  })

  const protectRaw = obj["protect"]
  if (protectRaw !== undefined && protectRaw !== null && typeof protectRaw !== "string") {
    bad("protect must be a territory id or null")
  }
  const protect = typeof protectRaw === "string" && protectRaw !== "" ? protectRaw : null

  return { deploys, attacks, protect }
}

/**
 * One wager, or a `{ wagers: [...] }` batch capped at SLATE_MAX — a faction
 * cannot legally have more open wagers than the slate has markets.
 */
export function parseWagers(json: string): WagerInput[] {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch (err) {
    return bad(`not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  const obj = object(raw, "wager")
  const list = Array.isArray(obj["wagers"]) ? obj["wagers"] : [raw]
  if (Array.isArray(obj["wagers"])) only(obj, ["wagers"], "wager")
  array(list, "wagers", SLATE_MAX)

  return list.map((w, i) => {
    const e = object(w, `wagers[${i}]`)
    only(e, ["marketId", "side", "stake"], `wagers[${i}]`)
    if (typeof e["marketId"] !== "string" || e["marketId"] === "") {
      bad(`wagers[${i}].marketId must be a non-empty string`)
    }
    if (e["side"] !== "yes" && e["side"] !== "no") bad(`wagers[${i}].side must be "yes" or "no"`)
    if (!isCount(e["stake"]) || (e["stake"] as number) <= 0) {
      bad(`wagers[${i}].stake must be a positive integer`)
    }
    return {
      marketId: e["marketId"] as string,
      side: e["side"] as "yes" | "no",
      stake: e["stake"] as number,
    }
  })
}
