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
      .gte("score", 50)
      .order("created_at", { ascending: false })
      .limit(500);

    if (error) throw error;

    const alertIds = (alerts ?? []).map((a) => a.id);
    const { data: signalsV2, error: signalsV2Error } = await db.from("scoring_v2_signals")
      .select("*").order("score", { ascending: false }).order("first_trade_at", { ascending: false }).limit(500);
    if (signalsV2Error) throw signalsV2Error;

    const marketIds = [...new Set([...(alerts ?? []).map((a) => a.market_id), ...(signalsV2 ?? []).map((s) => s.market_id)].filter(Boolean))];
    const tradeIds = [...new Set([...(alerts ?? []).flatMap((a) => a.trade_ids ?? []), ...(signalsV2 ?? []).flatMap((s) => s.trade_ids ?? [])])].slice(0, 10000);
    const [marketResult, tradeResult, scoreResult] = await Promise.all([
      marketIds.length
        ? db.from("markets").select("id,question,url,category,liquidity,volume,end_date,outcomes,outcome_prices").in("id", marketIds)
        : Promise.resolve({ data: [], error: null }),
      tradeIds.length
        ? db.from("trades").select("trade_id,transaction_hash,wallet,pseudonym,market_id,condition_id,side,outcome,price,size,usd_amount,traded_at").in("trade_id", tradeIds).order("traded_at", { ascending: false })
        : Promise.resolve({ data: [], error: null }),
      alertIds.length
        ? db.from("alert_scores_v2").select("alert_id,score,coverage,regime,factors,missing_data,model_version,computed_at").in("alert_id", alertIds)
        : Promise.resolve({ data: [], error: null }),
    ]);

    if (marketResult.error) throw marketResult.error;
    if (tradeResult.error) throw tradeResult.error;
    if (scoreResult.error) throw scoreResult.error;

    const markets = new Map<string, any>((marketResult.data ?? []).map((m): [string, any] => [m.id, m]));
    const trades = new Map<string, any>((tradeResult.data ?? []).map((t): [string, any] => [t.trade_id, t]));
    const v2Scores = new Map<string, any>((scoreResult.data ?? []).map((s): [string, any] => [s.alert_id, s]));

    return NextResponse.json({
      alerts: (alerts ?? []).map((alert) => ({
        ...alert,
        market: markets.get(alert.market_id) ?? null,
        trades: (alert.trade_ids ?? []).map((id: string) => trades.get(id)).filter(Boolean),
        scoring_v2: v2Scores.has(alert.id) ? {
          score: v2Scores.get(alert.id).score,
          coverage: v2Scores.get(alert.id).coverage,
          regime: v2Scores.get(alert.id).regime,
          factors: v2Scores.get(alert.id).factors ?? [],
          unavailable: v2Scores.get(alert.id).missing_data ?? [],
          model_version: v2Scores.get(alert.id).model_version,
          computed_at: v2Scores.get(alert.id).computed_at,
        } : null,
      })),
      signalsV2: (signalsV2 ?? []).map((signal) => ({
        ...signal,
        market: markets.get(signal.market_id) ?? null,
        trades: (signal.trade_ids ?? []).map((id: string) => trades.get(id)).filter(Boolean),
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
