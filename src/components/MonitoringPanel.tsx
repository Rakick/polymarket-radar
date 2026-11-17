"use client";

import { useCallback, useEffect, useState } from "react";
import { browserClient } from "@/lib/supabase";

type Scan = {
  id: string; started_at: string; finished_at: string | null; status: string | null;
  markets_scanned: number; trades_fetched: number; trades_new: number; alerts_created: number;
  errors: unknown[]; errorCount: number;
};
type MonitoringData = {
  generatedAt: string;
  stats: {
    markets: number; trades: number; wallets: number; alerts: number; pendingAlerts: number;
    scoredAlerts: number; averageScore: number; averageCoverage: number;
    priorityAlerts: number; scans24h: number;
  };
  lastScan: Scan | null;
  lastScanAgeMinutes: number | null;
  recentScans: Scan[];
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
  if (value === "partial") return "partial";
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
      <div className="section-heading"><div><span className="eyebrow">OPERATIONS / DATA OBSERVABILITY</span><h2>Centre de monitoring</h2><p>État du scanner, volumes en base et progression du moteur de scoring BUY unique.</p></div></div>
      {error && <div className="error-banner"><strong>Monitoring indisponible</strong><span>{error}</span><button onClick={() => void load()}>Réessayer</button></div>}
      <div className="monitor-status-card">
        <div className="monitor-status-main">
          <span className={`monitor-pulse ${systemHealthy ? "healthy" : lastStatus === "failed" ? "unhealthy" : "pending"}`} />
          <div><span className="detail-label">ÉTAT DU SCANNER</span><strong>{loading ? "Vérification…" : !data?.lastScan ? "Aucune exécution connue" : lastStatus === "failed" ? "Dernière exécution en échec" : lastStatus === "running" ? "Exécution en cours" : lastStatus === "partial" ? "Dernière exécution avec avertissements" : systemHealthy ? "Dernière exécution sans erreur signalée" : "État à vérifier"}</strong><small>{data?.lastScan ? `${duration(data.lastScanAgeMinutes)} · démarrée le ${date(data.lastScan.started_at)}` : "Les journaux ne contiennent pas encore d’exécution."}</small></div>
        </div>
        <div className="monitor-status-meta"><span><b>{number(stats?.scans24h ?? 0)}</b><small>scans sur 24 h</small></span><span><b>{number(data?.lastScan?.markets_scanned ?? 0)}</b><small>marchés au dernier scan</small></span><span><b>{number(data?.lastScan?.trades_new ?? 0)}</b><small>nouvelles transactions</small></span></div>
      </div>

      <div className="monitor-subheading"><div><h3>Inventaire des données utiles</h3><p>Référentiels, transactions sources et alertes conservées dans Supabase.</p></div></div>
      <div className="monitor-stat-grid">
        {[
          ["Marchés", stats?.markets, "Référentiel actif et historique"],
          ["Transactions", stats?.trades, "Détails encore disponibles"],
          ["Portefeuilles", stats?.wallets, "Adresses avec métadonnées"],
          ["Alertes qualifiées", stats?.alerts, "Score unique ≥ 50/100"],
          ["Scores calculés", stats?.scoredAlerts, "Version du nouveau modèle"],
          ["À enrichir", stats?.pendingAlerts, "Historique en cours de recalcul"],
        ].map(([label, value, hint]) => <article className="monitor-stat-card" key={String(label)}><span>{label}</span><strong>{loading ? "—" : number(Number(value ?? 0))}</strong><small>{hint}</small></article>)}
      </div>

      <div className="monitor-subheading"><div><h3>Qualité du scoring unique</h3><p>Les poids des facteurs indisponibles restent à zéro ; ils ne sont pas redistribués.</p></div></div>
      <div className="monitor-quality-grid">
        <article className="monitor-quality-card"><span className="detail-label">SCORE MOYEN</span><strong>{loading ? "—" : `${stats?.averageScore ?? 0}/100`}</strong><small>Sur les alertes scorées conservées</small></article>
        <article className="monitor-quality-card"><span className="detail-label">COUVERTURE MOYENNE</span><strong>{loading ? "—" : `${stats?.averageCoverage ?? 0}%`}</strong><small>Part des pondérations vérifiées</small></article>
        <article className="monitor-quality-card"><span className="detail-label">PRIORITÉ RENFORCÉE</span><strong>{loading ? "—" : number(stats?.priorityAlerts ?? 0)}</strong><small>Score ≥ 90/100</small></article>
      </div>

      <div className="monitor-subheading"><div><h3>Journal des exécutions</h3><p>Les 12 derniers passages du scanner enregistrés dans la base.</p></div></div>
      <div className="scan-log">
        {loading && <div className="empty-state">Chargement du journal…</div>}
        {!loading && (data?.recentScans.length ?? 0) === 0 && <div className="empty-state">Aucun scan enregistré pour le moment.</div>}
        {data?.recentScans.map(scan => <article className="scan-row" key={scan.id}>
          <span className={`scan-state ${scanStatus(scan.status)}`} />
          <div className="scan-time"><strong>{date(scan.started_at)}</strong><small>{scan.finished_at ? `Terminé le ${date(scan.finished_at)}` : "Fin d’exécution non renseignée"}</small></div>
          <div className="scan-metric"><b>{number(scan.markets_scanned)}</b><small>marchés</small></div>
          <div className="scan-metric"><b>{number(scan.trades_fetched)}</b><small>transactions lues</small></div>
          <div className="scan-metric"><b>{number(scan.trades_new)}</b><small>nouvelles</small></div>
          <div className="scan-metric"><b>{number(scan.alerts_created)}</b><small>alertes</small></div>
          <span className={`scan-badge ${scanStatus(scan.status)}`}>{scan.status || "inconnu"}{scan.errorCount ? ` · ${scan.errorCount} erreur(s)` : ""}</span>
        </article>)}
      </div>
      <footer className="list-footer"><span>{data?.generatedAt ? `Statistiques actualisées à ${date(data.generatedAt)}` : "En attente de synchronisation"}</span><span>Actualisation automatique chaque minute</span></footer>
      <p className="monitor-footnote">Ces statistiques décrivent les données et exécutions observées. Un score élevé signale une activité atypique, pas une preuve de fraude ni une garantie prédictive.</p>
    </section>
  );
}
