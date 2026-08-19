import { MARKET_QUESTION_MAX, QUESTION_MAX_CHARS, TIMEZONE } from "../config.js"
import type { Market } from "../engine/index.js"
import type { Block } from "./recap.js"
import { fallbackTable, table, tableLayout, truncateCell } from "./table.js"
import { safeText } from "./text.js"

const plain = (text: string) => ({ type: "plain_text" as const, text, emoji: true as const })

const CLOSE_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: TIMEZONE,
  hour: "numeric",
  minute: "2-digit",
})

/**
 * The 08:00 slate post. Prices are shown as whole cents, the way Kalshi quotes
 * them.
 *
 * Each market's own close time is shown because wagers lock per-market at that
 * close, not at midnight — players cannot plan around a window they cannot see.
 */
export function renderSlate(day: number, slate: Market[]): { text: string; blocks: Block[] } {
  const blocks: Block[] = [{ type: "header", text: plain(`Day ${day} — today's markets`) }]

  if (slate.length === 0) {
    blocks.push({
      type: "section",
      text: plain("No markets cleared the filters today. The day runs as plain Risk."),
    })
    return { text: `Day ${day} — no markets today`, blocks }
  }

  const headers = ["Market", "YES", "NO", "LOCK"]
  const rows = slate.map((m) => [
    truncateCell(safeText(m.question, QUESTION_MAX_CHARS), MARKET_QUESTION_MAX),
    `${Math.round(m.priceYes * 100)}¢`,
    `${Math.round(m.priceNo * 100)}¢`,
    CLOSE_FMT.format(new Date(m.closeTime)),
  ])
  const layout = tableLayout("Today's markets", headers, rows)
  blocks.push(table("Today's markets", headers, layout))
  blocks.push({
    type: "context",
    elements: [
      plain("One wager per market. Wagers lock at each market's own close, not at midnight."),
    ],
  })

  return { text: fallbackTable("Today's markets", headers, layout), blocks }
}
