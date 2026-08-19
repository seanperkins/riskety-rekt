import { territoriesOf } from "../engine/index.js"
import { RULE_REGISTRY } from "../engine/rules/index.js"
import type { FactionId, GameState, TickEvent } from "../engine/index.js"
import {
  MAX_RECAP_BLOCKS,
  MAX_SECTION_CHARS,
  MAX_SECTION_LINES,
  RECAP_MARKET_MAX_CHARS,
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
  /**
   * Market question by id, for the Markets section.
   *
   * Not derivable inside the engine: a settling wager was placed on an EARLIER
   * day, so `ctx.slate` is the wrong slate, and carrying the question across
   * ticks in `moduleState` would inflate every frozen context to render one
   * line. The caller passes every question published this season instead —
   * `slate_markets` already stores them per (season, day, market), so one
   * DISTINCT read covers the day-1 settlement and the day-2 refund alike.
   *
   * Optional, falling back to the bare market id, which is what keeps the
   * fixtures and the simulator rendering without a store.
   */
  marketTitles?: Record<string, string>
}

/**
 * Minimal Block Kit shapes. Typed structurally rather than imported from
 * @slack/types so this file -- and its tests -- stay off the Bolt import graph.
 */
export type Block =
  | { type: "header"; text: { type: "plain_text"; text: string; emoji: true } }
  | { type: "divider" }
  | {
      type: "section"
      text:
        | { type: "plain_text"; text: string; emoji: true }
        | { type: "mrkdwn"; text: string }
    }
  | { type: "context"; elements: { type: "plain_text"; text: string; emoji: true }[] }

type TableRow = string[]

const plain = (text: string) => ({ type: "plain_text" as const, text, emoji: true as const })
const header = (text: string): Block => ({ type: "header", text: plain(text) })
const context = (lines: string[]): Block => ({ type: "context", elements: lines.map(plain) })

const wideCodePoint = (codePoint: number): boolean =>
  (codePoint >= 0x1100 && codePoint <= 0x115f) ||
  (codePoint >= 0x2329 && codePoint <= 0x232a) ||
  (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
  (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
  (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
  (codePoint >= 0xfe10 && codePoint <= 0xfe6f) ||
  (codePoint >= 0xff00 && codePoint <= 0xff60) ||
  (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
  (codePoint >= 0x1f000 && codePoint <= 0x1faff) ||
  (codePoint >= 0x2600 && codePoint <= 0x27ff)

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

function graphemes(value: string): string[] {
  return [...graphemeSegmenter.segment(value)].map((part) => part.segment)
}

function displayWidth(value: string): number {
  return graphemes(value).reduce(
    (width, grapheme) =>
      width + ([...grapheme].some((char) => wideCodePoint(char.codePointAt(0)!)) ? 2 : 1),
    0,
  )
}

function truncateCell(value: string, maxWidth = 200): string {
  if (displayWidth(value) <= maxWidth) return value
  let result = ""
  let width = 0
  for (const grapheme of graphemes(value)) {
    const nextWidth = displayWidth(grapheme)
    if (width + nextWidth > maxWidth - 1) break
    result += grapheme
    width += nextWidth
  }
  return `${result}…`
}

function tableText(title: string, headers: string[], rows: TableRow[], dropped: number): string {
  const shown = rows.map((row) => row.map((cell) => truncateCell(cell)))
  const allRows = [headers.map((cell) => truncateCell(cell)), ...shown]
  if (dropped > 0) allRows.push([`…and ${dropped} more`, ...headers.slice(1).map(() => "")])
  const widths = headers.map((_, column) =>
    Math.max(...allRows.map((row) => displayWidth(row[column] ?? ""))),
  )
  const lines = allRows.map((row) =>
    row
      .map((cell, column) => {
        const value = cell ?? ""
        return value + " ".repeat(Math.max(0, (widths[column] ?? 0) - displayWidth(value)))
      })
      .join("  ")
      .trimEnd(),
  )
  return `*${title}*\n\`\`\`\n${lines.join("\n")}\n\`\`\``
}

function table(title: string, headers: string[], rows: TableRow[]): Block {
  let shown = rows
  let dropped = 0
  const maxDataRows = Math.max(0, MAX_SECTION_LINES - 1)
  if (shown.length > maxDataRows) {
    shown = shown.slice(0, Math.max(0, maxDataRows - 1))
    dropped = rows.length - shown.length
  }
  let text = tableText(title, headers, shown, dropped)
  while (text.length > MAX_SECTION_CHARS && shown.length > 0) {
    shown = shown.slice(0, -1)
    dropped += 1
    text = tableText(title, headers, shown, dropped)
  }
  return { type: "section", text: { type: "mrkdwn", text } }
}

function fallbackTable(title: string, headers: string[], rows: TableRow[]): string {
  return [title, headers.join("  "), ...rows.map((row) => row.join("  "))].join("\n")
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
  const own = (m: Record<string, string> | undefined, k: string): string | undefined =>
    m !== undefined && Object.hasOwn(m, k) ? m[k] : undefined
  const nameOf = (id: FactionId): string => {
    const live = own(input.names, id)
    const f = state.factions.find((x) => x.id === id)
    return safeText(live ?? f?.playerName ?? id, RECAP_NAME_MAX_CHARS)
  }
  const marketOf = (id: string): string => {
    const q = own(input.marketTitles, id)
    return q === undefined
      ? safeText(id, RECAP_MARKET_MAX_CHARS)
      : `“${safeText(q, RECAP_MARKET_MAX_CHARS)}”`
  }
  const place = (id: string) => safeText(titleCase(id), RECAP_NAME_MAX_CHARS)
  const blocks: Block[] = [header(`Day ${state.day} of ${lengthDays}`)]
  const fallback: string[] = [`Riskety Rekt — day ${state.day} of ${lengthDays}`]
  const addTable = (title: string, headers: string[], rows: TableRow[]): void => {
    blocks.push(table(title, headers, rows))
    fallback.push(fallbackTable(title, headers, rows))
  }
  if (input.correction === true) {
    const correction = "Correction — this tick was re-run. It replaces the earlier recap."
    blocks.push(context([correction]))
    fallback.push(correction)
  }
  for (const id of input.ruleIds ?? []) {
    const r = RULE_REGISTRY.get(id)
    const label = r === undefined ? id : `${r.name} — ${r.description}`
    const line = safeText(`Rule in force: ${label}`, 200)
    blocks.push(context([line]))
    fallback.push(line)
  }

  const of = <T extends TickEvent["t"]>(t: T) =>
    state.log.filter((e): e is Extract<TickEvent, { t: T }> => e.t === t)
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
    addTable(
      "Reinforcements",
      ["Player", "Detail"],
      [...byFaction.keys()]
        .sort()
        .map((f) => [nameOf(f), byFaction.get(f)!.join(", ")]),
    )
  }

  const protections = of("protected")
  if (protections.length > 0) {
    addTable(
      "Protected",
      ["Territory", "Vetos"],
      protections.map((e) => [
        place(e.territory),
        `${e.byCount} veto${e.byCount === 1 ? "" : "es"}`,
      ]),
    )
  }
  const movesEv = of("move")
  if (movesEv.length > 0) {
    addTable(
      "Movements",
      ["Player", "From", "To", "Troops"],
      movesEv.map((e) => [nameOf(e.faction), place(e.from), place(e.to), `${e.count}`]),
    )
  }
  const field = of("fieldBattle")
  if (field.length > 0) {
    addTable(
      "Field battles",
      ["Battle"],
      field.map((e) => [
        `${place(e.a)} ↔ ${place(e.b)} — ${e.aContinues} and ${e.bContinues} continued on`,
      ]),
    )
  }
  const attacks = of("attack")
  if (attacks.length > 0) {
    addTable(
      "Battles",
      ["Player", "Detail"],
      attacks.map((e) => {
        const owner = previous.ownership[e.to]
        const detail = e.captured
          ? `took ${place(e.to)}${owner === undefined ? "" : ` (${nameOf(owner)})`} from ${place(e.from)} — ${e.committed} sent, ${e.survivors} held it`
          : `failed against ${place(e.to)}${owner === undefined ? "" : ` (${nameOf(owner)})`} — ${e.committed} sent, ${e.survivors} came back`
        return [nameOf(e.attacker), detail]
      }),
    )
  }
  const settles = of("wagerSettle")
  if (settles.length > 0) {
    addTable(
      "Markets",
      ["Player", "Detail"],
      settles.map((e) => {
        if (e.faction === undefined || e.marketId === undefined) {
          const id = safeText(e.wagerId, RECAP_NAME_MAX_CHARS)
          return [
            id,
            e.outcome === "unsettled"
              ? `never called, ${e.stake} refunded`
              : e.payout > 0
                ? `resolved ${e.outcome} — paid ${e.payout}`
                : `resolved ${e.outcome} — lost`,
          ]
        }
        const who = nameOf(e.faction)
        const what = marketOf(e.marketId)
        if (e.outcome === "unsettled") {
          return [who, `nobody ever called ${what} — your ${e.stake} came home, no worse off.`]
        }
        if (e.payout > 0) {
          return [who, `you wagered ${e.stake} on ${what} — you won. ${e.payout} soldiers report for duty.`]
        }
        return [
          who,
          `you wagered ${e.stake} on ${what} — you lost. Those soldiers are working it off in the mines.`,
        ]
      }),
    )
  }
  const rejections = of("rejected")
  if (rejections.length > 0) {
    addTable(
      "Rejected orders",
      ["Player", "Field: reason"],
      rejections.map((e) => [
        nameOf(e.faction),
        `${safeText(e.field, 40)}: ${safeText(e.reason, 80)}`,
      ]),
    )
  }

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
  addTable(
    "Standings",
    ["Player", "Territories", "Reserve"],
    standings.map((s) => {
      const delta = s.count - s.was
      const move = delta === 0 ? "" : delta > 0 ? ` (+${delta})` : ` (${delta})`
      const dead = s.count === 0 ? " — eliminated" : ""
      return [s.name, `${s.count}${move}`, `${s.reserve}${dead}`]
    }),
  )
  if (state.day >= lengthDays) {
    const top = standings[0]!
    const tied = standings.filter((s) => s.count === top.count && s.reserve === top.reserve)
    const result =
      tied.length > 1
        ? `The season is a draw between ${tied.map((s) => s.name).join(" and ")}.`
        : `${top.name} wins the season with ${top.count} territories.`
    addTable("Season result", ["Outcome"], [[result]])
  }
  if (blocks.length === 1) addTable("A quiet day. No orders resolved.", ["Status"], [["—"]])

  const capped =
    blocks.length > MAX_RECAP_BLOCKS
      ? [...blocks.slice(0, MAX_RECAP_BLOCKS - 1), context(["Recap truncated — see the web app."])]
      : blocks
  return { text: fallback.join("\n"), blocks: capped }
}
