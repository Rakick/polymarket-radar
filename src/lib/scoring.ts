import type {Alert,Factor,Settings,Trade} from "./types";
export interface ScoreContext {
  trades:Trade[];
  walletFirstSeenAt:string|null;
  walletRecentVolumeUsd:number|null;
  walletTotalVolumeUsd:number|null;
  marketLiquidityUsd:number|null;
  coordinatedWalletCount?:number;
}
const clamp=(v:number,min=0,max=1)=>Math.max(min,Math.min(max,v));
export function minimumStakeForPrice(price:number):number|null {
  if (!Number.isFinite(price) || price<=0 || price>.2) return null;
  if (price<.05) return 500;
  if (price<.10) return 1000;
  return 5000;
}
export function computeScore(ctx:ScoreContext,s:Settings) {
  const trades=ctx.trades.filter(t=>t.side==="BUY");
  const total=trades.reduce((a,t)=>a+t.usd_amount,0);
  const weightedPrice=total>0?trades.reduce((a,t)=>a+t.price*t.usd_amount,0)/total:0;
  const minimum=minimumStakeForPrice(weightedPrice);
  const factors:Factor[]=[],missing:string[]=[];
  const w=s.weights;
  const push=(code:string,fr:string,en:string,points:number,detail:string)=>{
    const rounded=Math.round(points*10)/10;
    if(rounded>.01) factors.push({code,label_fr:fr,label_en:en,points:rounded,detail});
  };
  if(!trades.length || minimum===null || total<minimum) {
    missing.push("below_detection_threshold");
    return {score:0,factors,confidence:"low" as const,missing_data:missing};
  }
  const oddsMultiplier=clamp(Math.pow(.10/Math.max(weightedPrice,.01),1.35),.5,10);
  const adjusted=total*oddsMultiplier;
  push("adjusted_amount","Montant ajusté à la cote","Odds-adjusted amount",w.adjusted_amount*clamp(Math.log10(Math.max(1,adjusted/500))/1.5),`${Math.round(total)} USD réels · ${Math.round(adjusted)} USD équivalents à ${(weightedPrice*100).toFixed(1)} c`);
  if(ctx.walletFirstSeenAt) {
    const ageDays=Math.max(0,(Date.now()-new Date(ctx.walletFirstSeenAt).getTime())/86400000);
    push("wallet_age","Ancienneté vérifiée du portefeuille","Verified wallet age",w.wallet_age*(1-clamp(ageDays/s.account_age_days)),`Première activité observée il y a ${ageDays.toFixed(1)} jours`);
  } else missing.push("wallet_age");
  if(ctx.walletRecentVolumeUsd && ctx.walletRecentVolumeUsd>0) {
    const average=ctx.walletRecentVolumeUsd;
    push("wallet_anomaly","Mise inhabituelle dans l'historique observé","Unusual observed wallet stake",w.wallet_anomaly*clamp(Math.log10(Math.max(1,total/average))/2),`${Math.round(total)} USD comparés à ${Math.round(average)} USD de référence observée`);
    missing.push("wallet_baseline_partial");
  } else missing.push("wallet_baseline");
  if(ctx.marketLiquidityUsd && ctx.marketLiquidityUsd>0) {
    push("liquidity_impact","Poids de la mise dans la liquidité","Stake relative to liquidity",w.liquidity_impact*clamp(total/ctx.marketLiquidityUsd/.1),`${Math.round(total)} USD pour ${Math.round(ctx.marketLiquidityUsd)} USD de liquidité`);
  } else missing.push("market_liquidity");
  const outcomes=new Map<string,number>();
  for(const trade of trades) {
    const key=trade.outcome??"unknown";
    outcomes.set(key,(outcomes.get(key)??0)+trade.usd_amount);
  }
  if(trades.length>1) {
    const dominantShare=total>0?Math.max(...outcomes.values())/total:0;
    push("concentration","Concentration sur un même résultat","Concentration on one outcome",w.concentration*clamp((dominantShare-.5)/.5),`${Math.round(dominantShare*100)} % de la mise sur le résultat dominant`);
  }
  const span=Math.max(1,(Date.parse(trades[trades.length-1].traded_at)-Date.parse(trades[0].traded_at))/60000);
  push("repetition","Achats répétés et rapprochés","Repeated close purchases",w.repetition*clamp((trades.length-1)/5)*(1-clamp(span/Math.max(1,s.group_window_minutes)),`${trades.length} achats regroupés sur ${span.toFixed(1)} minutes`);
  if(ctx.coordinatedWalletCount!==undefined) push("coordination","Activité simultanée entre portefeuilles","Coordinated wallet activity",w.coordination*clamp(ctx.coordinatedWalletCount/4),`${ctx.coordinatedWalletCount} autres portefeuilles concernés`);
  else missing.push("coordination_data");
  const score=Math.max(0,Math.min(100,Math.round(factors.reduce((a,x)=>a+x.points,0))));
  return {score,factors:factors.sort((a,b)=>b.points-a.points),confidence:missing.length===0?"high":missing.length<=1?"medium":"low",missing_data:missing} as const;
}
