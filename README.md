# Polymarket Radar

Surveillance des marchés politiques ouverts de Polymarket, détection d'activité statistiquement atypique et tableau de bord bilingue (FR/EN), privé, pour un seul utilisateur.

> ⚠️ Cet outil signale des transactions à examiner, pas des fraudeurs. Le score est un outil de priorisation, pas une preuve de fraude.

## Installation

```bash
npm install
cp .env.example .env.local
npm run dev
```

Les API Polymarket utilisées sont publiques. Configurez Supabase et exécutez `supabase/schema.sql`.
.


## Scoring V2 (parallel engine)

The legacy detector remains available and unchanged. The V2 engine independently groups observed BUY and SELL trades in 30-minute windows on monitored markets, without the legacy 20-cent price cutoff. It stores candidate signals in `scoring_v2_signals` and legacy-alert comparisons in `alert_scores_v2`.

V2 uses market-level log-size median/MAD, trade size relative to current market liquidity, observed wallet history, time to resolution, post-trade outcome-price movement when snapshots exist, and same-outcome/same-side wallet coordination. Price-regime weights blend smoothly around 0.20 and 0.80. Market snapshots are captured as the scanner refreshes Gamma market data and retained for 90 days.

Important limitations are surfaced per signal: wallet ROI/win rate require a sufficiently rich resolved-market history; price-impact scores require snapshots before and after a trade; wallet history is limited to activity observed by Radar; and the scanner covers its configured categories and rolling market batches. V2 scores are a triage/ranking signal, not evidence of manipulation or insider information.
