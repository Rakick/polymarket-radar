export type Availability = number | null;

export const INFORMED_WEIGHTS = {
  account_age: 25,
  concentration: 25,
  relative_size: 25,
  absolute_amount: 15,
  simultaneity: 10,
} as const;

export type InformedFactor = {
  code: keyof typeof INFORMED_WEIGHTS;
  label: string;
  weight: number;
  subscore: number | null;
  contribution: number;
  available: boolean;
  detail: string;
};

export type VerifiedCondition = {
  code: string;
  label: string;
  value: boolean | null;
  detail: string;
};

export type InformedScoreInput = {
  totalUsd: number;
  price: number | null;
  accountAgeDays: Availability;
  concentrationRatio: Availability;
  comparableAmounts: number[] | null;
  simultaneousOtherWallets: number | null;
  historicalSimultaneityCounts: number[] | null;
};

export type InformedScoreResult = {
  score: number;
  coverage: number;
  factors: InformedFactor[];
  missing: string[];
  conditions: VerifiedCondition[];
};

const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

export function accountAgeSubscore(days: number): number {
  if (days <= 1) return 100;
  if (days <= 3) return 85;
  if (days <= 7) return 65;
  if (days <= 14) return 35;
  if (days <= 30) return 10;
  return 0;
}

export function absoluteAmountSubscore(amountUsd: number): number {
  return 100 * clamp(Math.log10(Math.max(amountUsd, 1) / 1000));
}

export function relativeSizeSubscore(amountUsd: number, comparables: number[] | null): number | null {
  if (!comparables || comparables.length < 100 || !Number.isFinite(amountUsd) || amountUsd <= 0) return null;
  const logs = comparables.filter(v => Number.isFinite(v) && v > 0).map(v => Math.log(Math.max(v, 1)));
  if (logs.length < 100) return null;
  const center = median(logs);
  if (center == null) return null;
  const mad = median(logs.map(v => Math.abs(v - center)));
  if (mad == null || mad <= 0) return null;
  const z = (Math.log(Math.max(amountUsd, 1)) - center) / (1.4826 * mad);
  return 100 * clamp((z - 1) / 3);
}

export function simultaneitySubscore(
  currentOtherWallets: number,
  historicalWindows: number[] | null,
): number | null {
  if (!historicalWindows || historicalWindows.length < 100) return null;
  if (currentOtherWallets < 2) return 0;
  const finite = historicalWindows.filter(Number.isFinite);
  if (finite.length < 100) return null;
  const percentile = finite.filter(value => value <= currentOtherWallets).length / finite.length;
  return 100 * clamp((percentile - 0.95) / 0.05);
}

function addFactor(
  code: keyof typeof INFORMED_WEIGHTS,
  label: string,
  subscore: number | null,
  detail: string,
): InformedFactor {
  const weight = INFORMED_WEIGHTS[code];
  const available = subscore !== null && Number.isFinite(subscore);
  const bounded = available ? Math.max(0, Math.min(100, subscore!)) : null;
  return {
    code, label, weight, subscore: bounded,
    contribution: available ? weight * bounded! / 100 : 0,
    available, detail,
  };
}

export function calculateInformedScore(input: InformedScoreInput): InformedScoreResult {
  const ageScore = input.accountAgeDays == null ? null : accountAgeSubscore(input.accountAgeDays);
  const concentrationScore = input.concentrationRatio == null
    ? null
    : 100 * clamp((input.concentrationRatio - 0.70) / 0.30);
  const sizeScore = relativeSizeSubscore(input.totalUsd, input.comparableAmounts);
  const amountScore = absoluteAmountSubscore(input.totalUsd);
  const simultaneousScore = input.simultaneousOtherWallets == null
    ? null
    : simultaneitySubscore(input.simultaneousOtherWallets, input.historicalSimultaneityCounts);

  const factors = [
    addFactor("account_age", "Ancienneté vérifiée du compte", ageScore,
      ageScore == null ? "Date de création Polymarket vérifiée indisponible" : `Compte âgé de ${input.accountAgeDays!.toFixed(1)} jour(s)`),
    addFactor("concentration", "Concentration sur le résultat ciblé", concentrationScore,
      concentrationScore == null ? "Historique BUY complet indisponible" : `${(input.concentrationRatio! * 100).toFixed(1)} % des achats historiques sur ce résultat`),
    addFactor("relative_size", "Taille exceptionnelle vs comparables", sizeScore,
      sizeScore == null ? "100 comparables de même marché, sens et bande de prix avec MAD positif requis" : `Comparaison robuste sur ${input.comparableAmounts!.length} transactions`),
    addFactor("absolute_amount", "Montant absolu", amountScore,
      `Montant observé : $${input.totalUsd.toFixed(2)}`),
    addFactor("simultaneity", "Simultanéité anormale multi-comptes", simultaneousScore,
      simultaneousScore == null ? "100 fenêtres historiques comparables requises" : `${input.simultaneousOtherWallets} autres comptes dans les 30 minutes précédentes`),
  ];

  const coverage = factors.reduce((sum, factor) => sum + (factor.available ? factor.weight : 0), 0);
  // Missing factors contribute zero. Their weights are never redistributed.
  const score = Math.round(factors.reduce((sum, factor) => sum + factor.contribution, 0));
  const values = Object.fromEntries(factors.map(factor => [factor.code, factor.subscore]));
  const conditions: VerifiedCondition[] = [
    { code: "buy_price_below_60c", label: "Achat à un prix inférieur à 60 ¢", value: input.price == null ? null : input.price < 0.60, detail: input.price == null ? "Prix moyen indisponible" : `Prix moyen : ${(input.price * 100).toFixed(2)} ¢` },
    { code: "amount_at_least_2500", label: "Montant de la transaction ≥ 2 500 $", value: Number.isFinite(input.totalUsd) ? input.totalUsd >= 2500 : null, detail: `Montant : $${input.totalUsd.toFixed(2)}` },
    { code: "account_age_at_most_7d", label: "Compte Polymarket vérifié âgé de 7 jours maximum", value: input.accountAgeDays == null ? null : input.accountAgeDays <= 7, detail: input.accountAgeDays == null ? "Date de création vérifiée indisponible" : `Âge vérifié : ${input.accountAgeDays.toFixed(1)} jour(s)` },
    { code: "concentration_at_least_90", label: "Concentration sur ce résultat ≥ 90 %", value: input.concentrationRatio == null ? null : input.concentrationRatio >= 0.90, detail: input.concentrationRatio == null ? "Historique complet indisponible" : `Concentration : ${(input.concentrationRatio * 100).toFixed(1)} %` },
    { code: "relative_size_at_least_70", label: "Score de taille relative ≥ 70/100", value: sizeScore == null ? null : sizeScore >= 70, detail: sizeScore == null ? "Baseline comparable non vérifiable" : `Score de taille : ${sizeScore.toFixed(1)}/100` },
    { code: "score_at_least_80", label: "Score global ≥ 80/100", value: score >= 80, detail: `Score calculé : ${score}/100` },
  ];

  return {
    score, coverage, factors,
    missing: factors.filter(factor => !factor.available).map(factor => factor.code),
    conditions,
  };
}
