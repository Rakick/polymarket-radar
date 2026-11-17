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
  const maxPages = options.maxPages ?? 20;
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    // For condition-shaped feeds, Polymarket ignores start/end and serves a fixed
    // three-year window. Keep filters identical while walking the opaque keyset cursor.
    const query = new URLSearchParams({
      condition: options.condition,
      limit: "500",
      taker_only: String(options.takerOnly ?? true),
    });
    if (cursor) query.set("cursor", cursor);

    let response: TradesPage;
    try {
      response = await fetchJson<TradesPage>(`https://data-api.polymarket.com/v2/trades?${query}`);
    } catch (error) {
      return { trades: out, pages: page + 1, truncated: true, error: (error as Error).message };
    }

    let oldestTimestamp = Number.POSITIVE_INFINITY;
    for (const rawTrade of response.data ?? []) {
      const timestamp = Number(rawTrade.timestamp);
      if (Number.isFinite(timestamp)) oldestTimestamp = Math.min(oldestTimestamp, timestamp);
      if (!Number.isFinite(timestamp) || timestamp < options.startSec || timestamp > options.endSec) continue;
      const trade = normalizeTrade(rawTrade, options.marketId);
      if (trade) out.push(trade);
    }

    // The feed is ordered newest-to-oldest: once a page crosses the lower time
    // boundary, no subsequent cursor page can contain a trade from this scan window.
    if (oldestTimestamp < options.startSec) {
      return { trades: out, pages: page + 1, truncated: false };
    }

    const hasMore = response.pagination?.has_more === true;
    const nextCursor = response.pagination?.next_cursor;
    if (!hasMore) return { trades: out, pages: page + 1, truncated: false };
    if (typeof nextCursor !== "string" || !nextCursor) {
      return { trades: out, pages: page + 1, truncated: true, error: "Pagination incohérente : has_more=true sans next_cursor" };
    }
    if (seenCursors.has(nextCursor)) {
      return { trades: out, pages: page + 1, truncated: true, error: "Pagination bloquée : curseur répété" };
    }

    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  return {
    trades: out,
    pages: maxPages,
    truncated: true,
    error: `Plafond de sécurité atteint après ${maxPages} pages avant la fin de la fenêtre`,
  };
}
