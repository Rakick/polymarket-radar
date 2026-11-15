import { NextRequest, NextResponse } from "next/server";
import { adminClient } from "@/lib/supabase";
import { hasAuthenticatedUser } from "@/lib/api-auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: NextRequest) {
  if (!(await hasAuthenticatedUser(request))) {
    return NextResponse.json({ error: "Session expirée. Reconnectez-vous." }, { status: 401 });
  }

  try {
    const db = adminClient();
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const [
      markets, trades, wallets, alerts, v2All, v2Qualified, v2Rows,
      snapshots, latestSnapshot, scans, scans24h,
    ] = await Promise.all([
      db.from("markets").select("id", { count: "exact", head: true }),
      db.from("trades").select("trade_id", { count: "exact", head: true }),
      db.from("wallets").select("address", { count: "exact", head: true }),
      db.from("alerts").select("id", { count: "exact", head: true }),
      db.from("scoring_v2_signals").select("id", { count: "exact", head: true }),
      db.from("scoring_v2_signals").select("id", { count: "exact", head: true }).gte("score", 50).not("computed_at", "is", null),
      db.from("scoring_v2_signals").select("score,coverage,regime,computed_at").not("computed_at", "is", null).limit(5000),
      db.from("market_price_snapshots").select("id", { count: "exact", head: true }),
      db.from("market_price_snapshots").select("captured_at").order("captured_at", { ascending: false }).limit(1).maybeSingle(),
      db.from("scans").select("id,started_at,finished_at,status,markets_scanned,trades_fetched,trades_new,alerts_created,errors").order("started_at", { ascending: false }).limit(12),
      db.from("scans").select("id", { count: "exact", head: true }).gte("started_at", since24h),
    ]);

    const results = [markets, trades, wallets, alerts, v2All, v2Qualified, v2Rows, snapshots, latestSnapshot, scans, scans24h];
    const failed = results.find((result) => result.error);
    if (failed?.error) throw failed.error;

    // Historical outcomes are evaluated only after Gamma confirms a terminal market price.
    const { data: outcomeSignals, error: outcomeSignalsError } = await db.from("scoring_v2_signals")
      .select("id,market_id,side,outcome,score,total_usd,first_trade_at,computed_at")
      .not("computed_at", "is", null).limit(5000);
    if (outcomeSignalsError) throw outcomeSignalsError;
    const outcomeMarketIds = [...new Set((outcomeSignals ?? []).map((signal: any) => signal.market_id).filter(Boolean))];
    const { data: outcomeMarkets, error: outcomeMarketsError } = outcomeMarketIds.length
      ? await db.from("markets").select("id,question,url,outcomes,outcome_prices,closed,end_date").in("id", outcomeMarketIds)
      : { data: [], error: null };
    if (outcomeMarketsError) throw outcomeMarketsError;

    const marketOutcomeMap = new Map<string, any>((outcomeMarkets ?? []).map((market: any) => [market.id, market]));
    const classified: any[] = [];
    let pendingSignals = 0;
    let unclassifiableSignals = 0;
    for (const signal of outcomeSignals ?? []) {
      // SELL means selling an outcome token, not necessarily betting against it.
      // Only BUY signals can be scored directionally from the market's winning outcome.
      if (String(signal.side).toUpperCase() !== "BUY") {
        unclassifiableSignals++;
        continue;
      }
      const market = marketOutcomeMap.get(signal.market_id);
      const outcomes = Array.isArray(market?.outcomes) ? market.outcomes : [];
      const prices = Array.isArray(market?.outcome_prices) ? market.outcome_prices.map(Number) : [];
      const winnerIndexes = prices.map((price: number, index: number) => price >= 0.99 ? index : -1).filter((index: number) => index >= 0);
      const terminal = market?.closed === true && outcomes.length === prices.length && winnerIndexes.length === 1
        && prices.every((price: number, index: number) => index === winnerIndexes[0] ? price >= 0.99 : price <= 0.01);
      if (!terminal) {
        pendingSignals++;
        continue;
      }
      const selectedIndex = outcomes.findIndex((value: unknown) => String(value).trim().toLowerCase() === String(signal.outcome ?? "").trim().toLowerCase());
      if (selectedIndex < 0) {
        unclassifiableSignals++;
        continue;
      }
      const won = selectedIndex === winnerIndexes[0];
      classified.push({
        id: signal.id,
        question: market.question ?? "Marché sans titre",
        marketUrl: market.url ?? null,
        outcome: signal.outcome,
        side: signal.side,
        score: Number(signal.score) || 0,
        totalUsd: Number(signal.total_usd) || 0,
        firstTradeAt: signal.first_trade_at,
        won,
      });
    }
    const scoreBands = [
      { label: "50–59", min: 50, max: 59 },
      { label: "60–69", min: 60, max: 69 },
      { label: "70–79", min: 70, max: 79 },
      { label: "80–89", min: 80, max: 89 },
      { label: "90–100", min: 90, max: 100 },
    ].map((band) => {
      const rows = classified.filter((row) => row.score >= band.min && row.score <= band.max);
      const wins = rows.filter((row) => row.won).length;
      return { label: band.label, count: rows.length, wins, losses: rows.length - wins, winRate: rows.length ? Math.round(wins / rows.length * 100) : null };
    });
    const resolvedWins = classified.filter((row) => row.won).length;
    const resolvedLosses = classified.length - resolvedWins;
    const latestOutcomes = [...classified].sort((a, b) => Date.parse(b.firstTradeAt ?? "") - Date.parse(a.firstTradeAt ?? "")).slice(0, 12);

    const computed = v2Rows.data ?? [];
    const average = (values: number[]) => values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0;
    const regimeCounts = computed.reduce((acc: Record<string, number>, row: any) => {
      const key = row.regime || "unknown";
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});
    const recentScans = (scans.data ?? []).map((scan: any) => ({
      ...scan,
      errors: Array.isArray(scan.errors) ? scan.errors : [],
      errorCount: Array.isArray(scan.errors) ? scan.errors.length : 0,
    }));
    const lastScan = recentScans[0] ?? null;
    const lastScanAgeMinutes = lastScan?.started_at
      ? Math.max(0, Math.round((Date.now() - Date.parse(lastScan.started_at)) / 60000))
      : null;

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      stats: {
        markets: markets.count ?? 0,
        trades: trades.count ?? 0,
        wallets: wallets.count ?? 0,
        alerts: alerts.count ?? 0,
        v2Signals: v2All.count ?? 0,
        qualifiedV2: v2Qualified.count ?? 0,
        snapshots: snapshots.count ?? 0,
        scans24h: scans24h.count ?? 0,
        averageScore: average(computed.map((row: any) => Number(row.score) || 0)),
        averageCoverage: average(computed.map((row: any) => Number(row.coverage) || 0)),
        computedV2: computed.length,
        regimes: regimeCounts,
        resolvedWins,
        resolvedLosses,
        resolvedSignals: classified.length,
        pendingSignals,
        unclassifiableSignals,
        winRate: classified.length ? Math.round(resolvedWins / classified.length * 100) : null,
        scoreBands,
      },
      latestSnapshotAt: latestSnapshot.data?.captured_at ?? null,
      lastScan,
      lastScanAgeMinutes,
      recentScans,
      latestOutcomes,
    });
  } catch (error) {
    console.error("[api/monitoring] Failed to load monitoring data", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Impossible de charger les statistiques de monitoring." },
      { status: 500 },
    );
  }
}
