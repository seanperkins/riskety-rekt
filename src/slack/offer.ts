import { RECAP_NAME_MAX_CHARS } from "./config.js"
import { safeText } from "./text.js"
import type { Block } from "./recap.js"
import { fallbackTable, table, tableLayout } from "./table.js"

/**
 * Ordinal → Slack emoji name. Shared with the offer job, which pre-seeds these
 * as reactions, and mirrored by `NUMERAL_EMOJI` in config.ts, which reads them
 * back at ingest.
 */
export const NUMERAL_NAMES = [
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
]

const plain = (text: string) => ({ type: "plain_text" as const, text, emoji: true as const })

/**
 * The daily rule-vote offer: a numbered candidate list players vote on with
 * numeral reactions. `supersedes` marks a re-post after a crash — the copy
 * points players at the live message, because reactions on an orphaned
 * earlier post can never map to a row (the accepted claim-then-post window).
 */
export function renderRuleOffer(
  day: number,
  offers: { ordinal: number; name: string; description: string }[],
  opts: { supersedes?: boolean } = {},
): { text: string; blocks: Block[] } {
  const blocks: Block[] = [{ type: "header", text: plain(`Day ${day} — vote on today's rule`) }]
  if (opts.supersedes === true) {
    blocks.push({ type: "context", elements: [plain("Replaces the offer above — vote here.")] })
  }
  const headers = ["#", "Rule", "What it does"]
  const rows = offers.map((o) => [
    String(o.ordinal),
    safeText(o.name, RECAP_NAME_MAX_CHARS),
    safeText(o.description, 120),
  ])
  const layout = tableLayout("Candidates", headers, rows)
  blocks.push(table("Candidates", headers, layout))
  blocks.push({
    type: "context",
    elements: [
      plain(
        "React with the number to vote. Your latest reaction counts; remove it to un-vote. " +
          "Tally at midnight ET — the winner applies to tonight's tick.",
      ),
    ],
  })
  return { text: fallbackTable("Candidates", headers, layout), blocks }
}
