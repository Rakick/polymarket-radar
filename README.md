# Polymarket Radar

**Polymarket Radar** est un outil d'observation et d'analyse des marchés de prédiction Polymarket. Il collecte les transactions sur un ensemble de marchés suivis, détecte des comportements inhabituels de portefeuilles et transforme ces observations en alertes et signaux classés par score.

Le projet est conçu comme un tableau de bord d'intelligence de marché : il aide à repérer des activités qui méritent une analyse plus approfondie. **Il ne prédit pas avec certitude les résultats, ne prouve pas une manipulation et ne constitue pas un conseil financier.**

> **Statut du produit : accès privé / pré-lancement.** Le dépôt de code est public, mais l'application n'est pas encore ouverte au public. L'ouverture publique est prévue ultérieurement, après les étapes de validation, de sécurité et de fiabilisation nécessaires.

---

## Fonctionnalités

### Détection et alertes

- Collecte des transactions Polymarket sur les marchés suivis.
- Analyse des achats et ventes, des montants, des prix, des portefeuilles et du contexte du marché.
- Détection d'activités atypiques : tailles de position inhabituelles, répétition d'achats, concentration sur un résultat et activité coordonnée entre portefeuilles.
- Regroupement de transactions proches dans le temps afin de faire ressortir une activité cohérente.
- Alertes V1 et signaux du moteur V2 consultables dans le tableau de bord.

### Scoring V2

Le moteur V2 est le moteur d'analyse principal. Il attribue un score sur 100 aux signaux à partir des données disponibles, notamment :

- la taille de l'activité par rapport aux observations comparables ;
- le montant engagé et son poids relatif dans le marché ;
- le timing par rapport à la date de résolution ;
- l'activité simultanée d'autres portefeuilles sur le même marché et le même résultat ;
- les informations historiques disponibles et la couverture des facteurs.

Les signaux dont le score calculé est inférieur à 50 restent conservés dans la base pour l'analyse, mais ne sont pas affichés dans la liste principale des signaux.

**Important :** le score mesure le caractère remarquable d'une activité observée, pas la probabilité que le pari soit gagnant. Un score élevé ne signifie pas qu'un portefeuille possède une information privilégiée.

### Régimes de marché

Les étiquettes **Favorite**, **Contested** et **Longshot** décrivent le niveau de probabilité implicite du résultat sur le marché. Elles ne qualifient pas la qualité du signal et ne remplacent pas le score V2.

### Monitoring et évaluation des résultats

Le centre de monitoring donne une vue opérationnelle et statistique du système :

- état des exécutions du scanner et journal des derniers scans ;
- volumes de marchés, transactions, portefeuilles, alertes, signaux et snapshots enregistrés ;
- qualité et couverture des calculs V2 ;
- répartition des régimes de marché ;
- résultats des signaux V2 après résolution des marchés ;
- taux de réussite et résultats par tranche de score ;
- derniers signaux évalués.

Les résultats ne sont classés gagnants ou perdants que lorsqu'un marché est fermé et que son issue finale est confirmée par des prix de résolution non ambigus. L'évaluation directionnelle porte sur les signaux **BUY** : une vente peut simplement correspondre à la clôture d'une position et ne signifie pas nécessairement un pari contre le résultat. Les signaux non évaluables restent en attente ou sont exclus des statistiques de réussite.

---

## Comment ça fonctionne

1. **Collecte** — le scanner récupère les marchés suivis et leurs transactions via les API publiques de Polymarket.
2. **Normalisation et stockage** — les marchés, transactions, portefeuilles, snapshots et exécutions sont enregistrés dans Supabase.
3. **Détection** — les moteurs V1 et V2 analysent les activités observées et produisent des alertes ou des signaux.
4. **Scoring** — les signaux V2 sont évalués à partir des facteurs disponibles ; les données manquantes sont signalées plutôt que supposées.
5. **Résolution** — les marchés arrivés à échéance sont revérifiés auprès de Polymarket. Les résultats ne sont évalués qu'une fois l'issue finale confirmée.
6. **Monitoring** — le tableau de bord présente les données collectées, l'état du scanner et les performances historiques observées.

Le scanner travaille sur un univers de marchés configuré et traite les marchés par lots. Les statistiques reflètent donc le périmètre effectivement suivi par l'application, et non l'intégralité de l'activité Polymarket.

---

## Stack technique

- **Application :** Next.js 14, React 18 et TypeScript
- **Base de données et authentification :** Supabase / PostgreSQL
- **Sources de données :** API publiques Polymarket (Gamma et Data API)
- **Déploiement web :** Vercel
- **Collecte planifiée :** Supabase Edge Function `polymarket-hourly-scan`

L'interface propose une expérience bilingue français / anglais et des thèmes clair / sombre.

---

## Configuration locale

### Prérequis

- Node.js et npm
- Un projet Supabase
- Des identifiants d'accès aux API publiques Polymarket (aucune clé Polymarket privée n'est requise pour la collecte publique)

### Installation

```bash
git clone https://github.com/Rakick/polymarket-radar.git
cd polymarket-radar
npm install
cp .env.example .env.local
```

Renseignez ensuite les variables d'environnement :

```dotenv
# Valeurs publiques Supabase utilisées par le navigateur
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=YOUR_SUPABASE_PUBLISHABLE_OR_ANON_KEY

# Secrets réservés au serveur — ne jamais les exposer au navigateur
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
SUPABASE_SERVICE_ROLE_KEY=YOUR_SUPABASE_SERVICE_ROLE_KEY

# Secret long et aléatoire utilisé pour protéger les déclenchements de scan
CRON_SECRET=GENERATE_A_LONG_RANDOM_SECRET
```

Ne commitez jamais de véritables secrets. En particulier, `SUPABASE_SERVICE_ROLE_KEY` et `CRON_SECRET` ne doivent jamais être préfixés par `NEXT_PUBLIC_` ni être intégrés au code client.

### Base de données et scanner

1. Configurez le projet Supabase et appliquez les scripts SQL / migrations du dépôt dans l'ordre prévu.
2. Vérifiez les politiques d'accès et les paramètres d'authentification Supabase avant d'exposer une instance.
3. Déployez la fonction Edge `polymarket-hourly-scan` avec ses secrets serveur.
4. Configurez le déclenchement planifié du scanner dans votre environnement d'exploitation. Ne rendez pas son endpoint public sans protection.
5. Configurez les mêmes variables d'environnement dans votre environnement Next.js.

### Lancer l'application

```bash
npm run dev
```

L'application est alors disponible localement à l'adresse http://localhost:3000.

### Vérifications

```bash
npm test
npm run build
```

---

## Sécurité et ouverture publique

Le dépôt est public, mais cela ne signifie pas que l'instance hébergée est ouverte au public. L'application actuelle utilise l'authentification Supabase pour protéger les routes de données et le monitoring.

Avant une ouverture publique, il faudra notamment valider :

- le modèle d'accès (consultation publique, comptes utilisateurs ou accès limité) ;
- les politiques RLS et les droits d'accès aux tables et vues Supabase ;
- l'isolation des données et la protection des secrets serveur ;
- les limites de débit, la résilience des API et le coût de la collecte ;
- les mentions légales, la politique de confidentialité et les avertissements liés aux risques financiers.

Aucune donnée sensible ni aucun secret d'exploitation ne doit être publié dans le dépôt.

---

## Limites et interprétation

Polymarket Radar analyse des données observables et incomplètes. Ses résultats peuvent être affectés par :

- la couverture partielle des marchés et des fenêtres de collecte ;
- les limites, retards ou changements des API externes ;
- l'historique incomplet des portefeuilles observé par Radar ;
- l'absence de snapshots avant ou après certaines transactions ;
- les marchés dont la résolution est retardée ou dont les prix finaux ne sont pas encore vérifiables ;
- les biais statistiques liés au nombre limité de signaux résolus.

Un signal gagnant ne prouve pas que le portefeuille avait anticipé le résultat. Un signal perdant ne signifie pas que l'activité initiale était frauduleuse ou dépourvue d'intérêt. Les taux de réussite historiques ne garantissent aucune performance future.

**Polymarket Radar est un outil d'analyse et de recherche, pas un service de conseil en investissement ou une recommandation de pari.** Toute décision financière reste sous la responsabilité de l'utilisateur.

---

## Contribution

Les retours, rapports de bugs et propositions d'amélioration sont les bienvenus via les issues GitHub. Pour les problèmes de sécurité, évitez de publier des détails exploitables ou des secrets dans une issue publique.

## Licence

Aucune licence open source n'est actuellement déclarée dans ce dépôt. Sauf ajout explicite d'une licence, le code reste soumis aux droits de son titulaire et sa réutilisation n'est pas automatiquement autorisée.
