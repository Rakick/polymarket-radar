import { getSettings } from "./settings";
import { adminClient } from "./supabase";
import { fetchOpenMarkets } from "./gamma";
import { fetchTradesForMarket } from "./dataapi";
import { buildAlerts } from "./detect";
import type { Trade } from "./types";

export interface ScanResult {
  status: "success" | "partial" | "failed";
  window_start: number;
  window_end: number;
  markets_scanned: number;
  trades_fetched: number;
  trades_new: number;
  alerts_created: number;
  errors: string[];
}

const MARKET_BATCH_SIZE = 100;
const MARKET_CONCURRENCY = 8;
const MAX_MARKETS_PER_SCAN = 500;

export async function runScan(): Promise<ScanResult> {
  const db = adminClient();
  const settings = await getSettings();
  const window_end = Math.floor(Date.now() / 1000);
  const window_start = window_end - 6 * 3600 - settings.scan_overlap_seconds;
  const errors: string[] = [];
  let markets_scanned = 0;
  let trades_fetched = 0;
  let trades_new = 0;
  let alerts_created = 0;

  const { data: scan, error: scanStartError } = await db
    .from("scans")
    .insert({
      started_at: new Date().toISOString(),
      status: "running",
      window_start,
      window_end,
    })
    .select("id")
    .single();

  if (scanStartError || !scan) {
    throw new Error(`Impossible d'enregistrer le démarrage du scan : ${scanStartError?.message ?? "identifiant absent"}`);
  }

  let status: ScanResult["status"] = "failed";

  try {
    const gamma = await fetchOpenMarkets(settings.categories);
    errors.push(...gamma.errors);

    // Keep the market catalogue current, independently from the scan limit.
    for (let offset = 0; offset < gamma.markets.length; offset += MARKET_BATCH_SIZE) {
      const batch = gamma.markets.slice(offset, offset + MARKET_BATCH_SIZE).map((market) => ({
        ...market,
        closed: false,
        accepting_orders: true,
        updated_at: new Date().toISOString(),
      }));
      const { error } = await db.from("markets").upsert(batch, { onConflict: "id" });
      if (error) errors.push(`Enregistrement des marchés (lot ${Math.floor(offset / MARKET_BATCH_SIZE) + 1}) : ${error.message}`);
    }

    const markets = gamma.markets.slice(0, MAX_MARKETS_PER_SCAN);
    const allTrades: Trade[] = [];
    let nextMarket = 0;

    const worker = async () => {
      while (nextMarket < markets.length) {
        const index = nextMarket++;
        const market = markets[index];
        try {
          const result = await fetchTradesForMarket({
            condition: market.condition_id,
            marketId: market.id,
            startSec: window_start,
            endSec: window_end,
          });
          allTrades.push(...result.trades);
          if (result.error) errors.push(`${market.slug}: ${result.error}`);
          if (result.truncated) errors.push(`${market.slug}: pagination tronquée après la limite de pages`);
          if (!result.error) markets_scanned++;
        } catch (error) {
          errors.push(`${market.slug}: ${(error as Error).message}`);
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(MARKET_CONCURRENCY, markets.length) }, () => worker()),
    );

    const uniqueTrades = [...new Map(allTrades.map((trade) => [trade.trade_id, trade])).values()];
    trades_fetched = uniqueTrades.length;

    let tradesSaved = true;
    if (uniqueTrades.length) {
      const { data, error } = await db
        .from("trades")
        .upsert(uniqueTrades, { onConflict: "trade_id", ignoreDuplicates: true })
        .select("trade_id");
      if (error) {
        tradesSaved = false;
        errors.push(`Enregistrement des transactions : ${error.message}`);
      } else {
        trades_new = data?.length ?? 0;
      }
    }

    if (tradesSaved) {
      const alerts = buildAlerts(
        {
          windowTrades: uniqueTrades,
          walletFirstSeen: {},
          walletRecentVolume: {},
          walletTotalVolume: {},
          marketLiquidity: Object.fromEntries(markets.map((market) => [market.condition_id, market.liquidity])),
        },
        settings,
      );

      if (alerts.length) {
        const marketIds = new Map(markets.map((market) => [market.condition_id, market.id]));
        const rows = alerts.map((alert) => ({
          ...alert,
          market_id: marketIds.get(alert.condition_id) ?? "",
          outcome: null,
        }));
        const { data, error } = await db
          .from("alerts")
          .upsert(rows, { onConflict: "dedupe_key" })
          .select("id");
        if (error) errors.push(`Enregistrement des alertes : ${error.message}`);
        else alerts_created = data?.length ?? 0;
      }
    }

    status = markets_scanned === 0 && markets.length > 0
      ? "failed"
      : errors.length > 0
        ? "partial"
        : "success";
  } catch (error) {
    errors.push((error as Error).message);
    status = "failed";
  }

  const result: ScanResult = {
    status,
    window_start,
    window_end,
    markets_scanned,
    trades_fetched,
    trades_new,
    alerts_created,
    errors,
  };

  const { error: scanUpdateError } = await db
    .from("scans")
    .update({
      finished_at: new Date().toISOString(),
      status,
      markets_scanned,
      trades_fetched,
      trades_new,
      alerts_created,
      errors,
    })
    .eq("id", scan.id);

  if (scanUpdateError) {
    throw new Error(`Scan terminé mais historique non mis à jour : ${scanUpdateError.message}`);
  }

  return result;
}
