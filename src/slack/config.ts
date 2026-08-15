/**
 * Reaction names that count as an approval, AFTER normalization by
 * `normalizeEmoji`. Slack sends `+1`, `thumbsup` and `+1::skin-tone-3` as three
 * distinct strings for what players see as one reaction.
 */
export const APPROVAL_EMOJI: ReadonlySet<string> = new Set(["+1"])

/**
 * Emoji aliases that mean the same reaction. Keys and values are both
 * post-skin-tone-strip. Slack's own alias table is much larger; this covers
 * only the approval reaction, because nothing else is read.
 */
export const EMOJI_ALIASES: Readonly<Record<string, string>> = {
  thumbsup: "+1",
  thumbsup_all: "+1",
  "+1": "+1",
}

/**
 * Numeral reactions on the daily rule offer — a vote is WHICH numeral you
 * picked. Keys are post-normalizeEmoji names; values are the offer ordinal.
 */
export const NUMERAL_EMOJI: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
}

// TICK_HOUR = 21 lived here until 2026-08-15. The order lock and approval
// cutoff are now the midnight ENDING a season day, which is a day offset
// rather than an hour-of-day -- see `tickInstant` in src/season.ts, the single
// derivation both now use. A `TICK_HOUR = 0` left here would read as midnight
// STARTING the day, which is the off-by-one that breaks the clock.

/**
 * Slack rejects a message with more than 50 blocks. The recap truncates rather
 * than failing to post: a partial recap beats no recap.
 */
export const MAX_RECAP_BLOCKS = 48

/**
 * Slack rejects a section whose text exceeds 3,000 characters. Lines inside a
 * section are capped so one busy day cannot fail the whole post.
 */
export const MAX_SECTION_CHARS = 2_900

/** Lines rendered inside a single recap section before it summarizes the rest. */
export const MAX_SECTION_LINES = 20

/** Player display names are player-supplied. Cap them like any other untrusted text. */
export const RECAP_NAME_MAX_CHARS = 40
