export type V2Alert = {
  id: string; wallet: string; market_id: string; total_usd: number;
  first_trade_at: string | null; last_trade_at: string | null;
  market: { volume: number | null; end_date: string | null } | null;
};
export type V2Factor = { code: string; label: string; score: number; weight: number; detail: string };
export type V2Result = { score: number; coverage: number; factors: V2Factor[]; unavailable: string[] };

const clamp = (n: number, min = 0, max = 100) => Math.max(min, Math.min(max, n));
const median = (values: number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const percentileScore = (z: number) => clamp(50 + 20 * z);
const daysBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86400000;

/**
 * Experimental parallel score. It deliberately scores only observable fields:
 * peer-alert size baseline, trade/market-volume proxy, resolution timing,
 * and co-alert activity. Wallet skill and post-trade impact are not inferred.
 */
export function computeV2Scores(alerts: V2Alert[]): Map<string, V2Result> {
  const byMarket = new Map<string, V2Alert[]>();
  const byWallet = new Map<string, V2Alert[]>();
  for (const alert of alerts) {
    byMarket.set(alert.market_id, [...(byMarket.get(alert.market_id) ?? []), alert]);
    byWallet.set(alert.wallet.toLowerCase(), [...(byWallet.get(alert.wallet.toLowerCase()) ?? []), alert]);
  }

  const results = new Map<string, V2Result>();
  for (const alert of alerts) {
    const marketPeers = (byMarket.get(alert.market_id) ?? []).filter(a => a.id !== alert.id && a.total_usd > 0);
    const globalPeers = alerts.filter(a => a.id !== alert.id && a.total_usd > 0);
    const reference = marketPeers.length >= 5 ? marketPeers : globalPeers;
    const amounts = reference.map(a => Math.log10(Math.max(1, a.total_usd)));
    const center = median(amounts);
    const mad = median(amounts.map(v => Math.abs(v - center)));
    const current = Math.log10(Math.max(1, alert.total_usd));
    const robustZ = mad > 0 ? (current - center) / (1.4826 * mad) : 0;
    const sizeScore = reference.length >= 5 ? percentileScore(robustZ) : null;

    const marketVolume = Number(alert.market?.volume ?? 0);
    const volumeShare = marketVolume > 0 ? alert.total_usd / marketVolume : 0;
    const convictionScore = marketVolume > 0 ? clamp(50 + 18 * Math.log10(Math.max(volumeShare, 0.000001) / 0.001)) : null;

    const tradeAt = alert.first_trade_at ?? alert.last_trade_at;
    const endAt = alert.market?.end_date;
    let timingScore: number | null = null;
    let timingDetail = "Date de résolution indisponible";
    if (tradeAt && endAt && Number.isFinite(Date.parse(tradeAt)) && Number.isFinite(Date.parse(endAt))) {
      const days = daysBetween(tradeAt, endAt);
      if (days >= 0) {
        timingScore = clamp(100 - Math.abs(Math.log10(days + 0.25) - 0.7) * 42);
        timingDetail = `${days.toFixed(1)} jours avant la résolution`;
      } else {
        timingScore = 0;
        timingDetail = "Transaction postérieure à la résolution indiquée";
      }
    }

    const nearby = marketPeers.filter(peer => {
      const a = Date.parse(alert.first_trade_at ?? alert.last_trade_at ?? "");
      const b = Date.parse(peer.first_trade_at ?? peer.last_trade_at ?? "");
      return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 30 * 60_000 && peer.wallet.toLowerCase() !== alert.wallet.toLowerCase();
    });
    const coordinationScore = clamp((new Set(nearby.map(a => a.wallet.toLowerCase())).size / 4) * 100);

    const candidates: V2Factor[] = [
      ...(sizeScore == null ? [] : [{ code: "relative_size", label: "Taille relative", score: sizeScore, weight: 20, detail: `Écart robuste vs ${reference.length} alertes comparables (${marketPeers.length >= 5 ? "même marché" : "référence globale"})` }]),
      ...(convictionScore == null ? [] : [{ code: "conviction", label: "Conviction financière", score: convictionScore, weight: 15, detail: `${(volumeShare * 100).toFixed(3)} % du volume cumulé du marché (proxy, pas volume 24 h)` }]),
      ...(timingScore == null ? [] : [{ code: "timing", label: "Timing", score: timingScore, weight: 10, detail: timingDetail }]),
      { code: "coordination", label: "Coordination observée", score: coordinationScore, weight: 10, detail: `${new Set(nearby.map(a => a.wallet.toLowerCase())).size} autre(s) portefeuille(s) alerté(s) dans une fenêtre de 30 min` },
    ];
    const weightTotal = candidates.reduce((sum, f) => sum + f.weight, 0);
    const score = weightTotal ? Math.round(candidates.reduce((sum, f) => sum + f.score * f.weight, 0) / weightTotal) : 0;
    const unavailable = [
      ...(reference.length < 5 ? ["baseline robuste de taille (moins de 5 comparables)"] : []),
      ...(marketVolume <= 0 ? ["volume du marché"] : []),
      ...(!tradeAt || !endAt ? ["timing / date de résolution"] : []),
      "profil historique fiable du wallet (ROI, win rate, ancienneté)",
      "impact réel du trade après exécution (snapshots de prix absents)",
    ];
    results.set(alert.id, { score, coverage: Math.round(weightTotal), factors: candidates.sort((a,b) => b.score*b.weight - a.score*a.weight), unavailable });
  }
  return results;
}
