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
      },
      latestSnapshotAt: latestSnapshot.data?.captured_at ?? null,
      lastScan,
      lastScanAgeMinutes,
      recentScans,
    });
  } catch (error) {
    console.error("[api/monitoring] Failed to load monitoring data", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Impossible de charger les statistiques de monitoring." },
      { status: 500 },
    );
  }
}
