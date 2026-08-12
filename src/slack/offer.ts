import { RECAP_NAME_MAX_CHARS } from "./config.js"
import { safeText } from "./text.js"
import type { Block } from "./recap.js"

const NUMERAL_NAMES = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]

const plain = (text: string) => ({ type: "plain_text" as const, text, emoji: true as const })

/**
 * The daily rule-vote offer: a numbered candidate list players vote on with
 * numeral reactions. `supersedes` marks a re-post after a crash — the copy
 * points players at the live message, because reactions on an orphaned
 * earlier post can never map to a row (the accepted claim-then-post window).
 *
 * All plain_text blocks: rule names and descriptions are in-tree constants,
 * but the sink still caps them, same as every other renderer.
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
  const lines = offers.map(
    (o) =>
      `:${NUMERAL_NAMES[o.ordinal - 1] ?? "hash"}: ${safeText(o.name, RECAP_NAME_MAX_CHARS)} — ${safeText(o.description, 120)}`,
  )
  blocks.push({ type: "section", text: plain(lines.join("\n")) })
  blocks.push({
    type: "context",
    elements: [
      plain(
        "React with the number to vote. Your latest reaction counts; remove it to un-vote. " +
          "Tally at 9pm ET — the winner applies to tonight's tick.",
      ),
    ],
  })
  return { text: safeText(`Day ${day} rule vote`, 200), blocks }
}
