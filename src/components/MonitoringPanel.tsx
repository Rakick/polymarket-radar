"use client";

import { useCallback, useEffect, useState } from "react";
import { browserClient } from "@/lib/supabase";

type Scan = {
  id: string;
  started_at: string;
  finished_at: string | null;
  status: string | null;
  markets_scanned: number;
  trades_fetched: number;
  trades_new: number;
  alerts_created: number;
  errors: unknown[];
  errorCount: number;
};
type MonitoringData = {
  generatedAt: string;
  stats: {
    markets: number; trades: number; wallets: number; alerts: number;
    v2Signals: number; qualifiedV2: number; snapshots: number; scans24h: number;
    averageScore: number; averageCoverage: number; computedV2: number;
    regimes: Record<string, number>;
    resolvedWins: number; resolvedLosses: number; resolvedSignals: number;
    pendingSignals: number; unclassifiableSignals: number; winRate: number | null;
    scoreBands: Array<{ label: string; count: number; wins: number; losses: number; winRate: number | null }>;
  };
  latestSnapshotAt: string | null;
  lastScan: Scan | null;
  lastScanAgeMinutes: number | null;
  recentScans: Scan[];
  latestOutcomes: Array<{ id: string; question: string; marketUrl: string | null; outcome: string; side: string; score: number; totalUsd: number; firstTradeAt: string | null; won: boolean }>;
};

const number = (value: number) => new Intl.NumberFormat("fr-FR").format(value);
const date = (value: string | null) => value
  ? new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))
  : "Non disponible";
const duration = (minutes: number | null) => {
  if (minutes == null) return "Aucune exécution enregistrée";
  if (minutes < 1) return "À l’instant";
  if (minutes < 60) return `Il y a ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `Il y a ${hours} h ${minutes % 60} min`;
};
const scanStatus = (status: string | null) => {
  const value = (status ?? "").toLowerCase();
  if (["success", "completed", "ok", "finished"].includes(value)) return "success";
  if (["running", "started", "processing"].includes(value)) return "running";
  if (["failed", "error"].includes(value)) return "failed";
  if (["partial"].includes(value)) return "partial";
  return "unknown";
};

export default function MonitoringPanel() {
  const [data, setData] = useState<MonitoringData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    setError("");
    try {
      const { data: sessionData } = await browserClient().auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) throw new Error("Votre session a expiré. Veuillez vous reconnecter.");
      const response = await fetch("/api/monitoring", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Le chargement du monitoring a échoué.");
      setData(payload);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Une erreur inattendue est survenue.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(true);
    const timer = window.setInterval(() => void load(false), 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const stats = data?.stats;
  const lastStatus = scanStatus(data?.lastScan?.status ?? null);
  const systemHealthy = !!data?.lastScan && lastStatus === "success" && (data.lastScan.errorCount ?? 0) === 0;

  return (
    <section className="monitoring-section" id="monitoring">
      <div className="section-heading">
        <div>
          <span className="eyebrow">OPERATIONS / DATA OBSERVABILITY</span>
          <h2>Centre de monitoring</h2>
          <p>État du scanner, qualité des données collectées et statistiques des moteurs V1 et V2.</p>
        </div>
      </div>

      {error && <div className="error-banner"><strong>Monitoring indisponible</strong><span>{error}</span><button onClick={() => void load()}>Réessayer</button></div>}

      <div className="monitor-status-card">
        <div className="monitor-status-main">
          <span className={`monitor-pulse ${systemHealthy ? "healthy" : lastStatus === "failed" ? "unhealthy" : "pending"}`} />
          <div>
            <span className="detail-label">ÉTAT DU SCANNER</span>
            <strong>{loading ? "Vérification…" : !data?.lastScan ? "Aucune exécution connue" : lastStatus === "failed" ? "Dernière exécution en échec" : lastStatus === "running" ? "Exécution en cours" : lastStatus === "partial" ? "Dernière exécution avec avertissements" : systemHealthy ? "Dernière exécution sans erreur signalée" : "État à vérifier"}</strong>
            <small>{data?.lastScan ? `${duration(data.lastScanAgeMinutes)} · démarrée le ${date(data.lastScan.started_at)}` : "Les journaux de scan ne contiennent pas encore d’exécution."}</small>
          </div>
        </div>
        <div className="monitor-status-meta">
          <span><b>{number(stats?.scans24h ?? 0)}</b><small>scans sur 24 h</small></span>
          <span><b>{number(data?.lastScan?.markets_scanned ?? 0)}</b><small>marchés au dernier scan</small></span>
          <span><b>{number(data?.lastScan?.trades_new ?? 0)}</b><small>nouvelles transactions</small></span>
        </div>
      </div>

      <div className="monitor-subheading"><div><h3>Inventaire des données</h3><p>Volumes réellement enregistrés dans Supabase, tous historiques confondus.</p></div></div>
      <div className="monitor-stat-grid">
        {[
          ["Marchés", stats?.markets, "Référentiel de marchés"],
          ["Transactions", stats?.trades, "Historique brut collecté"],
          ["Portefeuilles", stats?.wallets, "Adresses enregistrées"],
          ["Alertes V1", stats?.alerts, "Détections historiques"],
          ["Signaux V2", stats?.v2Signals, "Tous régimes, tous scores"],
          ["Snapshots de prix", stats?.snapshots, "Historique des prix et liquidités"],
        ].map(([label, value, hint]) => (
          <article className="monitor-stat-card" key={String(label)}>
            <span>{label}</span><strong>{loading ? "—" : number(Number(value ?? 0))}</strong><small>{hint}</small>
          </article>
        ))}
      </div>

      <div className="monitor-subheading"><div><h3>Qualité et couverture du scoring V2</h3><p>Calculs effectués sur les signaux V2 disposant d’un score calculé.</p></div></div>
      <div className="monitor-quality-grid">
        <article className="monitor-quality-card">
          <span className="detail-label">SIGNAUX AFFICHABLES</span>
          <strong>{loading ? "—" : number(stats?.qualifiedV2 ?? 0)}</strong>
          <small>Score ≥ 50/100 et calcul terminé</small>
        </article>
        <article className="monitor-quality-card">
          <span className="detail-label">SCORE MOYEN</span>
          <strong>{loading ? "—" : `${stats?.averageScore ?? 0}/100`}</strong>
          <small>Sur {number(stats?.computedV2 ?? 0)} signaux calculés (échantillon max. 5 000)</small>
        </article>
        <article className="monitor-quality-card">
          <span className="detail-label">COUVERTURE MOYENNE</span>
          <strong>{loading ? "—" : `${stats?.averageCoverage ?? 0}%`}</strong>
          <small>Part moyenne des pondérations renseignées</small>
        </article>
        <article className="monitor-quality-card">
          <span className="detail-label">DERNIER SNAPSHOT</span>
          <strong className="monitor-date">{loading ? "—" : date(data?.latestSnapshotAt ?? null)}</strong>
          <small>{number(stats?.snapshots ?? 0)} snapshots stockés</small>
        </article>
      </div>

      <div className="monitor-regimes">
        <div className="monitor-subheading"><div><h3>Répartition des régimes</h3><p>Catégories de prix du moteur V2.</p></div></div>
        <div className="regime-bars">
          {[
            ["longshot", "Longshot", stats?.regimes?.longshot ?? 0],
            ["contested", "Contested", stats?.regimes?.contested ?? 0],
            ["favorite", "Favorite", stats?.regimes?.favorite ?? 0],
            ["unknown", "Inconnu", stats?.regimes?.unknown ?? 0],
          ].map(([key, label, value]) => {
            const total = stats?.computedV2 ?? 0;
            const pct = total ? Math.round(Number(value) / total * 100) : 0;
            return <div className="regime-row" key={String(key)}>
              <span>{label}</span><div className="regime-track"><i style={{ width: `${pct}%` }} /></div><b>{number(Number(value))} <small>{pct}%</small></b>
            </div>;
          })}
        </div>
      </div>

      <div className="monitor-subheading"><div><h3>Résultats des signaux V2</h3><p>Les achats détectés sont comparés à l’issue finale des marchés résolus par Polymarket. Les marchés encore ouverts restent en attente.</p></div></div>
      <div className="outcome-stat-grid">
        <article className="outcome-stat-card"><span>Signaux gagnants</span><strong>{loading ? "—" : number(stats?.resolvedWins ?? 0)}</strong><small>Issue achetée gagnante</small></article>
        <article className="outcome-stat-card"><span>Signaux perdants</span><strong>{loading ? "—" : number(stats?.resolvedLosses ?? 0)}</strong><small>Issue achetée perdante</small></article>
        <article className="outcome-stat-card"><span>Taux de réussite</span><strong>{loading ? "—" : stats?.winRate == null ? "—" : `${stats.winRate}%`}</strong><small>Sur {number(stats?.resolvedSignals ?? 0)} signaux résolus</small></article>
        <article className="outcome-stat-card"><span>En attente</span><strong>{loading ? "—" : number(stats?.pendingSignals ?? 0)}</strong><small>Marchés non résolus ou prix non définitifs</small></article>
      </div>
      <div className="outcome-calibration">
        <h4>Résultats par tranche de score</h4>
        <div className="outcome-calibration-grid">
          {(stats?.scoreBands ?? []).map((band) => <div className="outcome-calibration-row" key={band.label}>
            <b>{band.label}</b><span>{number(band.count)} résolus</span><span>{number(band.wins)} gagnants</span><strong>{band.winRate == null ? "—" : `${band.winRate}%`}</strong>
          </div>)}
        </div>
      </div>
      <div className="outcome-history">
        <h4>Derniers signaux évalués</h4>
        {!loading && (data?.latestOutcomes.length ?? 0) === 0 && <div className="empty-state">Aucun signal BUY n’a encore un résultat final vérifiable. Les marchés suivis sont évalués automatiquement après leur résolution.</div>}
        {data?.latestOutcomes.map((item) => <article className="outcome-history-row" key={item.id}>
          <div className="outcome-history-main"><strong>{item.question}</strong><small>{item.outcome} · Score V2 {item.score}/100 · {item.firstTradeAt ? date(item.firstTradeAt) : "Date inconnue"}</small></div>
          <span className={`outcome-result ${item.won ? "won" : "lost"}`}>{item.won ? "Gagnant" : "Perdant"}</span>
        </article>)}
      </div>

      <div className="monitor-subheading"><div><h3>Journal des exécutions</h3><p>Les 12 derniers passages du scanner enregistrés dans la base.</p></div></div>
      <div className="scan-log">
        {loading && <div className="empty-state">Chargement du journal…</div>}
        {!loading && (data?.recentScans.length ?? 0) === 0 && <div className="empty-state">Aucun scan enregistré pour le moment.</div>}
        {data?.recentScans.map((scan) => (
          <article className="scan-row" key={scan.id}>
            <span className={`scan-state ${scanStatus(scan.status)}`} />
            <div className="scan-time"><strong>{date(scan.started_at)}</strong><small>{scan.finished_at ? `Terminé le ${date(scan.finished_at)}` : "Fin d’exécution non renseignée"}</small></div>
            <div className="scan-metric"><b>{number(scan.markets_scanned)}</b><small>marchés</small></div>
            <div className="scan-metric"><b>{number(scan.trades_fetched)}</b><small>transactions lues</small></div>
            <div className="scan-metric"><b>{number(scan.trades_new)}</b><small>nouvelles</small></div>
            <div className="scan-metric"><b>{number(scan.alerts_created)}</b><small>alertes</small></div>
            <span className={`scan-badge ${scanStatus(scan.status)}`}>{scan.status || "inconnu"}{scan.errorCount ? ` · ${scan.errorCount} erreur(s)` : ""}</span>
          </article>
        ))}
      </div>
      <footer className="list-footer"><span>{data?.generatedAt ? `Statistiques actualisées à ${date(data.generatedAt)}` : "En attente de synchronisation"}</span><span>Actualisation automatique chaque minute</span></footer>
      <p className="monitor-footnote">Les statistiques décrivent les données stockées et les exécutions journalisées. Elles ne constituent pas une mesure de performance prédictive du scoring V2.</p>
    </section>
  );
}
