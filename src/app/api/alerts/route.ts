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
    const { data: alerts, error } = await db
      .from("alerts")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(500);

    if (error) throw error;

    const marketIds = [...new Set((alerts ?? []).map((a) => a.market_id).filter(Boolean))];
    const tradeIds = [...new Set((alerts ?? []).flatMap((a) => a.trade_ids ?? []))].slice(0, 10000);

    const [marketResult, tradeResult] = await Promise.all([
      marketIds.length
        ? db.from("markets").select("id,question,url,category,liquidity,volume,end_date,outcomes,outcome_prices").in("id", marketIds)
        : Promise.resolve({ data: [], error: null }),
      tradeIds.length
        ? db.from("trades").select("trade_id,transaction_hash,wallet,pseudonym,market_id,condition_id,side,outcome,price,size,usd_amount,traded_at").in("trade_id", tradeIds).order("traded_at", { ascending: false })
        : Promise.resolve({ data: [], error: null }),
    ]);

    if (marketResult.error) throw marketResult.error;
    if (tradeResult.error) throw tradeResult.error;

    const markets = new Map((marketResult.data ?? []).map((m) => [m.id, m]));
    const trades = new Map((tradeResult.data ?? []).map((t) => [t.trade_id, t]));

    return NextResponse.json({
      alerts: (alerts ?? []).map((alert) => ({
        ...alert,
        market: markets.get(alert.market_id) ?? null,
        trades: (alert.trade_ids ?? []).map((id: string) => trades.get(id)).filter(Boolean),
      })),
      total: alerts?.length ?? 0,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[api/alerts] Failed to load alerts", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Impossible de charger les alertes." },
      { status: 500 },
    );
  }
}
