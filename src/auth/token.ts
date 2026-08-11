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
