import { PAGE_LIMIT, SETTLEMENT_BATCH_SIZE, VOLUME_FLOOR } from "../../config.js"
import type { MarketId, Settlement } from "../../engine/index.js"
import type { Candidate, CandidateWindow, MarketAdapter } from "../types.js"
import { getAllMarkets, type ClientOptions } from "./client.js"
import { toCandidate, toSettlement, type DropReason } from "./parse.js"
import type { RawKalshiMarket } from "./raw.js"

export interface KalshiAdapterOptions extends ClientOptions {
  volumeFloor?: number
  /** Called for every rejected market so the job can log why the slate is thin. */
  onDrop?: (reason: DropReason, id: string) => void
}

const unixSeconds = (d: Date) => String(Math.floor(d.getTime() / 1000))

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function idOf(raw: RawKalshiMarket): string {
  return typeof raw.ticker === "string" ? raw.ticker : "<no ticker>"
}

export function createKalshiAdapter(opts: KalshiAdapterOptions = {}): MarketAdapter {
  const volumeFloor = opts.volumeFloor ?? VOLUME_FLOOR
  const onDrop = opts.onDrop ?? (() => {})

  return {
    async getCandidates(window: CandidateWindow): Promise<Candidate[]> {
      const raw = await getAllMarkets(
        {
          limit: String(PAGE_LIMIT),
          status: "open",
          min_close_ts: unixSeconds(window.opensAfter),
          max_close_ts: unixSeconds(window.closesBefore),
        },
        opts,
      )

      const out: Candidate[] = []
      for (const m of raw) {
        const r = toCandidate(m, window, volumeFloor)
        if (r.ok) out.push(r.candidate)
        else onDrop(r.reason, idOf(m))
      }
      // Sorted so every downstream step begins from a fixed order.
      out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      return out
    },

    async getSettlements(ids: MarketId[]): Promise<Record<MarketId, Settlement>> {
      if (ids.length === 0) return {}

      // Default every requested id to unsettled, then overwrite what we learn.
      // A market the API omits, a batch that times out, and a void result all
      // land here identically -- and the engine refunds after two ticks.
      const out: Record<MarketId, Settlement> = {}
      for (const id of [...ids].sort()) out[id] = "unsettled"

      for (const batch of chunk([...ids].sort(), SETTLEMENT_BATCH_SIZE)) {
        let raw: RawKalshiMarket[]
        try {
          raw = await getAllMarkets({ tickers: batch.join(","), limit: String(PAGE_LIMIT) }, opts)
        } catch {
          continue // this batch stays unsettled; other batches still count
        }
        for (const m of raw) {
          const id = idOf(m)
          // Keyed by ticker: ?tickers= responses come back in arbitrary order.
          if (id in out) out[id] = toSettlement(m)
        }
      }
      return out
    },
  }
}

export type { DropReason }
