import { describe, expect, it } from "vitest"
import { hashToken, newToken } from "./token.js"

describe("newToken", () => {
  it("is URL-safe, so it survives being pasted into a link", () => {
    for (let i = 0; i < 50; i++) expect(newToken()).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it("is long enough not to be guessed", () => {
    // 32 bytes. Shorter is a credential someone can brute-force offline.
    expect(Buffer.from(newToken(), "base64url")).toHaveLength(32)
  })

  it("never repeats", () => {
    expect(new Set(Array.from({ length: 1000 }, newToken)).size).toBe(1000)
  })
})

describe("hashToken", () => {
  it("is stable and 64 hex characters", () => {
    expect(hashToken("abc")).toBe(hashToken("abc"))
    expect(hashToken("abc")).toMatch(/^[0-9a-f]{64}$/)
  })

  it("differs for different tokens", () => {
    expect(hashToken("abc")).not.toBe(hashToken("abd"))
  })

  it("does not contain the token", () => {
    // The whole point: a leaked table must not yield a working link.
    const t = newToken()
    expect(hashToken(t)).not.toContain(t)
  })
})
