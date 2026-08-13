import { DISPLAY_NAME_MAX_CHARS } from "./config.js"

/**
 * Roster identity: the faction id a new member gets, and what counts as a
 * usable display name.
 *
 * At the root rather than beside either caller. `factionIdFrom` began in
 * `src/jobs/roster-sync.ts`, which was fine while the operator's sync was the
 * only thing inventing ids — but `/login` now invents one too when somebody
 * joins themselves, and `src/slack` importing from `src/jobs` inverts the
 * layering. Both read from here instead, the same way both read `src/season.ts`
 * and `src/config.ts`.
 *
 * Pure, and it holds no I/O, so the store is free to be the only thing that
 * knows which ids are actually taken.
 */

/**
 * A faction id from a display name: lowercase, ASCII, hyphen-separated.
 *
 * Readable ids matter more than they look. The id is what appears in the tick
 * log, in a rejection event and in `roster:list`, so `sean` beats `f3` every
 * time somebody has to read one at 21:05.
 *
 * It is assigned ONCE, when a member joins. A later rename does not move it:
 * the id is written into every saved state and every log line, so following the
 * name would detach a player from their own history.
 */
export function factionIdFrom(displayName: string, taken: ReadonlySet<string>): string {
  const base =
    displayName
      .normalize("NFKD")
      // Strip combining marks, so "José" becomes "jose" rather than "jos".
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "player"
  if (!taken.has(base)) return base
  // Collisions are two people with the same display name, which is common
  // enough in a workspace that silently overwriting one would be a real bug.
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
}

export type NameResult =
  | { ok: true; name: string }
  | { ok: false; reason: "empty" | "too-long" }

/**
 * Clean a player-supplied display name, or say why it is not usable.
 *
 * Refuses rather than truncating. `safeText` truncates, and that is right for
 * a Kalshi question nobody typed — but a name is something a person just chose,
 * and silently storing a different one gives them no signal and no recourse.
 *
 * It deliberately does NOT escape anything. Escaping belongs at the sink: `esc`
 * for the HTML page, `safeText` for the Slack payload. Doing it here would
 * store a name different from the chosen one AND double-escape wherever the
 * sink already does its job.
 */
export function normalizeDisplayName(raw: string): NameResult {
  const cleaned = raw
    // Line breaks and tabs collapse to a space FIRST, so the control strip
    // below cannot run two words together with no gap.
    .replace(/[\t\r\n]+/g, " ")
    // Every remaining C0 and C1 control character, as \u escapes: a literal
    // control character in source is invisible in review.
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .replace(/ {2,}/g, " ")
    .trim()

  if (cleaned === "") return { ok: false, reason: "empty" }
  // Measured AFTER cleaning. Judging the raw string would refuse a padded name
  // for a length the player cannot see.
  if (cleaned.length > DISPLAY_NAME_MAX_CHARS) return { ok: false, reason: "too-long" }
  return { ok: true, name: cleaned }
}

/**
 * The same cleaning, but for a name NOBODY TYPED — a Slack profile read at join
 * time. Always returns something usable.
 *
 * The split from `normalizeDisplayName` is the same one `safeText` makes and for
 * the same reason. Refusing is right when a person just typed a name and can be
 * told to pick another; it is wrong here, because the only person who could act
 * on the refusal is not the one being told, and the alternative to a truncated
 * name is refusing to let them join at all.
 */
export function coerceDisplayName(raw: string, fallback: string): string {
  const cleaned = normalizeDisplayName(raw)
  if (cleaned.ok) return cleaned.name
  if (cleaned.reason === "empty") return fallback

  // Too long. Shrink by CODEPOINT — never by index, or the cut lands inside a
  // surrogate pair and leaves half an emoji in the database.
  //
  // One codepoint at a time rather than a single slice, because the cap counts
  // UTF-16 units (the unit `safeText` also counts, which is what keeps the two
  // caps comparable) and an emoji costs two of them. Slicing to the cap in
  // codepoints can therefore still be twice too long.
  const points = Array.from(raw)
  for (let n = Math.min(points.length, DISPLAY_NAME_MAX_CHARS); n > 0; n--) {
    const candidate = normalizeDisplayName(points.slice(0, n).join(""))
    if (candidate.ok) return candidate.name
  }
  return fallback
}
