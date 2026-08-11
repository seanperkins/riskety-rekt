import { hashToken } from "../auth/token.js"
import type { FactionId } from "../engine/index.js"
import type { AuthStore } from "../store/types.js"

export const SESSION_COOKIE = "rr_session"

/**
 * Parse a Cookie header.
 *
 * Splits each pair on the FIRST `=` only: a value containing `=` must survive
 * intact, because silently truncating a credential is a miserable bug to find.
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (header === undefined || header === "") return out
  for (const part of header.split(";")) {
    const eq = part.indexOf("=")
    if (eq === -1) continue
    const name = part.slice(0, eq).trim()
    if (name === "") continue
    try {
      out[name] = decodeURIComponent(part.slice(eq + 1).trim())
    } catch {
      // A malformed percent-escape is not worth a 500; the cookie simply does
      // not resolve and the caller sees no session.
      continue
    }
  }
  return out
}

/**
 * The Set-Cookie value.
 *
 * HttpOnly because no client script needs it — the server reads the session and
 * renders the projection, so the browser never handles the credential.
 * SameSite=Lax rather than Strict so the link arriving from Slack still works,
 * while a cross-site POST cannot forge an order. Secure requires HTTPS, which
 * Caddy already terminates (browsers exempt localhost).
 */
export function serializeSessionCookie(token: string, expires: Date): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Expires=${expires.toUTCString()}`,
  ].join("; ")
}

/**
 * The faction for a request, or undefined.
 *
 * The ONLY way a request acquires a faction. `factionId` is absent from the
 * wire format rather than merely validated: nothing here reads a body, a query
 * string, or any cookie other than the session one, so there is no path by
 * which a request can name a faction.
 *
 * Returns undefined rather than a default — a fallback faction would hand a
 * stranger somebody else's orders.
 */
export function sessionFactionFor(
  req: { headers: { cookie?: string | undefined } },
  deps: { store: AuthStore; seasonId: string; now: Date },
): FactionId | undefined {
  const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE]
  if (raw === undefined || raw === "") return undefined
  return deps.store.sessionFaction(hashToken(raw), deps.seasonId, deps.now)
}
