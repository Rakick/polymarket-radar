import { createClient } from "npm:@supabase/supabase-js@2.47.10";

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
        batch = await fetchJson<any[]>(`https://gamma-api.polymarket.com/markets?tag_id=${encodeURIComponent(String(tag.id))}&active=true&closed=false&limit=100&offset=${offset}`);
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
type WalletContext = { ageDays: number | null; avgTradeUsd30d: number | null; tradeCount30d: number };
const MIN_ALERT_SCORE = 50;
function minimumForPrice(price: number): number | null {
  if (price <= 0 || price > 0.2) return null;
  if (price < 0.05) return 1000;
  if (price < 0.10) return 2500;
  return 7500;
}
async function getPolymarketJoinDate(wallet: string): Promise<string | null> {
  const profile = await fetchJson<any>(`https://data-api.polymarket.com/v2/user-stats?user=${encodeURIComponent(wallet)}`);
  const seconds = Number(profile?.data?.join_date);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
}
function clamp(value: number, min = 0, max = 1) { return Math.max(min, Math.min(max, value)); }

function buildV2Signals(trades: Trade[], settings: Settings) {
  const minimumUsd = Math.max(250, Number(settings.min_usd ?? 500));
  // Regle produit : ne pas suivre les probabilites au-dessus de 60c (v2_max_price).
  const maxPrice = Number((settings as any).v2_max_price ?? 0.6);
  const windowMs = Math.max(5, Number(settings.group_window_minutes ?? 30)) * 60_000;
  const sorted = trades
    .filter(t => Number.isFinite(t.usd_amount) && t.usd_amount > 0 && Number.isFinite(Date.parse(t.traded_at)))
    .sort((a,b) => a.wallet.localeCompare(b.wallet) || a.condition_id.localeCompare(b.condition_id)
      || a.side.localeCompare(b.side) || String(a.outcome ?? "").localeCompare(String(b.outcome ?? ""))
      || Date.parse(a.traded_at)-Date.parse(b.traded_at));
  const signals: any[] = [];
  let group: Trade[] = [];
  const flush = () => {
    if (!group.length) return;
    const total = group.reduce((sum,t) => sum + t.usd_amount, 0);
    const weightedPrice = total > 0 ? group.reduce((sum,t) => sum+t.price*t.usd_amount,0)/total : 0;
    if (total >= minimumUsd && weightedPrice <= maxPrice) {
      const first = group[0], last = group[group.length-1];
      const bucket = Math.floor(Date.parse(first.traded_at)/windowMs);
      signals.push({
        dedupe_key: [first.wallet,first.condition_id,first.side,first.outcome ?? "unknown",bucket].join("|"),
        wallet:first.wallet, market_id:first.market_id, condition_id:first.condition_id,
        side:first.side, outcome:first.outcome,
        trade_ids:group.map(t=>t.trade_id), total_usd:Math.round(total*100)/100,
        price_min:Math.min(...group.map(t=>t.price)), price_avg:weightedPrice,
        first_trade_at:first.traded_at, last_trade_at:last.traded_at,
        updated_at:new Date().toISOString(),
      });
    }
    group=[];
  };
  for (const trade of sorted) {
    const previous=group[group.length-1];
    const sameGroup=previous && previous.wallet===trade.wallet && previous.condition_id===trade.condition_id
      && previous.side===trade.side && (previous.outcome ?? "")===(trade.outcome ?? "")
      && Date.parse(trade.traded_at)-Date.parse(previous.traded_at)<=windowMs;
    if (!sameGroup) flush();
    group.push(trade);
  }
  flush();
  return signals;
}

function buildAlerts(trades: Trade[], settings: Settings, walletContext: Record<string, WalletContext>) {
  const groups = new Map<string, Trade[]>();
  for (const t of trades.filter(t => {
    if (t.side !== "BUY") return false;
    const threshold = minimumForPrice(t.price);
    return threshold !== null && t.usd_amount >= threshold;
  })) {
    const k = `${t.wallet}|${t.condition_id}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(t);
  }

  // Cross-wallet activity is measured only among trades actually fetched in this scan batch.
  const coordinated = new Map<string, Set<string>>();
  for (const t of trades) {
    const minStake = minimumForPrice(t.price);
    if (t.side !== "BUY" || minStake === null || t.usd_amount < minStake) continue;
    const bucket = Math.floor(Date.parse(t.traded_at) / 600000);
    const key = `${t.condition_id}|${t.outcome ?? "unknown"}|${bucket}`;
    if (!coordinated.has(key)) coordinated.set(key, new Set());
    coordinated.get(key)!.add(t.wallet);
  }

  const alerts: any[] = [];
  for (const [key, ts] of groups) {
    const [wallet, condition] = key.split("|");
    ts.sort((a,b) => Date.parse(a.traded_at) - Date.parse(b.traded_at));
    const buckets: Trade[][] = [];
    let current: Trade[] = [], first = 0;
    for (const t of ts) {
      const time = Date.parse(t.traded_at);
      if (!current.length || time - first <= settings.group_window_minutes * 60000) {
        if (!current.length) first = time;
        current.push(t);
      } else { buckets.push(current); current = [t]; first = time; }
    }
    if (current.length) buckets.push(current);

    for (const g of buckets) {
      const total = g.reduce((a,t) => a + t.usd_amount, 0);
      const weightedPrice = total > 0 ? g.reduce((a,t) => a + t.price * t.usd_amount, 0) / total : 0;
      const minPrice = Math.min(...g.map(t => t.price));
      const threshold = minimumForPrice(weightedPrice);
      if (threshold === null || total < threshold) continue;
      const exceptionalSingle = g.length === 1 && total >= threshold * 5;
      if (g.length < 2 && !exceptionalSingle) continue;

      const factors: any[] = [], missing: string[] = [];
      const push = (code: string, label: string, points: number, detail: string) => {
        const rounded = Math.round(points * 10) / 10;
        if (rounded > 0.01) factors.push({ code, label_fr: label, label_en: label, points: rounded, detail });
      };

      // Equivalent stake normalizes for odds: $1k at 3c ~= $5k at 10c.
      const oddsMultiplier = clamp(Math.pow(0.10 / Math.max(weightedPrice, 0.01), 1.35), 0.5, 10);
      const adjustedAmount = total * oddsMultiplier;
      const amountPoints = (settings.weights.adjusted_amount ?? 30) * clamp(Math.log10(Math.max(1, adjustedAmount / 500)) / 1.5);
      push("adjusted_amount", "Montant ajusté à la cote", amountPoints,
        `${Math.round(total)} $ réels · ${Math.round(adjustedAmount)} $ équivalents (cote moyenne ${(weightedPrice*100).toFixed(1)} c)`);

      const ctx = walletContext[wallet];
      if (!ctx || ctx.ageDays === null) missing.push("wallet_age");
      else if (ctx.ageDays <= settings.account_age_days) {
        const agePoints = (settings.weights.wallet_age ?? 12) * (1 - clamp(ctx.ageDays / settings.account_age_days));
        push("wallet_age", "Compte Polymarket récent", agePoints, `Compte créé sur Polymarket il y a ${Math.round(ctx.ageDays)} jours`);
      }
      if (!ctx || ctx.avgTradeUsd30d === null || ctx.tradeCount30d < 3) {
        missing.push("wallet_baseline");
      } else {
        // History is only the portion observed by this radar, not the wallet's complete Polymarket activity.
        missing.push("wallet_baseline_partial");
        const ratio = total / Math.max(ctx.avgTradeUsd30d, 1);
        const anomalyPoints = (settings.weights.wallet_anomaly ?? 25) * clamp(Math.log10(Math.max(1, ratio)) / 2);
        push("wallet_anomaly", "Mise inhabituelle dans l'historique observé",
          anomalyPoints,
          `${Math.round(total)} $ contre ${Math.round(ctx.avgTradeUsd30d)} $ par transaction observée en moyenne sur 30 jours`);
      }

      const outcomeAmounts = new Map<string, number>();
      for (const trade of g) {
        const outcome = trade.outcome ?? "unknown";
        outcomeAmounts.set(outcome, (outcomeAmounts.get(outcome) ?? 0) + trade.usd_amount);
      }
      const dominantShare = total > 0 ? Math.max(...outcomeAmounts.values()) / total : 0;
      if (g.length > 1) {
        push("concentration", "Concentration sur un même résultat", (settings.weights.concentration ?? 8) * clamp((dominantShare - 0.5) / 0.5),
          `${Math.round(dominantShare * 100)} % de la mise sur le résultat dominant`);
      }
      const spanMinutes = Math.max(1, (Date.parse(g[g.length-1].traded_at) - Date.parse(g[0].traded_at)) / 60000);
      const repetition = (settings.weights.repetition ?? 15) * clamp((g.length - 1) / 5) * (1 - clamp(spanMinutes / Math.max(1, settings.group_window_minutes)));
      push("repetition", "Achats répétés et rapprochés", repetition, `${g.length} achats sur ${spanMinutes.toFixed(1)} minutes`);

      const coordinatedWallets = new Set<string>();
      for (const t of g) {
        const bucket = Math.floor(Date.parse(t.traded_at) / 600000);
        const group = coordinated.get(`${condition}|${t.outcome ?? "unknown"}|${bucket}`);
        for (const other of group ?? []) if (other !== wallet) coordinatedWallets.add(other);
      }
      push("coordination", "Activité simultanée entre portefeuilles",
        (settings.weights.coordination ?? 10) * clamp(coordinatedWallets.size / 4),
        coordinatedWallets.size ? `${coordinatedWallets.size} autres portefeuilles sur le même résultat et créneau` : "Aucun autre portefeuille simultané identifié");

      const score = Math.max(0, Math.min(100, Math.round(factors.reduce((a,x)=>a+x.points,0))));
      if (score < MIN_ALERT_SCORE) continue;
      alerts.push({
        dedupe_key: `${wallet}|${condition}|${g.length === 1 ? "single" : "grouped"}|${g[0].traded_at}`,
        wallet, condition_id: condition, alert_type: g.length === 1 ? "single" : "grouped",
        score, confidence: missing.length === 0 ? "high" : missing.length <= 1 ? "medium" : "low",
        factors: factors.sort((a,b)=>b.points-a.points), missing_data: missing,
        trade_ids: g.map(t=>t.trade_id), total_usd: Math.round(total*100)/100,
        price_min: minPrice, first_trade_at: g[0].traded_at, last_trade_at: g[g.length-1].traded_at,
      });
    }
  }
  return alerts;
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

  const errors: string[] = []; let scanned = 0, fetched = 0, inserted = 0, alertCount = 0, targetMarkets = 0, v2SignalCount = 0;
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
      const v2Signals = buildV2Signals(unique, settings);
      for (let i=0; i<v2Signals.length; i+=100) {
        const { data, error } = await db.from("scoring_v2_signals")
          .upsert(v2Signals.slice(i,i+100), { onConflict:"dedupe_key" }).select("id");
        if (error) errors.push(`Sauvegarde signaux V2 lot ${Math.floor(i/100)+1}: ${error.message}`);
        else v2SignalCount += data?.length ?? 0;
      }
      if (unique.length) {
        for (let i = 0; i < unique.length; i += 250) {
          const { data, error } = await db.from("trades")
            .upsert(unique.slice(i, i + 250), { onConflict: "trade_id", ignoreDuplicates: true })
            .select("trade_id");
          if (error) errors.push(`Sauvegarde transactions lot ${Math.floor(i / 250) + 1}: ${error.message}`);
          else inserted += data?.length ?? 0;
        }
      }
      const wallets = [...new Set(unique.filter(t => {
        if (t.side !== "BUY") return false;
        const threshold = minimumForPrice(t.price);
        return threshold !== null && t.usd_amount >= threshold;
      }).map(t => t.wallet))];
      const walletContext: Record<string, WalletContext> = {};
      if (wallets.length) {
        const since30d = new Date(Date.now() - 30 * 86400000).toISOString();
        const walletRows: any[] = [];
        const statsRows: any[] = [];
        for (let i = 0; i < wallets.length; i += 10) {
          const batch = wallets.slice(i, i + 10);
          const [{ data: walletBatch, error: walletError }, { data: statsBatch, error: statsError }] = await Promise.all([
            db.from("wallets").select("address,first_seen_at,first_platform_activity_at,created_at_verified").in("address", batch),
            db.rpc("wallet_recent_trade_stats", { p_wallets: batch, p_since: since30d }),
          ]);
          if (walletError) errors.push(`Données portefeuilles: ${walletError.message}`);
          else walletRows.push(...(walletBatch ?? []));
          if (statsError) errors.push(`Historique portefeuilles: ${statsError.message}`);
          else statsRows.push(...(statsBatch ?? []));
        }
        const stats = new Map((statsRows ?? []).map(row => [row.wallet, row]));
        const meta = new Map((walletRows ?? []).map(row => [row.address, row]));
        for (let i = 0; i < wallets.length; i += 10) {
          await Promise.all(wallets.slice(i, i + 10).map(async wallet => {
            const row = meta.get(wallet);
            let joinDate = row?.created_at_verified ?? null;
            if (!joinDate) {
              try {
                joinDate = await getPolymarketJoinDate(wallet);
                if (joinDate) {
                  const { error } = await db.from("wallets").upsert({ address: wallet, created_at_verified: joinDate, updated_at: new Date().toISOString() }, { onConflict: "address" });
                  if (error) errors.push(`Enregistrement date de création ${wallet}: ${error.message}`);
                }
              } catch (e) { errors.push(`Date de création Polymarket ${wallet}: ${(e as Error).message}`); }
            }
            const ageDays = joinDate ? Math.max(0, (Date.now() - Date.parse(joinDate)) / 86400000) : null;
            const history = stats.get(wallet);
            walletContext[wallet] = {
              ageDays,
              avgTradeUsd30d: history?.avg_trade_usd == null ? null : Number(history.avg_trade_usd),
              tradeCount30d: Number(history?.trade_count ?? 0),
            };
          }));
        }
      }
      const alerts = buildAlerts(unique, settings, walletContext);
      for (let i=0; i<alerts.length; i+=100) {
        const rows = alerts.slice(i,i+100).map(a => ({ ...a, market_id: markets.find(m => m.condition_id === a.condition_id)?.id ?? "" }));
        const { data, error } = await db.from("alerts").upsert(rows, { onConflict: "dedupe_key" }).select("id");
        if (error) errors.push(`Sauvegarde alertes: ${error.message}`); else alertCount += data?.length ?? 0;
      }
    }
  } catch (e) { errors.push((e as Error).message); }
  let v2ScoresUpdated = 0, v2SignalsScored = 0;
  const { data: v2Checkpoint, error: v2CheckpointError } = await db.from("checkpoints")
    .select("value").eq("key","scoring_v2_last_run").maybeSingle();
  if (v2CheckpointError) errors.push(`Lecture du checkpoint V2: ${v2CheckpointError.message}`);
  else if (!v2Checkpoint || Math.floor(Date.now()/1000)-Number(v2Checkpoint.value) >= 300) {
    const [legacyV2, signalV2] = await Promise.all([
      db.rpc("refresh_alert_scores_v2"),
      db.rpc("refresh_scoring_v2_signals"),
    ]);
    if (legacyV2.error) errors.push(`Scoring V2 des alertes historiques: ${legacyV2.error.message}`);
    else v2ScoresUpdated = Number(legacyV2.data ?? 0);
    if (signalV2.error) errors.push(`Scoring des signaux V2: ${signalV2.error.message}`);
    else v2SignalsScored = Number(signalV2.data ?? 0);
    const { error: checkpointWriteError } = await db.from("checkpoints").upsert({
      key:"scoring_v2_last_run", value:Math.floor(Date.now()/1000), updated_at:new Date().toISOString()
    },{onConflict:"key"});
    if (checkpointWriteError) errors.push(`Enregistrement du checkpoint V2: ${checkpointWriteError.message}`);
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
      v2_scores_updated: v2ScoresUpdated, v2_signals_upserted: v2SignalCount,
      v2_signals_scored: v2SignalsScored,
    },
  };
  const { error: finishError } = await db.from("scans").update({
    finished_at: new Date().toISOString(), ...result,
  }).eq("id", scan.id);
  if (finishError) return new Response(JSON.stringify({ ...result, history_error: finishError.message }), { status: 500, headers: cors });
  return new Response(JSON.stringify(result), { status: status === "failed" ? 500 : 200, headers: cors });
});
