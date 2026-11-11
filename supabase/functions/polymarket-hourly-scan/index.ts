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
function buildAlerts(trades: Trade[], settings: Settings, liquidity: Record<string, number | null>) {
  const groups = new Map<string, Trade[]>();
  for (const t of trades.filter(t => t.side === "BUY" && (settings.max_price_inclusive ? t.price <= settings.max_price : t.price < settings.max_price))) {
    const k = `${t.wallet}|${t.condition_id}`; if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(t);
  }
  const alerts: any[] = [];
  for (const [key, ts] of groups) {
    const [wallet, condition] = key.split("|");
    ts.sort((a,b) => Date.parse(a.traded_at) - Date.parse(b.traded_at));
    const buckets: Trade[][] = []; let current: Trade[] = [], first = 0;
    for (const t of ts) {
      const time = Date.parse(t.traded_at);
      if (!current.length || time - first <= settings.group_window_minutes * 60000) { if (!current.length) first = time; current.push(t); }
      else { buckets.push(current); current = [t]; first = time; }
    }
    if (current.length) buckets.push(current);
    for (const g of buckets) {
      const total = g.reduce((a,t) => a + t.usd_amount, 0);
      if (total < settings.min_usd) continue;
      const minPrice = Math.min(...g.map(t => t.price)), w = settings.weights;
      const factors: any[] = [], missing = ["account_age", "wallet_recent_volume", "wallet_total_volume"];
      const push = (code: string, label: string, points: number, detail: string) => { if (points > .01) factors.push({ code, label_fr: label, label_en: label, points: Math.round(points * 10) / 10, detail }); };
      push("amount", "Montant élevé", w.amount * Math.min(1, Math.log10(Math.max(1,total/settings.min_usd))/2), `${Math.round(total)} USD`);
      push("low_price", "Prix de l'issue bas", w.low_price * (1-Math.min(1,minPrice/settings.max_price)), `prix min ≈ ${(minPrice*100).toFixed(1)} %`);
      push("new_account", "Âge du compte inconnu", w.new_account / 3, "date inconnue");
      push("burst", "Achats répétés rapprochés", w.burst * Math.min(1,(g.length-1)/5), `${g.length} achats regroupés`);
      const liq = liquidity[condition];
      if (liq == null) missing.push("market_liquidity"); else if (liq < 50000) push("low_liquidity", "Liquidité faible", w.low_liquidity, `${Math.round(liq)} USD`);
      alerts.push({
        dedupe_key: `${wallet}|${condition}|${g.length === 1 ? "single" : "grouped"}|${g[0].traded_at}`,
        wallet, condition_id: condition, alert_type: g.length === 1 ? "single" : "grouped",
        score: Math.max(0, Math.min(100, Math.round(factors.reduce((a,x)=>a+x.points,0)))),
        confidence: missing.length === 0 ? "high" : missing.length <= 1 ? "medium" : "low",
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
  const end = Math.floor(Date.now()/1000), start = end - 6*3600 - settings.scan_overlap_seconds;
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
      const alerts = buildAlerts(unique, settings, liquidity);
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
