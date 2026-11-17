export type ScoreInput = {
  totalUsd: number;
  price: number | null;
  accountAgeDays: number | null;
  concentrationRatio: number | null;
  comparableAmounts: number[] | null;
  simultaneousOtherWallets: number | null;
  historicalSimultaneityCounts: number[] | null;
};

export const WEIGHTS = { account_age: 25, concentration: 25, relative_size: 25, absolute_amount: 15, simultaneity: 10 } as const;

export type ScoreFactor = {
  code: keyof typeof WEIGHTS; label: string; weight: number; subscore: number | null;
  contribution: number; available: boolean; detail: string;
};
export type ScoreCondition = { code: string; label: string; value: boolean | null; detail: string };
export type ScoreResult = { score: number; coverage: number; factors: ScoreFactor[]; missing: string[]; conditions: ScoreCondition[] };

const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const median = (values: number[]) => {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const mid = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[mid] : (ordered[mid - 1] + ordered[mid]) / 2;
};
export function accountAgeScore(days: number): number {
  if (days <= 1) return 100;
  if (days <= 3) return 85;
  if (days <= 7) return 65;
  if (days <= 14) return 35;
  if (days <= 30) return 10;
  return 0;
}
export function amountScore(amount: number): number {
  return 100 * clamp(Math.log10(Math.max(amount, 1) / 1000));
}
export function relativeSizeScore(amount: number, comparables: number[] | null): number | null {
  if (!comparables || comparables.length < 100 || !(amount > 0)) return null;
  const logs = comparables.filter(v => Number.isFinite(v) && v > 0).map(v => Math.log(Math.max(v, 1)));
  if (logs.length < 100) return null;
  const center = median(logs);
  if (center == null) return null;
  const mad = median(logs.map(v => Math.abs(v - center)));
  if (mad == null || mad <= 0) return null;
  const z = (Math.log(Math.max(amount, 1)) - center) / (1.4826 * mad);
  return 100 * clamp((z - 1) / 3);
}
export function simultaneityScore(current: number, historical: number[] | null): number | null {
  // The model explicitly assigns zero when fewer than two other wallets qualify,
  // even when a historical percentile baseline is not yet available.
  if (current < 2) return 0;
  if (!historical || historical.length < 100) return null;
  const values = historical.filter(Number.isFinite);
  if (values.length < 100) return null;
  const percentile = values.filter(value => value <= current).length / values.length;
  return 100 * clamp((percentile - 0.95) / 0.05);
}

export function calculateInformedScore(input: ScoreInput): ScoreResult {
  const age = input.accountAgeDays == null ? null : accountAgeScore(input.accountAgeDays);
  const concentration = input.concentrationRatio == null ? null : 100 * clamp((input.concentrationRatio - 0.70) / 0.30);
  const size = relativeSizeScore(input.totalUsd, input.comparableAmounts);
  const absolute = amountScore(input.totalUsd);
  const simultaneous = input.simultaneousOtherWallets == null
    ? null : simultaneityScore(input.simultaneousOtherWallets, input.historicalSimultaneityCounts);

  const make = (code: keyof typeof WEIGHTS, label: string, subscore: number | null, detail: string): ScoreFactor => {
    const available = subscore !== null && Number.isFinite(subscore);
    const safe = available ? Math.max(0, Math.min(100, subscore!)) : null;
    return { code, label, weight: WEIGHTS[code], subscore: safe, contribution: available ? WEIGHTS[code] * safe! / 100 : 0, available, detail };
  };
  const factors = [
    make("account_age", "Ancienneté observée du compte", age, age == null ? "Première activité Polymarket complète indisponible" : `Première activité observée il y a ${input.accountAgeDays!.toFixed(1)} jour(s)`),
    make("concentration", "Concentration sur le résultat ciblé", concentration, concentration == null ? "Historique BUY complet indisponible" : `${(input.concentrationRatio! * 100).toFixed(1)} % des achats historiques sur ce résultat`),
    make("relative_size", "Taille exceptionnelle vs comparables", size, size == null ? "100 comparables de même marché, sens et bande de prix avec MAD positif requis" : `Comparaison robuste sur ${input.comparableAmounts!.length} transactions`),
    make("absolute_amount", "Montant absolu", absolute, `Montant observé : $${input.totalUsd.toFixed(2)}`),
    make("simultaneity", "Simultanéité anormale multi-comptes", simultaneous, simultaneous == null ? "100 fenêtres historiques comparables requises" : `${input.simultaneousOtherWallets} autres comptes dans les 30 minutes précédentes`),
  ];
  const coverage = factors.reduce((sum, factor) => sum + (factor.available ? factor.weight : 0), 0);
  // Missing factors contribute zero. Their weights are never redistributed.
  const score = Math.round(factors.reduce((sum, factor) => sum + factor.contribution, 0));
  const conditions: ScoreCondition[] = [
    { code: "buy_price_below_60c", label: "Achat à un prix inférieur à 60 ¢", value: input.price == null ? null : input.price < 0.60, detail: input.price == null ? "Prix moyen indisponible" : `Prix moyen : ${(input.price * 100).toFixed(2)} ¢` },
    { code: "amount_at_least_2500", label: "Montant de la transaction ≥ 2 500 $", value: Number.isFinite(input.totalUsd) ? input.totalUsd >= 2500 : null, detail: `Montant : $${input.totalUsd.toFixed(2)}` },
    { code: "account_age_at_most_7d", label: "Première activité Polymarket observée depuis 7 jours maximum", value: input.accountAgeDays == null ? null : input.accountAgeDays <= 7, detail: input.accountAgeDays == null ? "Historique complet de première activité indisponible" : `Depuis la première activité : ${input.accountAgeDays.toFixed(1)} jour(s)` },
    { code: "concentration_at_least_90", label: "Concentration sur ce résultat ≥ 90 %", value: input.concentrationRatio == null ? null : input.concentrationRatio >= 0.90, detail: input.concentrationRatio == null ? "Historique complet indisponible" : `Concentration : ${(input.concentrationRatio * 100).toFixed(1)} %` },
    { code: "relative_size_at_least_70", label: "Score de taille relative ≥ 70/100", value: size == null ? null : size >= 70, detail: size == null ? "Baseline comparable non vérifiable" : `Score de taille : ${size.toFixed(1)}/100` },
    { code: "score_at_least_80", label: "Score global ≥ 80/100", value: score >= 80, detail: `Score calculé : ${score}/100` },
  ];
  return { score, coverage, factors, missing: factors.filter(factor => !factor.available).map(factor => factor.code), conditions };
}
