"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { browserClient } from "@/lib/supabase";
import MonitoringPanel from "@/components/MonitoringPanel";

type Factor = { code: string; label: string; weight: number; available: boolean; contribution: number; subscore: number | null };
type Alert = {
  id: string; score: number; coverage: number; total_usd: number; alert_type: string;
  model_version: string | null; created_at: string; first_trade_at: string | null;
  market: { category: string | null; question: string } | null; factors: Factor[];
  missing_data: string[]; conditions: { value: boolean | null }[];
};

const fmt = (n: number) => new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 }).format(n);
const usd = (n: number) => new Intl.NumberFormat("fr-FR", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);

export default function StatisticsDashboard() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  useEffect(() => {
    const saved = window.localStorage.getItem("radar-theme");
    if (saved === "light" || saved === "dark") setTheme(saved);
  }, []);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const { data } = await browserClient().auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("Votre session a expiré. Veuillez vous reconnecter.");
      const response = await fetch("/api/alerts", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Impossible de charger les statistiques.");
      setAlerts(payload.alerts ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Une erreur inattendue est survenue.");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const analytics = useMemo(() => {
    const count = alerts.length;
    const avgScore = count ? alerts.reduce((s, a) => s + Number(a.score || 0), 0) / count : 0;
    const avgCoverage = count ? alerts.reduce((s, a) => s + Number(a.coverage || 0), 0) / count : 0;
    const totalUsd = alerts.reduce((s, a) => s + Number(a.total_usd || 0), 0);
    const categories = new Map<string, number>();
    const buckets = [{ label: "50–59", min: 50, max: 59 }, { label: "60–69", min: 60, max: 69 }, { label: "70–79", min: 70, max: 79 }, { label: "80–89", min: 80, max: 89 }, { label: "90–100", min: 90, max: 100 }].map(b => ({ ...b, count: alerts.filter(a => a.score >= b.min && a.score <= b.max).length }));
    const factors = new Map<string, { label: string; available: number; total: number; contribution: number; weight: number }>();
    alerts.forEach(a => {
      const category = a.market?.category || "Non catégorisé";
      categories.set(category, (categories.get(category) || 0) + 1);
      (a.factors || []).forEach(f => {
        const old = factors.get(f.code) || { label: f.label, available: 0, total: 0, contribution: 0, weight: Number(f.weight || 0) };
        old.total++; if (f.available) old.available++;
        old.contribution += Number(f.contribution || 0);
        factors.set(f.code, old);
      });
    });
    return {
      count, avgScore, avgCoverage, totalUsd,
      priority: alerts.filter(a => a.score >= 90).length,
      grouped: alerts.filter(a => a.alert_type === "grouped").length,
      categories: [...categories.entries()].sort((a,b) => b[1]-a[1]).slice(0,8),
      buckets,
      factors: [...factors.entries()].map(([code,v]) => ({ code, ...v, rate: v.total ? v.available/v.total*100 : 0, avgContribution: v.total ? v.contribution/v.total : 0 })).sort((a,b) => b.weight-a.weight),
      missing: alerts.reduce((s,a) => s + (a.missing_data?.length || 0), 0),
      firstDate: alerts.map(a => a.first_trade_at || a.created_at).filter(Boolean).sort()[0] || null,
      lastDate: alerts.map(a => a.first_trade_at || a.created_at).filter(Boolean).sort().slice(-1)[0] || null,
    };
  }, [alerts]);

  const maxBucket = Math.max(1, ...analytics.buckets.map(b => b.count));
  const maxCategory = Math.max(1, ...analytics.categories.map(([,n]) => n));

  return (
    <main className="radar-shell" data-theme={theme}>
      <aside className="sidebar">
        <a className="brand" href="/"><span className="brand-mark"><svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="15" fill="none" stroke="currentColor" strokeWidth="1.6" opacity=".55"/><circle cx="20" cy="20" r="9" fill="none" stroke="currentColor" strokeWidth="1.6" opacity=".8"/><path d="M20 20 32 8M20 20l-1 10" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"/><circle cx="20" cy="20" r="2.7" fill="currentColor"/></svg></span><span>POLYMARKET<span className="brand-muted">RADAR / INTELLIGENCE</span></span></a>
        <div className="sidebar-label">WORKSPACE</div>
        <a className="nav-item" href="/"><span>⌂</span> Surveillance active</a>
        <a className="nav-item active" href="/statistics"><span>▥</span> Statistiques & méthode</a>
        <div className="sidebar-bottom">
          <div className="system-card"><span className="status-dot" /> <span><strong>Scanner actif</strong><small>Synchronisation automatique</small></span></div>
          <button className="logout-button" onClick={() => browserClient().auth.signOut()}>↗ Déconnexion</button>
        </div>
      </aside>
      <section className="main-panel">
        <header className="topbar">
          <div><span className="eyebrow">MARKET INTELLIGENCE / DATA & MODEL</span><h1>Statistiques & fonctionnement</h1><p>Analyse approfondie de l’historique, de la qualité des données et des règles de détection BUY.</p></div>
          <div className="topbar-actions">
            <button className="theme-toggle" onClick={() => setTheme(t => { const n = t === "dark" ? "light" : "dark"; window.localStorage.setItem("radar-theme", n); return n; })}>{theme === "dark" ? "☼ Mode clair" : "◐ Mode sombre"}</button>
            <button className="refresh-button" onClick={() => void load()} disabled={loading}>{loading ? "Chargement…" : "↻ Actualiser"}</button>
          </div>
        </header>

        {error && <div className="error-banner"><strong>Statistiques indisponibles</strong><span>{error}</span><button onClick={() => void load()}>Réessayer</button></div>}

        <section className="stats-intro-grid">
          <article className="stats-intro-card"><span className="eyebrow">PÉRIMÈTRE ANALYSÉ</span><strong>{loading ? "—" : fmt(analytics.count)}</strong><p>Alertes BUY qualifiées chargées depuis l’historique récent.</p></article>
          <article className="stats-intro-card"><span className="eyebrow">PÉRIODE COUVERTE</span><strong className="stats-date">{loading || !analytics.firstDate ? "—" : new Date(analytics.firstDate).toLocaleDateString("fr-FR") + " → " + new Date(analytics.lastDate!).toLocaleDateString("fr-FR")}</strong><p>Dates des premières transactions présentes dans cet échantillon.</p></article>
          <article className="stats-intro-card"><span className="eyebrow">VOLUME ASSOCIÉ</span><strong>{loading ? "—" : usd(analytics.totalUsd)}</strong><p>Somme des montants agrégés des alertes affichées.</p></article>
        </section>

        <section className="stats-panel">
          <div className="section-heading"><div><span className="eyebrow">SIGNAL OVERVIEW</span><h2>Vue statistique des alertes</h2><p>Indicateurs calculés sur les alertes BUY qualifiées renvoyées par le tableau de bord.</p></div></div>
          <div className="stats-kpi-grid">
            <article><span>Score moyen</span><strong>{loading ? "—" : fmt(analytics.avgScore) + "/100"}</strong></article>
            <article><span>Couverture moyenne</span><strong>{loading ? "—" : fmt(analytics.avgCoverage) + "%"}</strong></article>
            <article><span>Score ≥ 90</span><strong>{loading ? "—" : fmt(analytics.priority)}</strong></article>
            <article><span>Achats groupés</span><strong>{loading ? "—" : fmt(analytics.grouped)}</strong></article>
          </div>
          <div className="stats-two-col">
            <div className="stats-chart-card"><h3>Distribution des scores</h3><p>Nombre d’alertes par tranche de score.</p><div className="stats-bars">{analytics.buckets.map(b => <div className="stats-bar-row" key={b.label}><span>{b.label}</span><div className="stats-bar-track"><i style={{ width: `${b.count / maxBucket * 100}%` }} /></div><b>{fmt(b.count)}</b></div>)}</div></div>
            <div className="stats-chart-card"><h3>Répartition par catégorie</h3><p>Catégorie du marché associé à chaque alerte.</p>{analytics.categories.length ? <div className="stats-bars">{analytics.categories.map(([label,n]) => <div className="stats-bar-row" key={label}><span title={label}>{label}</span><div className="stats-bar-track"><i style={{ width: `${n / maxCategory * 100}%` }} /></div><b>{fmt(n)}</b></div>)}</div> : <div className="stats-empty">Aucune catégorie disponible.</div>}</div>
          </div>
        </section>

        <section className="stats-panel">
          <div className="section-heading"><div><span className="eyebrow">MODEL DIAGNOSTICS</span><h2>Analyse des facteurs de scoring</h2><p>Disponibilité des données et contribution moyenne observée par facteur.</p></div></div>
          <div className="stats-factor-list">
            {analytics.factors.map(f => <div className="stats-factor-row" key={f.code}><div><strong>{f.label}</strong><small>{f.weight}% du poids théorique · {f.available}/{f.total} alertes avec donnée</small></div><div className="stats-factor-track"><i style={{ width: `${f.rate}%` }} /></div><b>{fmt(f.rate)}%</b><span>+{fmt(f.avgContribution)} pts en moyenne</span></div>)}
            {!loading && analytics.factors.length === 0 && <div className="stats-empty">Aucun détail de facteur disponible dans les alertes chargées.</div>}
          </div>
          <div className="stats-note">Données manquantes recensées : <strong>{loading ? "—" : fmt(analytics.missing)}</strong> occurrences. Un facteur indisponible contribue zéro point ; son poids n’est pas redistribué aux autres facteurs.</div>
        </section>

        <section className="stats-panel methodology-panel">
          <div className="section-heading"><div><span className="eyebrow">HOW IT WORKS</span><h2>Comment fonctionne le radar ?</h2><p>Le système détecte des comportements d’achat atypiques sur les marchés prédictifs. Il produit un indicateur d’analyse, pas une conclusion sur l’intention d’un portefeuille.</p></div></div>
          <div className="method-steps">
            <article><span>01</span><div><h3>Collecte</h3><p>Le scanner parcourt les marchés et récupère les transactions ainsi que les informations disponibles sur les portefeuilles.</p></div></article>
            <article><span>02</span><div><h3>Regroupement</h3><p>Les achats liés à un même portefeuille et à un même marché peuvent être regroupés dans une alerte afin de restituer le contexte d’activité.</p></div></article>
            <article><span>03</span><div><h3>Scoring unique sur 100</h3><p>Le moteur informed-buy-v1 combine plusieurs facteurs pondérés. Chaque facteur est évalué selon les données disponibles ; les pondérations indisponibles restent à zéro et ne sont pas redistribuées.</p></div></article>
            <article><span>04</span><div><h3>Qualification et traçabilité</h3><p>Les alertes ayant un score d’au moins 50/100 sont conservées dans la surveillance. Le détail expose les facteurs, leur contribution, les données manquantes et les transactions associées.</p></div></article>
            <article><span>05</span><div><h3>Vérifications complémentaires</h3><p>Les critères de vérification apportent du contexte, mais ne bloquent pas la création d’une alerte. Ils ne doivent pas être interprétés comme des preuves.</p></div></article>
          </div>
          <div className="method-caveat"><strong>Limites d’interprétation</strong><p>Un score élevé indique une activité qui correspond davantage aux signaux recherchés par le modèle. Il ne prouve ni fraude, ni information privilégiée, ni exactitude future du marché. Les résultats dépendent de la fraîcheur, de la couverture et de la qualité des données collectées.</p></div>
        </section>

        <MonitoringPanel />
        <footer className="page-footer">POLYMARKET RADAR <span>•</span> Statistiques descriptives — les alertes ne constituent pas des preuves de fraude.</footer>
      </section>
    </main>
  );
}
