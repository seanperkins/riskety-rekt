/**
 * The subset of Kalshi's market object this project reads.
 *
 * Every field is `unknown`: this is untrusted wire data, and typing it as
 * `string` would let `parse.ts` skip the checks that make it safe. Narrowing
 * happens in `parse.ts` and nowhere else.
 */
export interface RawKalshiMarket {
  ticker?: unknown
  event_ticker?: unknown
  title?: unknown
  status?: unknown
  result?: unknown
  open_time?: unknown
  close_time?: unknown
  volume_fp?: unknown
  yes_bid_dollars?: unknown
  yes_ask_dollars?: unknown
  no_bid_dollars?: unknown
  no_ask_dollars?: unknown
  /** Present on multivariate combo markets, whose titles are machine gibberish. */
  mve_collection_ticker?: unknown
}

export interface RawKalshiMarketsResponse {
  markets?: unknown
  cursor?: unknown
}
