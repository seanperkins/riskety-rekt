import { describe, expect, it } from "vitest"
import { KalshiHttpError, getAllMarkets, getJson } from "./client.js"
import type { FetchLike } from "./client.js"

const noSleep = async () => {}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

describe("getJson", () => {
  it("builds the URL from base, path and params", async () => {
    const seen: string[] = []
    const fetchImpl: FetchLike = async (input) => {
      seen.push(String(input))
      return jsonResponse({ ok: true })
    }
    await getJson("/markets", { limit: "2", status: "open" }, { fetchImpl, sleep: noSleep })
    expect(seen).toHaveLength(1)
    const url = new URL(seen[0]!)
    expect(url.pathname.endsWith("/markets")).toBe(true)
    expect(url.searchParams.get("limit")).toBe("2")
    expect(url.searchParams.get("status")).toBe("open")
  })

  it("retries a 500 and succeeds", async () => {
    let calls = 0
    const fetchImpl: FetchLike = async () => {
      calls++
      return calls === 1 ? jsonResponse({}, 500) : jsonResponse({ ok: true })
    }
    const out = await getJson("/markets", {}, { fetchImpl, sleep: noSleep })
    expect(calls).toBe(2)
    expect(out).toEqual({ ok: true })
  })

  it("retries a 429", async () => {
    let calls = 0
    const fetchImpl: FetchLike = async () => {
      calls++
      return calls < 3 ? jsonResponse({}, 429) : jsonResponse({ ok: true })
    }
    await getJson("/markets", {}, { fetchImpl, sleep: noSleep })
    expect(calls).toBe(3)
  })

  it("retries a thrown network error", async () => {
    let calls = 0
    const fetchImpl: FetchLike = async () => {
      calls++
      if (calls === 1) throw new TypeError("fetch failed")
      return jsonResponse({ ok: true })
    }
    await getJson("/markets", {}, { fetchImpl, sleep: noSleep })
    expect(calls).toBe(2)
  })

  it("does NOT retry a 400 -- a bad request will stay bad", async () => {
    let calls = 0
    const fetchImpl: FetchLike = async () => {
      calls++
      return jsonResponse({ error: "bad" }, 400)
    }
    await expect(getJson("/markets", {}, { fetchImpl, sleep: noSleep })).rejects.toBeInstanceOf(
      KalshiHttpError,
    )
    expect(calls).toBe(1)
  })

  it("gives up after the retry budget and throws", async () => {
    let calls = 0
    const fetchImpl: FetchLike = async () => {
      calls++
      return jsonResponse({}, 503)
    }
    await expect(getJson("/markets", {}, { fetchImpl, sleep: noSleep })).rejects.toThrow(/503/)
    expect(calls).toBe(3) // 1 attempt + HTTP_RETRIES
  })

  it("throws on a body that is not JSON", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response("<html>gateway timeout</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })
    await expect(getJson("/markets", {}, { fetchImpl, sleep: noSleep })).rejects.toThrow()
  })

  it("passes an abort signal so a hung socket cannot stall the job", async () => {
    let sawSignal = false
    const fetchImpl: FetchLike = async (_input, init) => {
      sawSignal = init?.signal instanceof AbortSignal
      return jsonResponse({ ok: true })
    }
    await getJson("/markets", {}, { fetchImpl, sleep: noSleep })
    expect(sawSignal).toBe(true)
  })
})

describe("getAllMarkets", () => {
  it("follows cursors and concatenates pages", async () => {
    const pages = [
      { markets: [{ ticker: "A" }], cursor: "c1" },
      { markets: [{ ticker: "B" }], cursor: "c2" },
      { markets: [{ ticker: "C" }], cursor: "" },
    ]
    const cursors: (string | null)[] = []
    let i = 0
    const fetchImpl: FetchLike = async (input) => {
      cursors.push(new URL(String(input)).searchParams.get("cursor"))
      return jsonResponse(pages[i++])
    }
    const out = await getAllMarkets({ status: "open" }, { fetchImpl, sleep: noSleep })
    expect(out.map((m) => m.ticker)).toEqual(["A", "B", "C"])
    expect(cursors).toEqual([null, "c1", "c2"])
  })

  it("stops at MAX_PAGES rather than looping forever on a repeating cursor", async () => {
    let calls = 0
    const fetchImpl: FetchLike = async () => {
      calls++
      return jsonResponse({ markets: [{ ticker: `T${calls}` }], cursor: "always-the-same" })
    }
    const out = await getAllMarkets({}, { fetchImpl, sleep: noSleep })
    expect(calls).toBe(12)
    expect(out).toHaveLength(12)
  })

  it("stops when a page returns no markets even if a cursor is present", async () => {
    let calls = 0
    const fetchImpl: FetchLike = async () => {
      calls++
      return jsonResponse({ markets: [], cursor: "c" })
    }
    const out = await getAllMarkets({}, { fetchImpl, sleep: noSleep })
    expect(calls).toBe(1)
    expect(out).toEqual([])
  })

  it("throws on a page whose markets field is missing", async () => {
    // Skipping a malformed page would truncate the candidate set silently, and
    // the only symptom would be an unexplained thin slate. Better to fail: the
    // publish job records nothing and the systemd retry gets another chance.
    const fetchImpl: FetchLike = async () => jsonResponse({ cursor: "c1" })
    await expect(getAllMarkets({}, { fetchImpl, sleep: noSleep })).rejects.toThrow(
      /no markets array/,
    )
  })

  it("throws on a page whose markets field is not an array", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ markets: "nope", cursor: "c2" })
    await expect(getAllMarkets({}, { fetchImpl, sleep: noSleep })).rejects.toThrow(
      /no markets array/,
    )
  })

  it("keeps the markets it already collected out of the error path", async () => {
    // A mid-walk failure must not half-succeed: the caller sees the throw, not
    // a partial list it might mistake for the whole window.
    const pages = [{ markets: [{ ticker: "A" }], cursor: "c1" }, { cursor: "c2" }]
    let i = 0
    const fetchImpl: FetchLike = async () => jsonResponse(pages[i++])
    await expect(getAllMarkets({}, { fetchImpl, sleep: noSleep })).rejects.toThrow(
      /no markets array/,
    )
  })

  it("drops non-object entries inside markets", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({ markets: [null, 42, { ticker: "A" }, "x"] })
    const out = await getAllMarkets({}, { fetchImpl, sleep: noSleep })
    expect(out).toEqual([{ ticker: "A" }])
  })
})
