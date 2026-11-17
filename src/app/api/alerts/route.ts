import { NextRequest, NextResponse } from "next/server";
import { adminClient } from "@/lib/supabase";
import { hasAuthenticatedUser } from "@/lib/api-auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const MODEL_VERSION = "informed-buy-v1";
const DISPLAY_MIN_SCORE = 50;

export async function GET(request: NextRequest) {
  if (!(await hasAuthenticatedUser(request))) {
    return NextResponse.json({ error: "Session expirée. Reconnectez-vous." }, { status: 401 });
  }

  try {
    const db = adminClient();
    const { data: alerts, error } = await db.from("alerts")
      .select("*")
      .eq("model_version", MODEL_VERSION)
      .gte("score", DISPLAY_MIN_SCORE)
      .order("score", { ascending: false })
      .order("first_trade_at", { ascending: false })
      .limit(500);
    if (error) throw error;

    const marketIds = [...new Set((alerts ?? []).map(alert => alert.market_id).filter(Boolean))];
    const tradeIds = [...new Set((alerts ?? []).flatMap(alert => alert.trade_ids ?? []))].slice(0, 10000);
    const [marketResult, tradeResult] = await Promise.all([
      marketIds.length
        ? db.from("markets").select("id,question,url,category,liquidity,volume,end_date").in("id", marketIds)
        : Promise.resolve({ data: [], error: null }),
      tradeIds.length
        ? db.from("trades").select("trade_id,transaction_hash,wallet,pseudonym,side,outcome,price,size,usd_amount,traded_at").in("trade_id", tradeIds).order("traded_at", { ascending: false })
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (marketResult.error) throw marketResult.error;
    if (tradeResult.error) throw tradeResult.error;

    const markets = new Map<string, any>((marketResult.data ?? []).map(market => [market.id, market]));
    const trades = new Map<string, any>((tradeResult.data ?? []).map(trade => [trade.trade_id, trade]));
    return NextResponse.json({
      alerts: (alerts ?? []).map(alert => {
        const alertTrades = (alert.trade_ids ?? [])
          .map((id: string) => trades.get(id))
          .filter(Boolean);
        return {
          ...alert,
          side: "BUY",
          // Legacy alerts may have a null outcome even though their stored fills
          // contain it. Use the transaction as the source of truth for display.
          outcome: alert.outcome ?? alertTrades.find((trade: any) => trade.outcome)?.outcome ?? null,
          market: markets.get(alert.market_id) ?? null,
          trades: alertTrades,
        };
      }),
      total: alerts?.length ?? 0,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[api/alerts] Failed to load unified BUY alerts", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Impossible de charger les alertes." },
      { status: 500 },
    );
  }
}
