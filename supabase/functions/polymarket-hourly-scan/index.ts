import { createClient } from "npm:@supabase/supabase-js@2.47.10";
import { calculateInformedScore } from "./scoring.ts";

const cors = { "content-type": "application/json" };
const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

type Trade = {
  trade_id: string; transaction_hash: string; wallet: string; pseudonym: string | null;
  market_id: string; condition_id: string; token_id: string | null; side: "BUY" | "SELL";
  outcome: string | null; price: number; size: number; usd_amount: number; traded_at: string;
};
type Settings = {
  min_usd: number; max_price: number; max_price_inclusive: boolean; account_age_days: number;
  group_window_minutes: number; categories: string[]; scan_overlap_seconds: number;
  weights: Record<string, number>;
};
const defaults: Settings = {
  min_usd: 10000, max_price: 0.2, max_price_inclusive: true, account_age_days: 7,
  group_window_minutes: 30, categories: ["politics", "geopolitics", "tech", "economy"], scan_overlap_seconds: 300,
  weights: { adjusted_amount: 30, wallet_anomaly: 25, wallet_age: 12, concentration: 8, repetition: 15, coordination: 10 },
};

async function fetchJson<T>(url: string, tries = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(12000),
      });
      if (response.status === 429 || response.status === 503 || response.status >= 500) {
        const traceId = response.headers.get("x-trace-id");
        last = new Error(`HTTP ${response.status}${traceId ? ` trace_id=${traceId}` : ""}`);
        if (i < tries - 1) {
          const retryAfterSeconds = Number(response.headers.get("retry-after"));
          const delayMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
            ? Math.min(10000, retryAfterSeconds * 1000)
            : Math.min(5000, 500 * 2 ** i);
          await new Promise(r => setTimeout(r, delayMs));
        }
        continue;
      }
      if (!response.ok) {
        const traceId = response.headers.get("x-trace-id");
        throw new Error(`HTTP ${response.status} pour ${url}${traceId ? ` (trace_id=${traceId})` : ""}`);
      }
      return await response.json() as T;
    } catch (e) {
      last = e;
      if (i < tries - 1) await new Promise(r => setTimeout(r, Math.min(5000, 500 * 2 ** i)));
    }
  }
  throw last instanceof Error ? last : new Error("Erreur HTTP inconnue");
}

async function hash(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}
function tagsMatch(m: any, categories: string[]) {
  const tags = new Set<string>();
  for (const t of m.tags ?? []) { if (t.slug) tags.add(String(t.slug).toLowerCase()); if (t.label) tags.add(String(t.label).toLowerCase()); }
  for (const e of m.events ?? []) for (const t of e.tags ?? []) { if (t.slug) tags.add(String(t.slug).toLowerCase()); if (t.label) tags.add(String(t.label).toLowerCase()); }
  return categories.some(c => tags.has(c.toLowerCase()));
}
function parseArray(s?: string) { try { const v = s ? JSON.parse(s) : []; return Array.isArray(v) ? v : []; } catch { return []; } }

async function getMarkets(categories: string[], caps: { perCategory: number; total: number }) {
  const markets: any[] = [], errors: string[] = [];
  const seen = new Set<string>();
  for (const category of categories) {
    const categoryStartCount = markets.length;
    let tag: any;
    try { tag = await fetchJson<any>(`https://gamma-api.polymarket.com/tags/slug/${encodeURIComponent(category)}`); }
    catch (e) { errors.push(`Tag ${category}: ${(e as Error).message}`); continue; }
    if (!tag?.id) { errors.push(`Tag introuvable: ${category}`); continue; }
    for (let page = 0; page < 10 && markets.length - categoryStartCount < caps.perCategory && markets.length < caps.total; page++) {
      const offset = page * 100;
      let batch: any[];
      try {
        batch = await fetchJson<any[]>(`https://gamma-api.polymarket.com/markets?tag_id=${encodeURIComponent(String(tag.id))}&active=true&closed=false&order=volumeNum&ascending=false&limit=100&offset=${offset}`);
      } catch (e) { errors.push(`Markets ${category} offset=${offset}: ${(e as Error).message}`); break; }
      if (!batch.length) break;
      for (const m of batch) {
        if (m.closed !== false || m.active === false || m.acceptingOrders === false || !m.conditionId || String(m.conditionId).startsWith("0x00000000")) continue;
        if (m.endDate && Date.parse(m.endDate) <= Date.now()) continue;
        const condition = String(m.conditionId);
        if (seen.has(condition)) continue;
        seen.add(condition);
        const liquidity = Number(m.liquidityNum ?? m.liquidity);
        const volume = Number(m.volumeNum ?? m.volume);
        markets.push({
          id: String(m.id), condition_id: condition, slug: m.slug, question: m.question,
          url: m.url || `https://polymarket.com/market/${m.slug}`, category,
          end_date: m.endDate ?? null, liquidity: Number.isFinite(liquidity) ? liquidity : null,
          volume: Number.isFinite(volume) ? volume : null,
          outcomes: parseArray(m.outcomes), outcome_prices: parseArray(m.outcomePrices).map(Number),
          closed: false, accepting_orders: true, updated_at: new Date().toISOString(),
        });
        if (markets.length - categoryStartCount >= caps.perCategory || markets.length >= caps.total) break;
      }
      if (batch.length < 100) break;
    }
  }
  return { markets, errors };
}
// /v2/trades?condition= ignores start/end and serves a fixed three-year feed.
// Walk its opaque keyset cursor until the page reaches the scan-window boundary.
// The 20-page guard is a last-resort runtime/memory ceiling, not the normal stop condition.
const TRADE_PAGE_SIZE = 500;
const MAX_TRADE_PAGES = 20;
async function getTrades(market: any, start: number, end: number) {
  const out: Trade[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (let page = 0; page < MAX_TRADE_PAGES; page++) {
    // Keep identical filters across the cursor walk. start/end are intentionally omitted:
    // Polymarket honours these only for the user-shaped feed, not the condition-shaped feed.
    const q = new URLSearchParams({
      condition: market.condition_id,
      limit: String(TRADE_PAGE_SIZE),
      taker_only: "true",
    });
    if (cursor) q.set("cursor", cursor);

    let response: any;
    try {
      response = await fetchJson<any>(`https://data-api.polymarket.com/v2/trades?${q}`);
    } catch (e) {
      return { trades: out, pages: page + 1, error: (e as Error).message, truncated: true };
    }

    const rows = Array.isArray(response.data) ? response.data : [];
    let oldestTimestamp = Number.POSITIVE_INFINITY;

    for (const r of rows) {
      const timestamp = Number(r.timestamp);
      if (Number.isFinite(timestamp)) oldestTimestamp = Math.min(oldestTimestamp, timestamp);

      if (!r.transaction_hash || !r.proxy_wallet || !r.condition_id) continue;
      if (!Number.isFinite(timestamp) || timestamp < start || timestamp > end) continue;

      const price = Number(r.price), size = Number(r.size);
      if (!Number.isFinite(price) || !Number.isFinite(size) || price <= 0 || size <= 0) continue;
      const side = String(r.side).toUpperCase() === "BUY" ? "BUY" : "SELL";
      const idInput = [r.transaction_hash, r.proxy_wallet, r.token_id ?? "", r.side, r.size, r.price, timestamp].join("|");
      out.push({
        trade_id: await hash(idInput), transaction_hash: r.transaction_hash, wallet: String(r.proxy_wallet).toLowerCase(),
        pseudonym: r.pseudonym || r.name || null, market_id: market.id, condition_id: r.condition_id,
        token_id: r.token_id ?? null, side, outcome: r.outcome ?? null, price, size,
        usd_amount: Math.round(price * size * 100) / 100, traded_at: new Date(timestamp * 1000).toISOString(),
      });
    }

    // The keyset feed defaults to newest-to-oldest. Once this page crosses the lower
    // time bound, subsequent cursors are older; the remaining three-year history is irrelevant.
    if (oldestTimestamp < start) {
      return { trades: out, pages: page + 1, truncated: false };
    }

    const hasMore = response.pagination?.has_more === true;
    const nextCursor = response.pagination?.next_cursor;
    if (!hasMore) return { trades: out, pages: page + 1, truncated: false };
    if (typeof nextCursor !== "string" || !nextCursor) {
      return {
        trades: out, pages: page + 1,
        error: "Pagination incohérente : has_more=true sans next_cursor",
        truncated: true,
      };
    }
    if (seenCursors.has(nextCursor)) {
      return {
        trades: out, pages: page + 1,
        error: "Pagination bloquée : le curseur Polymarket se répète",
        truncated: true,
      };
    }

    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  return {
    trades: out, pages: MAX_TRADE_PAGES,
    error: `Plafond de sécurité atteint (${MAX_TRADE_PAGES} pages × ${TRADE_PAGE_SIZE} lignes) avant la fin de la fenêtre`,
    truncated: true,
  };
}
type HistoryTrade = {
  trade_id: string; transaction_hash: string; wallet: string; side: "BUY" | "SELL";
  condition_id: string; outcome: string | null; price: number; size: number;
  usd_amount: number; traded_at: string; timestamp: number;
};
type HistoryResult = { trades: HistoryTrade[]; complete: boolean; error?: string };
type AlertCandidate = {
  dedupe_key: string; wallet: string; market_id: string; condition_id: string;
  alert_type: "single" | "grouped"; outcome: string | null; trade_ids: string[];
  total_usd: number; price_min: number | null; price_avg: number | null;
  first_trade_at: string; last_trade_at: string;
};
type ScoringCache = {
  users: Map<string, Promise<HistoryResult>>;
  markets: Map<string, Promise<HistoryResult>>;
  joinDates: Map<string, Promise<string | null>>;
};
const MODEL_VERSION = "informed-buy-v1";
const DISPLAY_SCORE_MIN = 50;
const HISTORY_PAGE_SIZE = 1000;
const HISTORY_MAX_PAGES = 40;
const WINDOW_MS = 30 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function makeScoringCache(): ScoringCache {
  return { users: new Map(), markets: new Map(), joinDates: new Map() };
}

function parseHistoryTrade(row: any): HistoryTrade | null {
  const wallet = String(row?.proxy_wallet ?? row?.wallet ?? "").toLowerCase();
  const condition = String(row?.condition_id ?? row?.conditionId ?? "");
  const transactionHash = String(row?.transaction_hash ?? "");
  const timestamp = Number(row?.timestamp);
  const price = Number(row?.price);
  const size = Number(row?.size);
  const side = String(row?.side ?? "").toUpperCase();
  if (!wallet || !condition || !transactionHash || !Number.isFinite(timestamp)
    || !Number.isFinite(price) || !Number.isFinite(size) || price <= 0 || size <= 0
    || (side !== "BUY" && side !== "SELL")) return null;
  return {
    trade_id: "", transaction_hash: transactionHash, wallet, side: side as "BUY" | "SELL",
    condition_id: condition, outcome: row?.outcome == null ? null : String(row.outcome),
    price, size, usd_amount: Math.round(price * size * 100) / 100,
    traded_at: new Date(timestamp * 1000).toISOString(), timestamp,
  } as HistoryTrade & { _idInput?: string };
}

async function fetchTradeHistory(params: Record<string, string>, stopBeforeMs?: number): Promise<HistoryResult> {
  const trades: HistoryTrade[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < HISTORY_MAX_PAGES; page++) {
    const query = new URLSearchParams({ ...params, limit: String(HISTORY_PAGE_SIZE) });
    if (cursor) query.set("cursor", cursor);
    let payload: any;
    try {
      payload = await fetchJson<any>(`https://data-api.polymarket.com/v2/trades?${query}`);
    } catch (error) {
      return { trades, complete: false, error: (error as Error).message };
    }
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    let oldest = Number.POSITIVE_INFINITY;
    for (const row of rows) {
      const parsed = parseHistoryTrade(row);
      if (!parsed) continue;
      oldest = Math.min(oldest, parsed.timestamp * 1000);
      const tokenId = row?.asset ?? row?.token_id ?? "";
      const idInput = [parsed.transaction_hash, parsed.wallet, tokenId, parsed.side, row.size, row.price, parsed.timestamp].join("|");
      const uniqueKey = `${idInput}|${parsed.outcome ?? ""}`;
      if (seen.has(uniqueKey)) continue;
      seen.add(uniqueKey);
      parsed.trade_id = await hash(idInput);
      trades.push(parsed);
    }

    if (stopBeforeMs != null && oldest < stopBeforeMs) {
      return { trades, complete: true };
    }
    const hasMore = payload?.pagination?.has_more === true;
    const nextCursor = payload?.pagination?.next_cursor;
    if (!hasMore) return { trades, complete: true };
    if (typeof nextCursor !== "string" || !nextCursor || nextCursor === cursor) {
      return { trades, complete: false, error: "Pagination Polymarket incomplète ou curseur répété" };
    }
    cursor = nextCursor;
  }
  return { trades, complete: false, error: `Plafond de sécurité atteint après ${HISTORY_MAX_PAGES} pages` };
}

function getUserHistory(wallet: string, cache: ScoringCache): Promise<HistoryResult> {
  const key = wallet.toLowerCase();
  if (!cache.users.has(key)) {
    const end = Math.floor(Date.now() / 1000);
    cache.users.set(key, fetchTradeHistory({
      user: key, side: "BUY", start: "1", end: String(end),
      taker_only: "false", filter_type: "CASH", filter_amount: "0",
    }));
  }
  return cache.users.get(key)!;
}

function getMarketHistory(condition: string, eventTimeMs: number, cache: ScoringCache): Promise<HistoryResult> {
  const key = condition.toLowerCase();
  if (!cache.markets.has(key)) {
    cache.markets.set(key, fetchTradeHistory({
      condition, side: "BUY", taker_only: "false",
      filter_type: "CASH", filter_amount: "0",
    }, eventTimeMs - 30 * DAY_MS));
  }
  return cache.markets.get(key)!;
}

async function getVerifiedJoinDate(wallet: string, cache: ScoringCache): Promise<string | null> {
  const key = wallet.toLowerCase();
  if (!cache.joinDates.has(key)) {
    cache.joinDates.set(key, (async () => {
      const { data, error } = await db.from("wallets")
        .select("created_at_verified").eq("address", key).maybeSingle();
      if (error) throw error;
      if (data?.created_at_verified) return String(data.created_at_verified);
      const joinDate = await getPolymarketJoinDate(key);
      if (joinDate) {
        const { error: saveError } = await db.from("wallets").upsert({
          address: key, created_at_verified: joinDate, updated_at: new Date().toISOString(),
        }, { onConflict: "address" });
        if (saveError) throw saveError;
      }
      return joinDate;
    })());
  }
  try { return await cache.joinDates.get(key)!; }
  catch (error) {
    console.error(`[informed-scoring] join date ${key}: ${(error as Error).message}`);
    return null;
  }
}

function normalizedOutcome(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase();
}
function priceBand(price: number): number {
  if (price < 0.10) return 0;
  if (price < 0.20) return 1;
  if (price < 0.40) return 2;
  if (price < 0.60) return 3;
  return -1;
}

function buildAlertCandidates(trades: Trade[], windowMinutes: number): Array<{ row: AlertCandidate; trades: Trade[] }> {
  const windowMs = Math.max(5, Number(windowMinutes || 30)) * 60_000;
  const sorted = trades.filter(trade => trade.side === "BUY" && trade.usd_amount > 0)
    .sort((a, b) => a.wallet.localeCompare(b.wallet)
      || a.condition_id.localeCompare(b.condition_id)
      || normalizedOutcome(a.outcome).localeCompare(normalizedOutcome(b.outcome))
      || Date.parse(a.traded_at) - Date.parse(b.traded_at));
  const result: Array<{ row: AlertCandidate; trades: Trade[] }> = [];
  let group: Trade[] = [];
  const flush = () => {
    if (!group.length) return;
    const first = group[0], last = group[group.length - 1];
    const totalUsd = group.reduce((sum, trade) => sum + trade.usd_amount, 0);
    const weightedPrice = totalUsd > 0
      ? group.reduce((sum, trade) => sum + trade.price * trade.usd_amount, 0) / totalUsd
      : null;
    const bucket = Math.floor(Date.parse(first.traded_at) / WINDOW_MS);
    result.push({
      row: {
        dedupe_key: `informed_buy|${first.wallet}|${first.condition_id}|${normalizedOutcome(first.outcome) || "unknown"}|${bucket}`,
        wallet: first.wallet, market_id: first.market_id, condition_id: first.condition_id,
        alert_type: group.length > 1 ? "grouped" : "single", outcome: first.outcome,
        trade_ids: [...new Set(group.map(trade => trade.trade_id))],
        total_usd: Math.round(totalUsd * 100) / 100,
        price_min: Math.min(...group.map(trade => trade.price)),
        price_avg: weightedPrice,
        first_trade_at: first.traded_at, last_trade_at: last.traded_at,
      },
      trades: [...group],
    });
    group = [];
  };
  for (const trade of sorted) {
    const previous = group[group.length - 1];
    const sameGroup = previous
      && previous.wallet === trade.wallet
      && previous.condition_id === trade.condition_id
      && normalizedOutcome(previous.outcome) === normalizedOutcome(trade.outcome)
      && Date.parse(trade.traded_at) - Date.parse(previous.traded_at) <= windowMs;
    if (!sameGroup) flush();
    group.push(trade);
  }
  flush();
  return result;
}

function historicalRowsForCandidate(candidate: AlertCandidate, localTrades: Trade[], marketHistory: HistoryTrade[]): HistoryTrade[] {
  const start = Date.parse(candidate.first_trade_at) - 1000;
  const end = Date.parse(candidate.last_trade_at) + 1000;
  const local: HistoryTrade[] = localTrades.map(trade => ({
    ...trade, timestamp: Math.floor(Date.parse(trade.traded_at) / 1000),
  }));
  const keys = new Set(local.map(trade => [
    trade.transaction_hash, trade.wallet, trade.timestamp, trade.price, trade.size,
  ].join("|")));
  const recovered = marketHistory.filter(trade => trade.wallet === candidate.wallet.toLowerCase()
    && trade.condition_id === candidate.condition_id
    && normalizedOutcome(trade.outcome) === normalizedOutcome(candidate.outcome)
    && trade.timestamp * 1000 >= start && trade.timestamp * 1000 <= end
    && !keys.has([trade.transaction_hash, trade.wallet, trade.timestamp, trade.price, trade.size].join("|")));
  return [...local, ...recovered];
}

async function scoreAlertCandidate(
  candidate: AlertCandidate,
  localTrades: Trade[],
  cache: ScoringCache,
): Promise<{ row: AlertCandidate; score: number; coverage: number; factors: any[]; missing: string[]; conditions: any[]; confidence: string }> {
  const eventTime = Date.parse(candidate.first_trade_at);
  const marketHistoryPromise = getMarketHistory(candidate.condition_id, eventTime, cache);
  const userHistoryPromise = getUserHistory(candidate.wallet, cache);
  const joinDatePromise = getVerifiedJoinDate(candidate.wallet, cache);
  const [marketHistory, userHistory, joinDate] = await Promise.all([
    marketHistoryPromise, userHistoryPromise, joinDatePromise,
  ]);
  const eventTrades = historicalRowsForCandidate(candidate, localTrades, marketHistory.trades);
  const price = candidate.price_avg ?? (eventTrades.length
    ? eventTrades.reduce((sum, trade) => sum + trade.price * trade.usd_amount, 0)
      / Math.max(1, eventTrades.reduce((sum, trade) => sum + trade.usd_amount, 0))
    : null);
  const eventEpoch = Math.floor(eventTime / 1000);

  let accountAgeDays: number | null = null;
  if (joinDate) {
    const createdAt = Date.parse(joinDate);
    const age = (eventTime - createdAt) / DAY_MS;
    if (Number.isFinite(age) && age >= 0) accountAgeDays = age;
  }

  let concentrationRatio: number | null = null;
  if (userHistory.complete) {
    const before = userHistory.trades.filter(trade => trade.side === "BUY" && trade.timestamp < eventEpoch);
    const allPrevious = before.reduce((sum, trade) => sum + trade.usd_amount, 0);
    const targetPrevious = before.filter(trade =>
      trade.condition_id === candidate.condition_id
      && normalizedOutcome(trade.outcome) === normalizedOutcome(candidate.outcome)
    ).reduce((sum, trade) => sum + trade.usd_amount, 0);
    const denominator = allPrevious + candidate.total_usd;
    if (denominator > 0) concentrationRatio = (targetPrevious + candidate.total_usd) / denominator;
  }

  let comparableAmounts: number[] | null = null;
  const band = price == null ? -1 : priceBand(price);
  if (marketHistory.complete && band >= 0) {
    const prior = marketHistory.trades.filter(trade => {
      const timestamp = trade.timestamp * 1000;
      return trade.side === "BUY" && timestamp < eventTime
        && priceBand(trade.price) === band;
    });
    const sevenDay = prior.filter(trade => trade.timestamp * 1000 >= eventTime - 7 * DAY_MS);
    const thirtyDay = prior.filter(trade => trade.timestamp * 1000 >= eventTime - 30 * DAY_MS);
    if (sevenDay.length >= 100) comparableAmounts = sevenDay.map(trade => trade.usd_amount);
    else if (thirtyDay.length >= 100) comparableAmounts = thirtyDay.map(trade => trade.usd_amount);
  }

  let simultaneousOtherWallets: number | null = null;
  let historicalSimultaneityCounts: number[] | null = null;
  if (marketHistory.complete) {
    const outcome = normalizedOutcome(candidate.outcome);
    const targetWallet = candidate.wallet.toLowerCase();
    const countAccounts = (windowStart: number, windowEnd: number, excludeTarget: boolean) => {
      const totals = new Map<string, number>();
      for (const trade of marketHistory.trades) {
        const time = trade.timestamp * 1000;
        if (trade.side !== "BUY" || time < windowStart || time >= windowEnd
          || normalizedOutcome(trade.outcome) !== outcome
          || (excludeTarget && trade.wallet === targetWallet)) continue;
        totals.set(trade.wallet, (totals.get(trade.wallet) ?? 0) + trade.usd_amount);
      }
      return [...totals.values()].filter(total => total >= 1000).length;
    };
    simultaneousOtherWallets = countAccounts(eventTime - WINDOW_MS, eventTime, true);

    const start = Math.floor((eventTime - 30 * DAY_MS) / WINDOW_MS) * WINDOW_MS;
    const lastWindowStart = eventTime - 2 * WINDOW_MS;
    const counts: number[] = [];
    for (let windowStart = start; windowStart <= lastWindowStart; windowStart += WINDOW_MS) {
      counts.push(countAccounts(windowStart, windowStart + WINDOW_MS, true));
    }
    historicalSimultaneityCounts = counts.length >= 100 ? counts : null;
  }

  const scored = calculateInformedScore({
    totalUsd: candidate.total_usd,
    price,
    accountAgeDays,
    concentrationRatio,
    comparableAmounts,
    simultaneousOtherWallets,
    historicalSimultaneityCounts,
  });
  const confidence = scored.coverage >= 90 ? "high" : scored.coverage >= 60 ? "medium" : "low";
  return {
    row: { ...candidate, price_avg: price },
    score: scored.score, coverage: scored.coverage, factors: scored.factors,
    missing: scored.missing, conditions: scored.conditions, confidence,
  };
}

async function persistScoredAlert(
  candidate: AlertCandidate,
  localTrades: Trade[],
  cache: ScoringCache,
  existingId?: string,
): Promise<{ saved: boolean; deleted: boolean; score: number; coverage: number }> {
  const result = await scoreAlertCandidate(candidate, localTrades, cache);
  if (result.coverage === 0) return { saved: false, deleted: false, score: result.score, coverage: 0 };
  if (result.score < DISPLAY_SCORE_MIN) {
    if (existingId) {
      const { error } = await db.from("alerts").delete().eq("id", existingId);
      if (error) throw error;
    }
    return { saved: false, deleted: Boolean(existingId), score: result.score, coverage: result.coverage };
  }

  const payload: any = {
    ...result.row, score: result.score, coverage: result.coverage,
    model_version: MODEL_VERSION, scored_at: new Date().toISOString(),
    conditions: result.conditions, confidence: result.confidence,
    factors: result.factors, missing_data: result.missing,
    source_system: existingId ? "legacy_history_rescored" : "scanner_informed_buy",
    updated_at: new Date().toISOString(),
  };
  let error: any = null;
  if (existingId) {
    const { data: current, error: currentError } = await db.from("alerts")
      .select("dedupe_key,trade_ids").eq("id", existingId).single();
    if (currentError) throw currentError;
    payload.dedupe_key = current.dedupe_key;
    payload.trade_ids = [...new Set([...(current.trade_ids ?? []), ...(candidate.trade_ids ?? [])])];
    const update = await db.from("alerts").update(payload).eq("id", existingId);
    error = update.error;
  } else {
    const insert = await db.from("alerts").upsert(payload, { onConflict: "dedupe_key" });
    error = insert.error;
  }
  if (error) throw error;
  return { saved: true, deleted: false, score: result.score, coverage: result.coverage };
}

async function findExistingAlert(candidate: AlertCandidate): Promise<string | undefined> {
  const from = new Date(Date.parse(candidate.first_trade_at) - WINDOW_MS).toISOString();
  const to = new Date(Date.parse(candidate.last_trade_at) + WINDOW_MS).toISOString();
  const { data, error } = await db.from("alerts").select("id,trade_ids")
    .eq("wallet", candidate.wallet).eq("condition_id", candidate.condition_id)
    .gte("first_trade_at", from).lte("last_trade_at", to).limit(50);
  if (error) throw error;
  const ids = new Set(candidate.trade_ids);
  const match = (data ?? []).find((row: any) => (row.trade_ids ?? []).some((id: string) => ids.has(id)));
  return match?.id;
}

async function rescorePendingAlerts(cache: ScoringCache, limit = 2) {
  const { data, error } = await db.from("alerts").select("*")
    .is("model_version", null)
    .order("first_trade_at", { ascending: true, nullsFirst: true })
    .limit(limit);
  if (error) throw error;
  let saved = 0, deleted = 0, pending = 0;
  for (const alert of data ?? []) {
    const ids: string[] = alert.trade_ids ?? [];
    let localTrades: Trade[] = [];
    if (ids.length) {
      const { data: rows, error: tradeError } = await db.from("trades")
        .select("trade_id,transaction_hash,wallet,pseudonym,market_id,condition_id,token_id,side,outcome,price,size,usd_amount,traded_at")
        .in("trade_id", ids.slice(0, 1000));
      if (tradeError) throw tradeError;
      localTrades = (rows ?? []) as Trade[];
    }
    const candidate: AlertCandidate = {
      dedupe_key: alert.dedupe_key, wallet: alert.wallet, market_id: alert.market_id,
      condition_id: alert.condition_id, alert_type: alert.alert_type,
      outcome: alert.outcome, trade_ids: ids, total_usd: Number(alert.total_usd) || 0,
      price_min: alert.price_min == null ? null : Number(alert.price_min),
      price_avg: alert.price_avg == null ? null : Number(alert.price_avg),
      first_trade_at: alert.first_trade_at, last_trade_at: alert.last_trade_at,
    };
    const result = await persistScoredAlert(candidate, localTrades, cache, alert.id);
    if (result.saved) saved++;
    if (result.deleted) deleted++;
    if (!result.saved && !result.deleted) pending++;
  }
  return { processed: data?.length ?? 0, saved, deleted, pending };
}


async function syncResolvedMarkets() {
  const cutoff = new Date(Date.now()).toISOString();
  const { data: candidates, error } = await db.from("markets")
    .select("id,end_date,closed,outcomes,outcome_prices")
    .not("end_date", "is", null)
    .lte("end_date", cutoff)
    .order("end_date", { ascending: true })
    .limit(1000);
  if (error) throw new Error(`Lecture des marchés à résoudre: ${error.message}`);
  let checked = 0, updated = 0;
  const errors: string[] = [];
  for (let offset = 0; offset < (candidates ?? []).length; offset += 10) {
    await Promise.all((candidates ?? []).slice(offset, offset + 10).map(async (market: any) => {
      const existingPrices = Array.isArray(market.outcome_prices) ? market.outcome_prices.map(Number) : [];
      const existingWinnerCount = existingPrices.filter((price: number) => price >= 0.99).length;
      if (market.closed === true && existingWinnerCount === 1 && existingPrices.every((price: number) => price >= 0.99 || price <= 0.01)) return;
      try {
        const gamma = await fetchJson<any>(`https://gamma-api.polymarket.com/markets/${encodeURIComponent(String(market.id))}`);
        checked++;
        if (gamma.closed !== true) return;
        const outcomes = parseArray(gamma.outcomes).map(String);
        const prices = parseArray(gamma.outcomePrices).map(Number);
        if (!outcomes.length || outcomes.length !== prices.length || prices.some((price: number) => !Number.isFinite(price))) return;
        const { error: updateError } = await db.from("markets").update({
          closed: true,
          accepting_orders: false,
          outcomes,
          outcome_prices: prices,
          updated_at: new Date().toISOString(),
        }).eq("id", market.id);
        if (updateError) errors.push(`Résolution ${market.id}: ${updateError.message}`);
        else updated++;
      } catch (e) {
        errors.push(`Vérification résolution ${market.id}: ${(e as Error).message}`);
      }
    }));
  }
  return { checked, updated, errors };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  const { data: authorized, error: authError } = await db.rpc("validate_scan_cron_secret", { candidate: token });
  if (authError || authorized !== true) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: cors });

  await db.from("scans").update({
    status: "failed", finished_at: new Date().toISOString(),
    errors: ["Exécution interrompue après expiration du verrou de scan (5 minutes)."]
  }).eq("status", "running").lt("started_at", new Date(Date.now() - 5 * 60 * 1000).toISOString());

  const { data: settingRow, error: settingsError } = await db.from("app_settings").select("data").eq("id", 1).single();
  if (settingsError) return new Response(JSON.stringify({ error: settingsError.message }), { status: 500, headers: cors });
  const raw = (settingRow?.data ?? {}) as Partial<Settings>;
  const settings: Settings = { ...defaults, ...raw, weights: { ...defaults.weights, ...(raw.weights ?? {}) } };
  // Capacity is controlled by app_settings but hard-bounded to keep each 30s run safe.
  const caps = {
    perCategory: Math.min(300, Math.max(50, Math.floor(Number((settings as any).max_markets_per_category ?? 300)))),
    total: Math.min(1500, Math.max(100, Math.floor(Number((settings as any).max_markets_total ?? 1500)))),
  };
  const batchSize = Math.min(15, Math.max(1, Math.floor(Number((settings as any).scan_batch_size ?? 15))));
  // Quality thresholds intentionally broadened to include more active, still-tradable markets.
  const minMarketVolume = Math.max(0, Number((settings as any).min_market_volume ?? 20000));
  const minMarketLiquidity = Math.max(0, Number((settings as any).min_market_liquidity ?? 2000));
  const end = Math.floor(Date.now()/1000), start = end - 3600 - settings.scan_overlap_seconds;
  const { data: scan, error: startError } = await db.from("scans").insert({
    started_at: new Date().toISOString(), status: "running", window_start: start, window_end: end,
  }).select("id").single();
  if (startError?.code === "23505") {
    return new Response(JSON.stringify({ status: "skipped", reason: "Un scan est déjà en cours." }), { status: 200, headers: cors });
  }
  if (startError || !scan) return new Response(JSON.stringify({ error: startError?.message ?? "Scan record missing" }), { status: 500, headers: cors });

  const scoringCache = makeScoringCache();
  const errors: string[] = []; let scanned = 0, fetched = 0, inserted = 0, alertCount = 0, targetMarkets = 0;
  let batchStart = 0;
  let resolvedMarketsUpdated = 0;
  let tradePagesFetched = 0;
  let marketsTruncated = 0;
  try {
    // Resolution changes slowly; do not hit Gamma on every 30-second scan.
    const { data: resolutionCheckpoint, error: resolutionCheckpointError } = await db.from("checkpoints")
      .select("value").eq("key", "resolved_markets_last_run").maybeSingle();
    if (resolutionCheckpointError) {
      errors.push(`Lecture du checkpoint de résolution: ${resolutionCheckpointError.message}`);
    } else if (!resolutionCheckpoint || end - Number(resolutionCheckpoint.value) >= 300) {
      const resolutionSync = await syncResolvedMarkets();
      resolvedMarketsUpdated = resolutionSync.updated;
      errors.push(...resolutionSync.errors);
      const { error: resolutionCheckpointWriteError } = await db.from("checkpoints").upsert({
        key: "resolved_markets_last_run", value: end, updated_at: new Date().toISOString(),
      }, { onConflict: "key" });
      if (resolutionCheckpointWriteError) {
        errors.push(`Écriture du checkpoint de résolution: ${resolutionCheckpointWriteError.message}`);
      }
    }
    let { data: catalogue, error: catalogueError } = await db.from("markets")
      .select("id,condition_id,slug,liquidity,updated_at,end_date,closed,accepting_orders,category,volume")
      .eq("closed", false).eq("accepting_orders", true).in("category", settings.categories)
      .order("volume", { ascending: false, nullsLast: true }).limit(2000);
    if (catalogueError) throw new Error(`Lecture du catalogue: ${catalogueError.message}`);
    const latest = (catalogue ?? []).reduce((max, m) => Math.max(max, Date.parse(m.updated_at ?? "1970-01-01")), 0);
    const presentCategories = new Set((catalogue ?? []).map(m => m.category));
    const missingCategory = settings.categories.some(category => !presentCategories.has(category));
    const needsRefresh = !catalogue?.length || missingCategory || Date.now() - latest > 55 * 60 * 1000;
    if (needsRefresh) {
      const gamma = await getMarkets(settings.categories, caps);
      errors.push(...gamma.errors);
      for (let i=0; i<gamma.markets.length; i+=100) {
        const { error } = await db.from("markets").upsert(gamma.markets.slice(i,i+100), { onConflict: "id" });
        if (error) errors.push(`Sauvegarde marchés lot ${i/100+1}: ${error.message}`);
      }
      catalogue = gamma.markets;
    }
    // Priorisation par volume (proxy d'activite) + filtre qualite amont.
    catalogue = (catalogue ?? [])
      .filter(m => !m.end_date || Date.parse(m.end_date) > Date.now())
      .filter(m => (Number(m.volume) || 0) >= minMarketVolume && (Number(m.liquidity) || 0) >= minMarketLiquidity)
      .sort((a, b) => (Number(b.volume) || 0) - (Number(a.volume) || 0))
      .slice(0, caps.total);
    targetMarkets = catalogue.length;
    if (targetMarkets > 0) {
      const { data: checkpoint } = await db.from("checkpoints").select("value").eq("key", "trades_checkpoint").maybeSingle();
      batchStart = Number(checkpoint?.value ?? 0);
      if (!Number.isFinite(batchStart) || batchStart < 0 || batchStart >= targetMarkets) batchStart = 0;
      const markets = catalogue.slice(batchStart, batchStart + batchSize);
      const nextOffset = (batchStart + markets.length) % targetMarkets;
      const { error: checkpointError } = await db.from("checkpoints").upsert({
        key: "trades_checkpoint", value: nextOffset, updated_at: new Date().toISOString()
      }, { onConflict: "key" });
      if (checkpointError) errors.push(`Mise à jour du checkpoint: ${checkpointError.message}`);
      const all: Trade[] = [];
      let next = 0;
      const workers = Array.from({ length: Math.min(6, markets.length) }, async () => {
        while (next < markets.length) {
          const market = markets[next++];
          const result = await getTrades(market, start, end);
          all.push(...result.trades);
          tradePagesFetched += result.pages ?? 0;
          if (result.error) errors.push(`${market.slug}: ${result.error}`);
          if (result.truncated) marketsTruncated++;
          if (!result.error) scanned++;
        }
      });
      await Promise.all(workers);
      const unique = [...new Map(all.map(t => [t.trade_id,t])).values()]; fetched = unique.length;
      if (unique.length) {
        for (let i = 0; i < unique.length; i += 250) {
          const { data, error } = await db.from("trades")
            .upsert(unique.slice(i, i + 250), { onConflict: "trade_id", ignoreDuplicates: true })
            .select("trade_id");
          if (error) errors.push(`Sauvegarde transactions lot ${Math.floor(i / 250) + 1}: ${error.message}`);
          else inserted += data?.length ?? 0;
        }
      }
      const cache = scoringCache;
      const candidates = buildAlertCandidates(unique, settings.group_window_minutes)
        .sort((a, b) => b.row.total_usd - a.row.total_usd)
        .slice(0, 2);
      for (const candidate of candidates) {
        try {
          const existingId = await findExistingAlert(candidate.row);
          const scored = await persistScoredAlert(candidate.row, candidate.trades, cache, existingId);
          if (scored.saved) alertCount++;
          if (scored.deleted) errors.push(`Alerte recalculée sous 50/100 et supprimée (${candidate.row.dedupe_key})`);
        } catch (error) {
          errors.push(`Scoring BUY ${candidate.row.wallet}: ${(error as Error).message}`);
        }
      }
    }
  } catch (e) { errors.push((e as Error).message); }
  let historicalRescored = 0, historicalDeleted = 0, historicalPending = 0;
  try {
    const backfill = await rescorePendingAlerts(scoringCache, 2);
    historicalRescored = backfill.saved;
    historicalDeleted = backfill.deleted;
    historicalPending = backfill.pending;
  } catch (error) {
    errors.push(`Recalcul historique BUY: ${(error as Error).message}`);
  }
  const status = scanned === 0 && targetMarkets > 0 ? "failed" : errors.length ? "partial" : "success";
  const result = {
    status, window_start: start, window_end: end,
    markets_scanned: scanned, trades_fetched: fetched, trades_new: inserted, alerts_created: alertCount, errors,
    details: {
      batch_start: batchStart, batch_size: batchSize, total_markets: targetMarkets,
      trade_page_size: TRADE_PAGE_SIZE, trade_pages_fetched: tradePagesFetched,
      markets_truncated: marketsTruncated, max_trade_pages_per_market: MAX_TRADE_PAGES,
      min_market_volume: minMarketVolume, min_market_liquidity: minMarketLiquidity,
      resolved_markets_updated: resolvedMarketsUpdated,
      scoring_model: MODEL_VERSION, historical_alerts_rescored: historicalRescored,
      historical_alerts_deleted_below_50: historicalDeleted, historical_alerts_pending: historicalPending,
    },
  };
  const { error: finishError } = await db.from("scans").update({
    finished_at: new Date().toISOString(), ...result,
  }).eq("id", scan.id);
  if (finishError) return new Response(JSON.stringify({ ...result, history_error: finishError.message }), { status: 500, headers: cors });
  return new Response(JSON.stringify(result), { status: status === "failed" ? 500 : 200, headers: cors });
});
