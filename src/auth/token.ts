import { createHash, randomBytes } from "node:crypto"

/**
 * A login or session token: 32 random bytes, base64url.
 *
 * base64url because the token goes in a path segment of a link that gets pasted
 * into Slack — `+` and `/` from plain base64 would need escaping and would
 * survive it badly.
 */
export function newToken(): string {
  return randomBytes(32).toString("base64url")
}

/**
 * SHA-256, hex.
 *
 * Tokens are stored hashed for the same reason passwords are: the database sits
 * on the same droplet as the app, and if it leaks, hashed tokens grant no
 * logins. No salt and no work factor on purpose — this is a 32-byte random
 * value, not a human-chosen secret, so there is nothing to brute-force and
 * nothing a rainbow table can precompute.
 *
 * Lookups are BY hash against a primary key, never a comparison, so no
 * constant-time compare is needed.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

/**
 * How many login links a person may hold at once. Minting the sixth evicts the
 * oldest.
 *
 * A cap rather than exactly one, because exactly one has a sharp edge: running
 * `/login` twice before clicking either — or an operator minting a link on
 * someone's behalf — silently kills the link the player is about to use, and
 * the failure surfaces as a generic "that link is no longer good". What bounds
 * the real exposure is the 10-minute TTL and single use, both unchanged. The
 * cap only stops the table growing without bound.
 */
export const MAX_LIVE_TOKENS = 5
