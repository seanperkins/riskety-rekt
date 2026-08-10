import { describe, expect, it } from "vitest"
import { createKalshiAdapter } from "./index.js"
import type { FetchLike } from "./client.js"
import type { CandidateWindow } from "../types.js"
import type { DropReason } from "./parse.js"

const WINDOW: CandidateWindow = {
  opensAfter: new Date("2026-08-10T13:00:00Z"),
  closesBefore: new Date("2026-08-11T01:00:00Z"),
}

const noSleep = async () => {}

function market(over: Record<string, unknown> = {}) {
  return {
    ticker: "KXTEST-26AUG10-A",
    title: "Will it rain?",
    status: "active",
    result: "",
    open_time: "2026-08-05T05:36:00Z",
    close_time: "2026-08-10T21:30:00Z",
    volume_fp: "38457.31",
    yes_bid_dollars: "0.3800",
    yes_ask_dollars: "0.5300",
    no_bid_dollars: "0.4700",
    no_ask_dollars: "0.6200",
    ...over,
  }
}

function respond(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

describe("getCandidates", () => {
  it("queries the close window as unix seconds", async () => {
    let url = ""
    const fetchImpl: FetchLike = async (input) => {
      url = String(input)
      return respond({ markets: [] })
    }
    const a = createKalshiAdapter({ fetchImpl, sleep: noSleep })
    await a.getCandidates(WINDOW)
    const q = new URL(url).searchParams
    expect(q.get("min_close_ts")).toBe("1786366800") // 2026-08-10T13:00:00Z
    expect(q.get("max_close_ts")).toBe("1786410000") // 2026-08-11T01:00:00Z
    expect(q.get("status")).toBe("open")
  })

  it("returns parsed candidates and drops the rest", async () => {
    const fetchImpl: FetchLike = async () =>
      respond({
        markets: [
          market({ ticker: "KXA-1" }),
          market({ ticker: "KXB-1", volume_fp: "1.00" }), // below floor
          market({ ticker: "KXC-1", yes_bid_dollars: "" }), // malformed
          market({ ticker: "KXD-1", mve_collection_ticker: "X" }), // combo
        ],
      })
    const a = createKalshiAdapter({ fetchImpl, sleep: noSleep, volumeFloor: 1000 })
    const out = await a.getCandidates(WINDOW)
    expect(out.map((c) => c.id)).toEqual(["KXA-1"])
  })

  it("reports drop reasons to the callback for the job log", async () => {
    const drops: [DropReason, string][] = []
    const fetchImpl: FetchLike = async () =>
      respond({ markets: [market({ ticker: "KXB-1", volume_fp: "1.00" })] })
    const a = createKalshiAdapter({
      fetchImpl,
      sleep: noSleep,
      volumeFloor: 1000,
      onDrop: (reason, id) => drops.push([reason, id]),
    })
    await a.getCandidates(WINDOW)
    expect(drops).toEqual([["volume", "KXB-1"]])
  })

  it("returns candidates sorted by id so the caller starts deterministic", async () => {
    const fetchImpl: FetchLike = async () =>
      respond({
        markets: [
          market({ ticker: "KXZ-1" }),
          market({ ticker: "KXA-1" }),
          market({ ticker: "KXM-1" }),
        ],
      })
    const a = createKalshiAdapter({ fetchImpl, sleep: noSleep, volumeFloor: 1000 })
    const out = await a.getCandidates(WINDOW)
    expect(out.map((c) => c.id)).toEqual(["KXA-1", "KXM-1", "KXZ-1"])
  })
})

describe("getSettlements", () => {
  it("returns unsettled for an empty id list without calling the network", async () => {
    let calls = 0
    const fetchImpl: FetchLike = async () => {
      calls++
      return respond({ markets: [] })
    }
    const a = createKalshiAdapter({ fetchImpl, sleep: noSleep })
    expect(await a.getSettlements([])).toEqual({})
    expect(calls).toBe(0)
  })

  it("maps outcomes by ticker, not by position", async () => {
    // Kalshi returns ?tickers= results in arbitrary order. Zipping by index
    // would assign B's outcome to A.
    const fetchImpl: FetchLike = async () =>
      respond({
        markets: [
          { ticker: "B", status: "finalized", result: "no" },
          { ticker: "A", status: "finalized", result: "yes" },
        ],
      })
    const a = createKalshiAdapter({ fetchImpl, sleep: noSleep })
    expect(await a.getSettlements(["A", "B"])).toEqual({ A: "yes", B: "no" })
  })

  it("reports unsettled for a market the API omitted", async () => {
    const fetchImpl: FetchLike = async () =>
      respond({ markets: [{ ticker: "A", status: "finalized", result: "yes" }] })
    const a = createKalshiAdapter({ fetchImpl, sleep: noSleep })
    expect(await a.getSettlements(["A", "MISSING"])).toEqual({ A: "yes", MISSING: "unsettled" })
  })

  it("absorbs a network failure as unsettled rather than throwing", async () => {
    // The spec is explicit: adapter timeouts and errors map to "unsettled" so a
    // Kalshi outage is absorbed by the two-tick refund rule.
    const fetchImpl: FetchLike = async () => {
      throw new TypeError("fetch failed")
    }
    const a = createKalshiAdapter({ fetchImpl, sleep: noSleep })
    expect(await a.getSettlements(["A", "B"])).toEqual({ A: "unsettled", B: "unsettled" })
  })

  it("batches large id lists and merges the results", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `T${String(i).padStart(3, "0")}`)
    const batches: number[] = []
    const fetchImpl: FetchLike = async (input) => {
      const tickers = new URL(String(input)).searchParams.get("tickers")!.split(",")
      batches.push(tickers.length)
      return respond({
        markets: tickers.map((t) => ({ ticker: t, status: "finalized", result: "yes" })),
      })
    }
    const a = createKalshiAdapter({ fetchImpl, sleep: noSleep })
    const out = await a.getSettlements(ids)
    expect(batches).toEqual([100, 100, 50])
    expect(Object.keys(out)).toHaveLength(250)
    expect(out.T249).toBe("yes")
  })

  it("keeps good batches when one batch fails every attempt", async () => {
    // Keyed on the batch contents, not the call count: a single throw is
    // absorbed by the client's retry budget, so a one-shot failure would not
    // exercise this path at all.
    const ids = Array.from({ length: 150 }, (_, i) => `T${String(i).padStart(3, "0")}`)
    const fetchImpl: FetchLike = async (input) => {
      const tickers = new URL(String(input)).searchParams.get("tickers")!.split(",")
      if (tickers.includes("T000")) throw new TypeError("fetch failed")
      return respond({
        markets: tickers.map((t) => ({ ticker: t, status: "finalized", result: "no" })),
      })
    }
    const a = createKalshiAdapter({ fetchImpl, sleep: noSleep })
    const out = await a.getSettlements(ids)
    expect(out.T000).toBe("unsettled")
    expect(out.T099).toBe("unsettled")
    expect(out.T100).toBe("no")
  })

  it("recovers a batch that fails once, because the client retries", async () => {
    const ids = ["A", "B"]
    let calls = 0
    const fetchImpl: FetchLike = async () => {
      calls++
      if (calls === 1) throw new TypeError("fetch failed")
      return respond({
        markets: [
          { ticker: "A", status: "finalized", result: "yes" },
          { ticker: "B", status: "finalized", result: "no" },
        ],
      })
    }
    const a = createKalshiAdapter({ fetchImpl, sleep: noSleep })
    expect(await a.getSettlements(ids)).toEqual({ A: "yes", B: "no" })
    expect(calls).toBe(2)
  })
})
