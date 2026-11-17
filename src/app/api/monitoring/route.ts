import { NextRequest, NextResponse } from "next/server";
import { adminClient } from "@/lib/supabase";
import { hasAuthenticatedUser } from "@/lib/api-auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const MODEL_VERSION = "informed-buy-v1";

export async function GET(request: NextRequest) {
  if (!(await hasAuthenticatedUser(request))) {
    return NextResponse.json({ error: "Session expirée. Reconnectez-vous." }, { status: 401 });
  }
  try {
    const db = adminClient();
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const [markets, trades, wallets, alerts, scored, pending, recentScans, scans24h] = await Promise.all([
      db.from("markets").select("id", { count: "exact", head: true }),
      db.from("trades").select("trade_id", { count: "exact", head: true }),
      db.from("wallets").select("address", { count: "exact", head: true }),
      db.from("alerts").select("id", { count: "exact", head: true }).eq("model_version", MODEL_VERSION).gte("score", 50),
      db.from("alerts").select("score,coverage").eq("model_version", MODEL_VERSION),
      db.from("alerts").select("id", { count: "exact", head: true }).is("model_version", null),
      db.from("scans").select("id,started_at,finished_at,status,markets_scanned,trades_fetched,trades_new,alerts_created,errors").order("started_at", { ascending: false }).limit(12),
      db.from("scans").select("id", { count: "exact", head: true }).gte("started_at", since24h),
    ]);
    const failed = [markets, trades, wallets, alerts, scored, pending, recentScans, scans24h].find(result => result.error);
    if (failed?.error) throw failed.error;

    const rows = scored.data ?? [];
    const average = (values: number[]) => values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0;
    const scans = (recentScans.data ?? []).map(scan => ({
      ...scan,
      errors: Array.isArray(scan.errors) ? scan.errors : [],
      errorCount: Array.isArray(scan.errors) ? scan.errors.length : 0,
    }));
    const lastScan = scans[0] ?? null;
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
        pendingAlerts: pending.count ?? 0,
        scoredAlerts: rows.length,
        averageScore: average(rows.map(row => Number(row.score) || 0)),
        averageCoverage: average(rows.map(row => Number(row.coverage) || 0)),
        priorityAlerts: rows.filter(row => Number(row.score) >= 90).length,
        scans24h: scans24h.count ?? 0,
      },
      lastScan,
      lastScanAgeMinutes,
      recentScans: scans,
    });
  } catch (error) {
    console.error("[api/monitoring] Failed to load unified scoring data", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Impossible de charger les statistiques de monitoring." },
      { status: 500 },
    );
  }
}
