/**
 * Make third-party or player-supplied text safe for a Slack payload and short
 * enough for the layout.
 *
 * Market questions come from Kalshi and display names from players. Block Kit
 * `plain_text` does not parse mrkdwn, so this is belt and braces -- but the
 * message's fallback `text` field is not plain_text, and that is where an
 * unescaped <!channel> would ping the workspace every single day.
 */
export function safeText(value: string, max: number): string {
  const cleaned = value
    // Line breaks and tabs collapse to a single space FIRST. The control-char
    // strip below would otherwise delete them outright and run two lines
    // together with no gap: "squat\n3x5" would render as "squat3x5".
    .replace(/[\t\r\n]+/g, " ")
    // Every remaining C0 and C1 control character. Written as \u escapes on
    // purpose: a literal control character in source is invisible in review and
    // survives every subsequent reading of the file.
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    // Look-alikes rather than HTML entities: Slack renders plain_text
    // literally, so "&lt;" would show up as those four characters.
    .replace(/</g, "‹")
    .replace(/>/g, "›")
    .replace(/ {2,}/g, " ")
    .trim()

  if (cleaned === "") return "—"
  if (cleaned.length <= max) return cleaned
  return `${cleaned.slice(0, max - 1)}…`
}
