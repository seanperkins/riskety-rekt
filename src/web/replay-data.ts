import { staticBoard, type StaticBoard } from "./projection-data.js"
import type { GameState, TickEvent } from "../engine/index.js"

/**
 * One animated moment. The narration is built HERE, not in the client.
 *
 * That placement is the point: the client is a template string with no type
 * checking over `TickEvent`, so a new event variant added to the engine would
 * simply never animate and nothing would say so. Narrating here puts the whole
 * log through an exhaustive switch, and `assertNever` turns that same omission
 * into a build failure. The client is left with nothing to decide — it animates
 * a `kind` it already understands, or ignores one it does not.
 */
export type Beat =
  | { kind: "deploy"; text: string; faction: string; territory: string; count: number }
  | { kind: "move"; text: string; faction: string; from: string; to: string; count: number }
  | { kind: "battle"; text: string; a: string; b: string }
  | { kind: "protect"; text: string; territory: string }
  | {
      kind: "attack"
      text: string
      attacker: string
      from: string
      to: string
      committed: number
      fee: number
      captured: boolean
      survivors: number
      defenderLost: number
    }
  | { kind: "note"; text: string }

/** Soldiers arriving. Collected rather than staged — see `replayFor`. */
export interface BankRow {
  faction: string
  text: string
}

/**
 * Everything the replay needs, and nothing the board needs.
 *
 * There is no viewer here on purpose: a night that has resolved is public — the
 * recap posts all of it to Slack — so there is nothing to filter per faction,
 * which is what makes this safe to build without a session. Compare
 * `Projection`, whose entire job is the opposite.
 *
 * `before` and `after` are both persisted states and the replay animates
 * BETWEEN them, recomputing nothing. The closing frame is `after` verbatim, so
 * arithmetic the animation gets wrong mid-flight is corrected by the end rather
 * than becoming a second, drifting implementation of the engine's bookkeeping.
 */
export interface Replay extends StaticBoard {
  seasonId: string
  day: number
  factions: { id: string; name: string; color: string }[]
  before: { ownership: Record<string, string>; garrisons: Record<string, number> }
  after: { ownership: Record<string, string>; garrisons: Record<string, number> }
  beats: Beat[]
  bank: BankRow[]
}

/** The markets are nobody's faction, so payouts bank under this. */
export const MARKETS = "—"

function assertNever(x: never): never {
  throw new Error(`unhandled tick event: ${JSON.stringify(x)}`)
}

export function replayFor(args: { before: GameState; after: GameState }): Replay {
  const { before, after } = args
  const fname = new Map(after.factions.map((f) => [f.id, f.playerName]))
  const tname = new Map(after.map.territories.map((t) => [t.id, t.name]))
  const who = (id: string) => fname.get(id) ?? id
  const where = (id: string) => tname.get(id) ?? id

  const beats: Beat[] = []
  const bank: BankRow[] = []

  for (const e of after.log) {
    switch (e.t) {
      // Income, workouts and settled wagers all land at the same instant and
      // change nothing on the map. Animating three of them in a row would be
      // three beats that look identical; they belong in one summary.
      case "income":
        bank.push({ faction: e.faction, text: `+${e.amount} income` })
        break
      case "irl":
        bank.push({ faction: e.faction, text: `+${e.actions + e.bonus} workout` })
        break
      case "grant":
        if (e.amount > 0) bank.push({ faction: e.faction, text: `+${e.amount} ${e.source}` })
        break
      case "wagerSettle":
        if (e.payout > 0) bank.push({ faction: MARKETS, text: `+${e.payout} from a market` })
        break

      case "deploy":
        beats.push({
          kind: "deploy",
          text: `${who(e.faction)} deploys ${e.count} to ${where(e.territory)}`,
          faction: e.faction,
          territory: e.territory,
          count: e.count,
        })
        break
      case "move":
        beats.push({
          kind: "move",
          text: `${who(e.faction)} reinforces ${where(e.to)} from ${where(e.from)} with ${e.count}`,
          faction: e.faction,
          from: e.from,
          to: e.to,
          count: e.count,
        })
        break
      case "fieldBattle":
        beats.push({
          kind: "battle",
          text: `${where(e.a)} and ${where(e.b)} meet in the field — ${e.aContinues} and ${e.bContinues} continue`,
          a: e.a,
          b: e.b,
        })
        break
      case "protected":
        beats.push({
          kind: "protect",
          text: `${where(e.territory)} is shielded — no attack can enter`,
          territory: e.territory,
        })
        break
      case "attack":
        beats.push({
          kind: "attack",
          text:
            `${who(e.attacker)} attacks ${where(e.to)} from ${where(e.from)} with ${e.committed} — ` +
            (e.captured ? `taken, ${e.survivors} hold it` : "repulsed"),
          attacker: e.attacker,
          from: e.from,
          to: e.to,
          committed: e.committed,
          fee: e.fee ?? 0,
          captured: e.captured,
          survivors: e.survivors,
          defenderLost: e.defenderLost,
        })
        break
      case "rejected":
        beats.push({ kind: "note", text: `Rejected — ${who(e.faction)}: ${e.reason}` })
        break
      default:
        // A new TickEvent variant fails the BUILD here, not the replay.
        assertNever(e)
    }
  }

  return {
    ...staticBoard(after.map),
    seasonId: after.seasonId,
    day: after.day,
    factions: after.factions.map((f) => ({ id: f.id, name: f.playerName, color: f.color })),
    before: { ownership: before.ownership, garrisons: before.garrisons },
    after: { ownership: after.ownership, garrisons: after.garrisons },
    beats,
    bank,
  }
}
