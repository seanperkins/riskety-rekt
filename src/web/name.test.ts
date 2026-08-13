import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { AddressInfo } from "node:net"
import type { Server } from "node:http"
import { RISK_MAP, createSeason } from "../engine/index.js"
import { hashToken, newToken } from "../auth/token.js"
import { openStore } from "../store/sqlite.js"
import { createWebServer } from "./server.js"

let server: Server
let base: string
let store: ReturnType<typeof openStore>
let cookie: string

beforeAll(async () => {
  store = openStore(":memory:")
  store.upsertSeason({ seasonId: "s1", startDate: "2026-09-01", lengthDays: 14 })
  store.addRosterMember({ slackUserId: "U1", factionId: "f1", displayName: "Ada" })
  store.addRosterMember({ slackUserId: "U2", factionId: "f2", displayName: "Bo" })
  server = createWebServer({ port: 0, store, seasonId: "s1" })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const raw = newToken()
  store.mintLoginToken({
    slackUserId: "U1",
    factionId: "f1",
    tokenHash: hashToken(raw),
    expiresAt: new Date(Date.now() + 600_000),
  })
  const res = await post(`/login/${raw}`, undefined, "GET")
  cookie = String(res.headers["set-cookie"]).split(";")[0]!
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  store.close()
})

async function post(
  path: string,
  body?: unknown,
  method = "POST",
  withCookie = true,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  const { request: httpRequest } = await import("node:http")
  const payload = body === undefined ? undefined : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      `${base}${path}`,
      {
        method,
        headers: {
          ...(payload === undefined ? {} : { "content-type": "application/json" }),
          ...(withCookie && cookie !== undefined ? { cookie } : {}),
        },
      },
      (res) => {
        let out = ""
        res.on("data", (c) => (out += c))
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: out }),
        )
      },
    )
    req.on("error", reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

const nameOf = (factionId: string) =>
  store.roster().find((m) => m.factionId === factionId)?.displayName

describe("POST /api/name", () => {
  it("renames the signed-in player", async () => {
    const res = await post("/api/name", { name: "Ada Lovelace" })
    expect(res.status).toBe(200)
    expect(nameOf("f1")).toBe("Ada Lovelace")
  })

  it("NEVER takes the faction from the body", async () => {
    // The whole authorisation model. `factionId` comes from the session cookie
    // and nothing else — a body-supplied one would let anybody rename anybody.
    const before = nameOf("f2")
    const res = await post("/api/name", { name: "Hijacked", factionId: "f2", faction: "f2" })
    expect(res.status).toBe(200)
    expect(nameOf("f2")).toBe(before)
    expect(nameOf("f1")).toBe("Hijacked")
  })

  it("does not move the faction id", async () => {
    // The id is in every saved state and log line.
    await post("/api/name", { name: "Somebody Else Entirely" })
    expect(store.factionForSlackUser("U1")).toBe("f1")
  })

  it("refuses without a session", async () => {
    const res = await post("/api/name", { name: "Anon" }, "POST", false)
    expect(res.status).toBe(401)
  })

  it("refuses an empty name and an over-long one, and changes nothing", async () => {
    await post("/api/name", { name: "Stable" })
    for (const bad of ["   ", "a".repeat(200)]) {
      const res = await post("/api/name", { name: bad })
      expect(res.status).toBe(400)
    }
    expect(nameOf("f1")).toBe("Stable")
  })

  it("refuses a name that is not a string", async () => {
    const res = await post("/api/name", { name: 42 })
    expect(res.status).toBe(400)
  })

  it("returns the stored name, not the typed one", async () => {
    // The client echoes what comes back. Returning the raw input would show a
    // name the database does not hold.
    const res = await post("/api/name", { name: "  Spaced   Out  " })
    expect(JSON.parse(res.body).name).toBe("Spaced Out")
    expect(nameOf("f1")).toBe("Spaced Out")
  })
})

describe("a rename reaching the pages", () => {
  it("shows on the board while the saved state keeps the old name", async () => {
    // The point of resolving names from the roster at render time. The state's
    // frozen `playerName` is deliberately NOT rewritten — history stays as it
    // was recorded — so the board must be reading the roster instead.
    const dealt = createSeason(
      "s1",
      [
        { id: "f1", playerName: "Frozen At The Deal", color: "#e6194b" },
        { id: "f2", playerName: "Bo", color: "#3cb44b" },
      ],
      RISK_MAP.territories.map((t) => t.id),
    )
    store.saveState({ ...dealt, day: 1 }, "test")
    await post("/api/name", { name: "Renamed Today" })

    const board = await post("/", undefined, "GET")
    expect(board.body).toContain("Renamed Today")
    expect(board.body).not.toContain("Frozen At The Deal")
    // And the state itself is untouched.
    expect(store.loadState("s1", 1)?.factions[0]?.playerName).toBe("Frozen At The Deal")
  })
})
