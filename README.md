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
