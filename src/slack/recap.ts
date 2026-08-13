import { territoriesOf } from "../engine/index.js"
import { RULE_REGISTRY } from "../engine/rules/index.js"
import type { FactionId, GameState, TickEvent } from "../engine/index.js"
import {
  MAX_RECAP_BLOCKS,
  MAX_SECTION_CHARS,
  MAX_SECTION_LINES,
  RECAP_NAME_MAX_CHARS,
} from "./config.js"
import { safeText } from "./text.js"

export interface RecapInput {
  /** The post-tick state, day N. */
  state: GameState
  /** Day N-1, for standings movement. */
  previous: GameState
  lengthDays: number
  /** A rerun. Marked visibly rather than posted as a silent second recap. */
  correction?: boolean
  /**
   * The day's winning rule ids, from the frozen tick_context. Rendered with
   * name and description — the user-visible record of why the day resolved
   * the way it did (a Truce day's recap says why no attacks landed).
   */
  ruleIds?: string[]
  /**
   * Display names by faction id, read from the roster when the recap is built.
   *
   * The name is NOT taken from the state any more. `createSeason` copies it in
   * at the deal and it never changes there, so a player who renamed themselves
   * mid-season would keep appearing under the old name for the rest of it.
   *
   * Optional, and it falls back to the state's own copy. That is what keeps the
   * simulator and every existing fixture working: neither has a roster, and
   * neither should need one to render a recap.
   */
  names?: Record<FactionId, string>
}

/**
 * Minimal Block Kit shapes. Typed structurally rather than imported from
 * @slack/types so this file -- and its tests -- stay off the Bolt import graph.
 */
export type Block =
  | { type: "header"; text: { type: "plain_text"; text: string; emoji: true } }
  | { type: "divider" }
  | { type: "section"; text: { type: "plain_text"; text: string; emoji: true } }
  | { type: "context"; elements: { type: "plain_text"; text: string; emoji: true }[] }

const plain = (text: string) => ({ type: "plain_text" as const, text, emoji: true as const })
const header = (text: string): Block => ({ type: "header", text: plain(text) })
const context = (lines: string[]): Block => ({ type: "context", elements: lines.map(plain) })

/**
 * A titled section, truncated to fit Slack's limits.
 *
 * Both caps announce themselves. A recap that silently dropped half the day's
 * battles would read exactly like a quiet day.
 */
function section(title: string, lines: string[]): Block {
  let shown = lines
  let dropped = lines.length - shown.length
  if (shown.length > MAX_SECTION_LINES) {
    dropped = shown.length - MAX_SECTION_LINES
    shown = shown.slice(0, MAX_SECTION_LINES)
  }
  let text = [title, ...shown].join("\n")
  while (text.length > MAX_SECTION_CHARS && shown.length > 0) {
    shown = shown.slice(0, -1)
    dropped += 1
    text = [title, ...shown].join("\n")
  }
  if (dropped > 0) text = `${text}\n…and ${dropped} more`
  return { type: "section", text: plain(text) }
}

/** "eastern_united_states" -> "Eastern United States". */
function titleCase(id: string): string {
  return id
    .split("_")
    .map((w) => (w.length === 0 ? w : w[0]!.toUpperCase() + w.slice(1)))
    .join(" ")
}

export function renderRecap(input: RecapInput): { text: string; blocks: Block[] } {
  const { state, previous, lengthDays } = input

  const nameOf = (id: FactionId): string => {
    // Roster first, then the state's frozen copy, then the bare id.
    const live = input.names?.[id]
    const f = state.factions.find((x) => x.id === id)
    return safeText(live ?? f?.playerName ?? id, RECAP_NAME_MAX_CHARS)
  }
  const place = (id: string) => safeText(titleCase(id), RECAP_NAME_MAX_CHARS)

  const blocks: Block[] = [header(`Day ${state.day} of ${lengthDays}`)]
  if (input.correction === true) {
    blocks.push(context(["Correction — this tick was re-run. It replaces the earlier recap."]))
  }
  for (const id of input.ruleIds ?? []) {
    // An id the registry no longer knows renders as the bare id — frozen
    // history must outlive a catalogue edit, not crash the recap.
    const r = RULE_REGISTRY.get(id)
    const label = r === undefined ? id : `${r.name} — ${r.description}`
    blocks.push(context([safeText(`Rule in force: ${label}`, 200)]))
  }

  const of = <T extends TickEvent["t"]>(t: T) =>
    state.log.filter((e): e is Extract<TickEvent, { t: T }> => e.t === t)

  // Reinforcements: income, IRL, and generic mechanic grants, one line per
  // faction. A grant names its source so a doubled-income day reads as the
  // rule that caused it, not as ordinary income.
  const income = of("income")
  const irl = of("irl")
  const grants = of("grant").filter((e) => e.amount > 0)
  if (income.length > 0 || irl.length > 0 || grants.length > 0) {
    const byFaction = new Map<FactionId, string[]>()
    for (const e of income) {
      byFaction.set(e.faction, [...(byFaction.get(e.faction) ?? []), `+${e.amount} income`])
    }
    for (const e of irl) {
      const bonus = e.bonus > 0 ? ` +${e.bonus} timing` : ""
      byFaction.set(e.faction, [
        ...(byFaction.get(e.faction) ?? []),
        `+${e.actions} workout${e.actions === 1 ? "" : "s"}${bonus}`,
      ])
    }
    for (const e of grants) {
      byFaction.set(e.faction, [...(byFaction.get(e.faction) ?? []), `+${e.amount} (${e.source})`])
    }
    const lines = [...byFaction.keys()]
      .sort()
      .map((f) => `${nameOf(f)}: ${byFaction.get(f)!.join(", ")}`)
    blocks.push(section("Reinforcements", lines))
  }

  // Picks are secret until now. This is the reveal.
  const protections = of("protected")
  if (protections.length > 0) {
    blocks.push(
      section(
        "Protected",
        protections.map(
          (e) => `${place(e.territory)} — held by ${e.byCount} veto${e.byCount === 1 ? "" : "es"}`,
        ),
      ),
    )
  }

  const movesEv = of("move")
  if (movesEv.length > 0) {
    blocks.push(
      section(
        "Movements",
        movesEv.map((e) => `${nameOf(e.faction)} moved ${e.count} from ${place(e.from)} to ${place(e.to)}`),
      ),
    )
  }

  const field = of("fieldBattle")
  if (field.length > 0) {
    blocks.push(
      section(
        "Field battles",
        field.map(
          (e) => `${place(e.a)} ↔ ${place(e.b)} — ${e.aContinues} and ${e.bContinues} continued on`,
        ),
      ),
    )
  }

  const attacks = of("attack")
  if (attacks.length > 0) {
    blocks.push(
      section(
        "Battles",
        attacks.map((e) =>
          e.captured
            ? `${nameOf(e.attacker)} took ${place(e.to)} from ${place(e.from)} — ${e.committed} sent, ${e.survivors} held it`
            : `${nameOf(e.attacker)} failed against ${place(e.to)} — ${e.committed} sent, ${e.survivors} came back`,
        ),
      ),
    )
  }

  const settles = of("wagerSettle")
  if (settles.length > 0) {
    blocks.push(
      section(
        "Markets",
        settles.map((e) =>
          e.payout > 0
            ? `${safeText(e.wagerId, RECAP_NAME_MAX_CHARS)} resolved ${e.outcome} — paid ${e.payout}`
            : `${safeText(e.wagerId, RECAP_NAME_MAX_CHARS)} resolved ${e.outcome} — lost`,
        ),
      ),
    )
  }

  // Always surfaced. Silent validation is how a validator bug survives a season.
  const rejections = of("rejected")
  if (rejections.length > 0) {
    blocks.push(
      section(
        "Rejected orders",
        rejections.map(
          (e) => `${nameOf(e.faction)} — ${safeText(e.field, 40)}: ${safeText(e.reason, 80)}`,
        ),
      ),
    )
  }

  // Standings, with movement against yesterday.
  blocks.push({ type: "divider" })
  const standings = state.factions
    .map((f) => ({
      id: f.id,
      name: nameOf(f.id),
      count: territoriesOf(state, f.id).length,
      was: territoriesOf(previous, f.id).length,
      reserve: state.reserves[f.id] ?? 0,
    }))
    .sort((a, b) => b.count - a.count || b.reserve - a.reserve || (a.id < b.id ? -1 : 1))

  blocks.push(
    section(
      "Standings",
      standings.map((s) => {
        const delta = s.count - s.was
        const move = delta === 0 ? "" : delta > 0 ? ` (+${delta})` : ` (${delta})`
        const dead = s.count === 0 ? " — eliminated" : ""
        return `${s.name}: ${s.count} territories${move}, ${s.reserve} in reserve${dead}`
      }),
    ),
  )

  if (state.day >= lengthDays) {
    const top = standings[0]!
    const tied = standings.filter((s) => s.count === top.count && s.reserve === top.reserve)
    blocks.push(
      section(
        tied.length > 1
          ? `The season is a draw between ${tied.map((s) => s.name).join(" and ")}.`
          : `${top.name} wins the season with ${top.count} territories.`,
        [],
      ),
    )
  }

  if (blocks.length === 1) blocks.push(section("A quiet day. No orders resolved.", []))

  // Slack rejects more than 50 blocks. A truncated recap beats no recap.
  const capped =
    blocks.length > MAX_RECAP_BLOCKS
      ? [...blocks.slice(0, MAX_RECAP_BLOCKS - 1), context(["Recap truncated — see the web app."])]
      : blocks

  return {
    text: safeText(`Riskety Rekt — day ${state.day} of ${lengthDays}`, 200),
    blocks: capped,
  }
}
