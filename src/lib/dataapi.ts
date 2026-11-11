import { createHash } from "crypto";
import { fetchJson } from "./http";
import type { Trade, Side } from "./types";

export interface RawTrade {
  proxy_wallet: string;
  side: string;
  token_id?: string;
  condition_id: string;
  size: number;
  price: number;
  timestamp: number;
  title?: string;
  slug?: string;
  outcome?: string;
  outcome_index?: number;
  pseudonym?: string;
  name?: string;
  transaction_hash: string;
}
interface TradesPage {
  data: RawTrade[] | null;
  pagination?: { next_cursor?: string | null; has_more?: boolean };
}

export function stableTradeId(r: RawTrade) {
  return createHash("sha256")
    .update([r.transaction_hash, r.proxy_wallet, r.token_id ?? "", r.side, r.size, r.price, r.timestamp].join("|"))
    .digest("hex");
}

export function normalizeTrade(r: RawTrade, marketId: string): Trade | null {
  if (!r.transaction_hash || !r.proxy_wallet || !r.condition_id) return null;
  const price = Number(r.price);
  const size = Number(r.size);
  if (!Number.isFinite(price) || !Number.isFinite(size) || size <= 0 || price <= 0) return null;
  const side: Side = String(r.side).toUpperCase() === "BUY" ? "BUY" : "SELL";
  return {
    trade_id: stableTradeId(r),
    transaction_hash: r.transaction_hash,
    wallet: r.proxy_wallet.toLowerCase(),
    pseudonym: r.pseudonym || r.name || null,
    market_id: marketId,
    condition_id: r.condition_id,
    token_id: r.token_id ?? null,
    side,
    outcome: r.outcome ?? null,
    price,
    size,
    usd_amount: Math.round(price * size * 100) / 100,
    traded_at: new Date(r.timestamp * 1000).toISOString(),
  };
}

export async function fetchTradesForMarket(options: {
  condition: string;
  marketId: string;
  startSec: number;
  endSec: number;
  maxPages?: number;
  takerOnly?: boolean;
}) {
  const out: Trade[] = [];
  const maxPages = options.maxPages ?? 10;
  let cursor: string | undefined;
  let truncated = false;

  for (let page = 0; page < maxPages; page++) {
    const query = new URLSearchParams({
      condition: options.condition,
      start: String(Math.max(0, options.startSec)),
      end: String(options.endSec),
      limit: "500",
      taker_only: String(options.takerOnly ?? true),
    });
    if (cursor) query.set("cursor", cursor);

    let response: TradesPage;
    try {
      response = await fetchJson<TradesPage>(`https://data-api.polymarket.com/v2/trades?${query}`);
    } catch (error) {
      return { trades: out, truncated: true, error: (error as Error).message };
    }

    for (const rawTrade of response.data ?? []) {
      const trade = normalizeTrade(rawTrade, options.marketId);
      if (trade) out.push(trade);
    }

    const hasMore = response.pagination?.has_more === true;
    cursor = response.pagination?.next_cursor ?? undefined;
    if (!cursor || !hasMore) break;
    if (page === maxPages - 1) truncated = true;
  }

  return { trades: out, truncated };
}
