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
  group_window_minutes: 60, categories: ["politics"], scan_overlap_seconds: 300,
  weights: { amount: 25, low_price: 20, new_account: 15, concentration: 15, burst: 10, position_share: 10, low_liquidity: 5 },
};

async function fetchJson<T>(url: string, tries = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(12000) });
      if (response.status === 429 || response.status >= 500) {
        last = new Error(`HTTP ${response.status}`);
        await new Promise(r => setTimeout(r, Math.min(5000, 500 * 2 ** i)));
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status} pour ${url}`);
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

async function getMarkets(categories: string[]) {
  const markets: any[] = [], errors: string[] = [];
  const seen = new Set<string>();
  for (const category of categories) {
    let tag: any;
    try { tag = await fetchJson<any>(`https://gamma-api.polymarket.com/tags/slug/${encodeURIComponent(category)}`); }
    catch (e) { errors.push(`Tag ${category}: ${(e as Error).message}`); continue; }
    if (!tag?.id) { errors.push(`Tag introuvable: ${category}`); continue; }
    for (let page = 0; page < 5 && markets.length < 500; page++) {
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
        if (markets.length >= 500) break;
      }
      if (batch.length < 100) break;
    }
  }
  return { markets, errors };
}
async function getTrades(market: any, start: number, end: number) {
  const out: Trade[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 2; page++) {
    const q = new URLSearchParams({ condition: market.condition_id, start: String(Math.max(0, start)), end: String(end), limit: "500", taker_only: "true" });
    if (cursor) q.set("cursor", cursor);
    let response: any;
    try { response = await fetchJson<any>(`https://data-api.polymarket.com/v2/trades?${q}`); }
    catch (e) { return { trades: out, error: (e as Error).message, truncated: true }; }
    for (const r of response.data ?? []) {
      if (!r.transaction_hash || !r.proxy_wallet || !r.condition_id) continue;
      const price = Number(r.price), size = Number(r.size);
      if (!Number.isFinite(price) || !Number.isFinite(size) || price <= 0 || size <= 0) continue;
      const side = String(r.side).toUpperCase() === "BUY" ? "BUY" : "SELL";
      const idInput = [r.transaction_hash, r.proxy_wallet, r.token_id ?? "", r.side, r.size, r.price, r.timestamp].join("|");
      out.push({
        trade_id: await hash(idInput), transaction_hash: r.transaction_hash, wallet: String(r.proxy_wallet).toLowerCase(),
        pseudonym: r.pseudonym || r.name || null, market_id: market.id, condition_id: r.condition_id,
        token_id: r.token_id ?? null, side, outcome: r.outcome ?? null, price, size,
        usd_amount: Math.round(price * size * 100) / 100, traded_at: new Date(Number(r.timestamp) * 1000).toISOString(),
      });
    }
    const hasMore = response.pagination?.has_more === true;
    cursor = response.pagination?.next_cursor ?? undefined;
    if (!cursor || !hasMore) return { trades: out, truncated: false };
  }
  return { trades: out, truncated: true };
}
type WalletContext = { ageDays: number | null; avgTradeUsd30d: number | null; tradeCount30d: number; historyComplete: boolean };
function minimumForPrice(price: number): number | null {
  if (price <= 0 || price > 0.2) return null;
  if (price < 0.01) return 500;
  if (price < 0.05) return 500;
  if (price < 0.10) return 1000;
  return 5000;
}
function clamp(value: number, min = 0, max = 1) { return Math.max(min, Math.min(max, value)); }
function buildAlerts(trades: Trade[], settings: Settings, liquidity: Record<string, number | null>, walletContext: Record<string, WalletContext>) {
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
    if (t.side !== "BUY") continue;
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

      const factors: any[] = [], missing: string[] = [];
      const push = (code: string, label: string, points: number, detail: string) => {
        const rounded = Math.round(points * 10) / 10;
        if (rounded > 0.01) factors.push({ code, label_fr: label, label_en: label, points: rounded, detail });
      };

      // Equivalent stake normalizes for odds: $1k at 3c ~= $5k at 10c.
      const oddsMultiplier = clamp(Math.pow(0.10 / Math.max(weightedPrice, 0.01), 1.35), 0.5, 10);
      const adjustedAmount = total * oddsMultiplier;
      const amountPoints = 40 * clamp(Math.log10(Math.max(1, adjustedAmount / 500)) / 1.5);
      push("adjusted_amount", "Montant ajusté à la cote", amountPoints,
        `${Math.round(total)} $ réels · ${Math.round(adjustedAmount)} $ équivalents (cote moyenne ${(weightedPrice*100).toFixed(1)} c)`);

      const ctx = walletContext[wallet];
      let walletPoints = 0;
      if (!ctx || ctx.ageDays === null) missing.push("wallet_age");
      else if (ctx.ageDays <= settings.account_age_days) {
        const agePoints = 8 * (1 - clamp(ctx.ageDays / settings.account_age_days));
        walletPoints += agePoints;
        push("wallet_age", "Portefeuille récent", agePoints, `Compte observé depuis ${Math.round(ctx.ageDays)} jours`);
      }
      if (!ctx || ctx.avgTradeUsd30d === null || ctx.tradeCount30d < 3 || !ctx.historyComplete) {
        missing.push("wallet_baseline");
      } else {
        const ratio = total / Math.max(ctx.avgTradeUsd30d, 1);
        const anomalyPoints = 12 * clamp(Math.log10(Math.max(1, ratio)) / 2);
        walletPoints += anomalyPoints;
        push("wallet_anomaly", "Mise inhabituelle pour ce portefeuille",
          anomalyPoints,
          `${Math.round(total)} $ contre ${Math.round(ctx.avgTradeUsd30d)} $ par transaction en moyenne sur 30 jours`);
      }

      const liq = liquidity[condition];
      if (liq == null || liq <= 0) missing.push("market_liquidity");
      else push("liquidity_impact", "Poids de la mise dans la liquidité",
        15 * clamp(total / liq / 0.10),
        `${Math.round(total)} $ pour ${Math.round(liq)} $ de liquidité`);

      const outcomeAmounts = new Map<string, number>();
      for (const trade of g) {
        const outcome = trade.outcome ?? "unknown";
        outcomeAmounts.set(outcome, (outcomeAmounts.get(outcome) ?? 0) + trade.usd_amount);
      }
      const dominantShare = total > 0 ? Math.max(...outcomeAmounts.values()) / total : 0;
      push("concentration", "Concentration sur un même résultat", 8 * clamp((dominantShare - 0.5) / 0.5),
        `${Math.round(dominantShare * 100)} % de la mise sur le résultat dominant`);
      const spanMinutes = Math.max(1, (Date.parse(g[g.length-1].traded_at) - Date.parse(g[0].traded_at)) / 60000);
      const repetition = 7 * clamp((g.length - 1) / 5) * (1 - clamp(spanMinutes / Math.max(1, settings.group_window_minutes)));
      push("repetition", "Achats répétés et rapprochés", repetition, `${g.length} achats sur ${spanMinutes.toFixed(1)} minutes`);

      const coordinatedWallets = new Set<string>();
      for (const t of g) {
        const bucket = Math.floor(Date.parse(t.traded_at) / 600000);
        const group = coordinated.get(`${condition}|${t.outcome ?? "unknown"}|${bucket}`);
        for (const other of group ?? []) if (other !== wallet) coordinatedWallets.add(other);
      }
      push("coordination", "Activité simultanée entre portefeuilles",
        10 * clamp(coordinatedWallets.size / 4),
        coordinatedWallets.size ? `${coordinatedWallets.size} autres portefeuilles sur le même résultat et créneau` : "Aucun autre portefeuille simultané identifié");

      const score = Math.max(0, Math.min(100, Math.round(factors.reduce((a,x)=>a+x.points,0))));
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

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  const { data: authorized, error: authError } = await db.rpc("validate_scan_cron_secret", { candidate: token });
  if (authError || authorized !== true) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: cors });

  await db.from("scans").update({
    status: "failed", finished_at: new Date().toISOString(),
    errors: ["Exécution interrompue lors d'un lancement précédent (limite de ressources)."]
  }).eq("status", "running").lt("started_at", new Date(Date.now() - 10 * 60 * 1000).toISOString());

  const { data: settingRow, error: settingsError } = await db.from("app_settings").select("data").eq("id", 1).single();
  if (settingsError) return new Response(JSON.stringify({ error: settingsError.message }), { status: 500, headers: cors });
  const raw = (settingRow?.data ?? {}) as Partial<Settings>;
  const settings: Settings = { ...defaults, ...raw, weights: { ...defaults.weights, ...(raw.weights ?? {}) } };
  const end = Math.floor(Date.now()/1000), start = end - 3600 - settings.scan_overlap_seconds;
  const { data: scan, error: startError } = await db.from("scans").insert({
    started_at: new Date().toISOString(), status: "running", window_start: start, window_end: end,
  }).select("id").single();
  if (startError || !scan) return new Response(JSON.stringify({ error: startError?.message ?? "Scan record missing" }), { status: 500, headers: cors });

  const errors: string[] = []; let scanned = 0, fetched = 0, inserted = 0, alertCount = 0, targetMarkets = 0;
  let batchStart = 0;
  try {
    let { data: catalogue, error: catalogueError } = await db.from("markets")
      .select("id,condition_id,slug,liquidity,updated_at,end_date,closed,accepting_orders,category")
      .eq("closed", false).eq("accepting_orders", true).in("category", settings.categories)
      .order("id", { ascending: true }).limit(1000);
    if (catalogueError) throw new Error(`Lecture du catalogue: ${catalogueError.message}`);
    const latest = (catalogue ?? []).reduce((max, m) => Math.max(max, Date.parse(m.updated_at ?? "1970-01-01")), 0);
    const needsRefresh = !catalogue?.length || Date.now() - latest > 55 * 60 * 1000;
    if (needsRefresh) {
      const gamma = await getMarkets(settings.categories);
      errors.push(...gamma.errors);
      for (let i=0; i<gamma.markets.length; i+=100) {
        const { error } = await db.from("markets").upsert(gamma.markets.slice(i,i+100), { onConflict: "id" });
        if (error) errors.push(`Sauvegarde marchés lot ${i/100+1}: ${error.message}`);
      }
      catalogue = gamma.markets;
    }
    catalogue = (catalogue ?? []).filter(m => !m.end_date || Date.parse(m.end_date) > Date.now()).slice(0,500);
    targetMarkets = catalogue.length;
    if (targetMarkets > 0) {
      const { data: checkpoint } = await db.from("checkpoints").select("value").eq("key", "trades_checkpoint").maybeSingle();
      batchStart = Number(checkpoint?.value ?? 0);
      if (!Number.isFinite(batchStart) || batchStart < 0 || batchStart >= targetMarkets) batchStart = 0;
      const markets = catalogue.slice(batchStart, batchStart + 5);
      const nextOffset = (batchStart + markets.length) % targetMarkets;
      const { error: checkpointError } = await db.from("checkpoints").upsert({
        key: "trades_checkpoint", value: nextOffset, updated_at: new Date().toISOString()
      }, { onConflict: "key" });
      if (checkpointError) errors.push(`Mise à jour du checkpoint: ${checkpointError.message}`);
      const all: Trade[] = [];
      let next = 0;
      const workers = Array.from({ length: Math.min(5, markets.length) }, async () => {
        while (next < markets.length) {
          const market = markets[next++];
          const result = await getTrades(market, start, end);
          all.push(...result.trades);
          if (result.error) errors.push(`${market.slug}: ${result.error}`);
          if (result.truncated) errors.push(`${market.slug}: pagination tronquée après 2 pages`);
          if (!result.error) scanned++;
        }
      });
      await Promise.all(workers);
      const unique = [...new Map(all.map(t => [t.trade_id,t])).values()]; fetched = unique.length;
      if (unique.length) {
        const { data, error } = await db.from("trades").upsert(unique, { onConflict: "trade_id", ignoreDuplicates: true }).select("trade_id");
        if (error) errors.push(`Sauvegarde transactions: ${error.message}`); else inserted = data?.length ?? 0;
      }
      const liquidity = Object.fromEntries(markets.map(m => [m.condition_id, m.liquidity]));
      const wallets = [...new Set(unique.filter(t => t.side === "BUY").map(t => t.wallet))];
      const walletContext: Record<string, WalletContext> = {};
      if (wallets.length) {
        const since30d = new Date(Date.now() - 30 * 86400000).toISOString();
        const [{ data: walletRows, error: walletError }, { data: historyRows, error: historyError }] = await Promise.all([
          db.from("wallets").select("address,first_seen_at,first_platform_activity_at,created_at_verified").in("address", wallets),
          db.from("trades").select("wallet,usd_amount").in("wallet", wallets).gte("traded_at", since30d).limit(5000),
        ]);
        if (walletError) errors.push(`Données portefeuilles: ${walletError.message}`);
        if (historyError) errors.push(`Historique portefeuilles: ${historyError.message}`);
        const history = new Map<string, number[]>();
        for (const row of historyRows ?? []) {
          if (!history.has(row.wallet)) history.set(row.wallet, []);
          history.get(row.wallet)!.push(Number(row.usd_amount) || 0);
        }
        const meta = new Map((walletRows ?? []).map(row => [row.address, row]));
        for (const wallet of wallets) {
          const row = meta.get(wallet);
          const seen = row?.first_platform_activity_at ?? row?.created_at_verified;
          const ageDays = seen ? Math.max(0, (Date.now() - Date.parse(seen)) / 86400000) : null;
          const values = history.get(wallet) ?? [];
          walletContext[wallet] = {
            ageDays,
            avgTradeUsd30d: values.length ? values.reduce((a,b)=>a+b,0) / values.length : null,
            tradeCount30d: values.length,
            historyComplete: !historyError && values.length < 5000,
          };
        }
      }
      const alerts = buildAlerts(unique, settings, liquidity, walletContext);
      for (let i=0; i<alerts.length; i+=100) {
        const rows = alerts.slice(i,i+100).map(a => ({ ...a, market_id: markets.find(m => m.condition_id === a.condition_id)?.id ?? "" }));
        const { data, error } = await db.from("alerts").upsert(rows, { onConflict: "dedupe_key" }).select("id");
        if (error) errors.push(`Sauvegarde alertes: ${error.message}`); else alertCount += data?.length ?? 0;
      }
    }
  } catch (e) { errors.push((e as Error).message); }
  const status = scanned === 0 && targetMarkets > 0 ? "failed" : errors.length ? "partial" : "success";
  const result = { status, window_start: start, window_end: end, markets_scanned: scanned, trades_fetched: fetched, trades_new: inserted, alerts_created: alertCount, errors, details: { batch_start: batchStart, batch_size: 5, total_markets: targetMarkets } };
  const { error: finishError } = await db.from("scans").update({
    finished_at: new Date().toISOString(), ...result,
  }).eq("id", scan.id);
  if (finishError) return new Response(JSON.stringify({ ...result, history_error: finishError.message }), { status: 500, headers: cors });
  return new Response(JSON.stringify(result), { status: status === "failed" ? 500 : 200, headers: cors });
});
function gammaMarketCountPlaceholder() { return true; }
