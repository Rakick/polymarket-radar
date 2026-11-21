"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { browserClient } from "@/lib/supabase";

type Factor = {
  code: string; label: string; weight: number; subscore: number | null;
  contribution: number; available: boolean; detail: string;
};
type VerifiedCondition = { code: string; label: string; value: boolean | null; detail: string };
type Trade = {
  trade_id: string; transaction_hash: string; wallet: string; pseudonym: string | null;
  side: string; outcome: string | null; price: number; size: number; usd_amount: number; traded_at: string;
};
type Market = { question: string; url: string; category: string | null; liquidity: number | null; volume: number | null; end_date: string | null };
type Alert = {
  id: string; wallet: string; market_id: string; condition_id: string; alert_type: string;
  score: number; coverage: number; model_version: string | null; factors: Factor[];
  missing_data: string[]; conditions: VerifiedCondition[]; trade_ids: string[];
  total_usd: number; price_min: number | null; price_avg: number | null; outcome: string | null;
  first_trade_at: string | null; last_trade_at: string | null; created_at: string;
  market: Market | null; trades: Trade[];
};

const money = (value: number | string | null | undefined) =>
  value == null ? "—" : new Intl.NumberFormat("fr-FR", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Number(value));
const date = (value: string | null | undefined) =>
  value ? new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "Non renseigné";
const shortWallet = (value: string) => value ? value.slice(0, 8) + "…" + value.slice(-6) : "Inconnu";

export default function Dashboard() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState("");
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState("score_desc");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  useEffect(() => {
    const saved = window.localStorage.getItem("radar-theme");
    if (saved === "light" || saved === "dark") setTheme(saved);
  }, []);

  const changeTheme = () => setTheme(current => {
    const next = current === "dark" ? "light" : "dark";
    window.localStorage.setItem("radar-theme", next);
    return next;
  });

  const loadAlerts = useCallback(async (quiet = false) => {
    if (quiet) setRefreshing(true); else setLoading(true);
    setError("");
    try {
      const { data } = await browserClient().auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("Votre session a expiré. Veuillez vous reconnecter.");
      const response = await fetch("/api/alerts", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Le chargement des alertes a échoué.");
      setAlerts(payload.alerts ?? []);
      setUpdatedAt(payload.generatedAt ?? new Date().toISOString());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Une erreur inattendue est survenue.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadAlerts();
    const timer = window.setInterval(() => void loadAlerts(true), 60_000);
    return () => window.clearInterval(timer);
  }, [loadAlerts]);

  const visibleAlerts = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = alerts.filter(alert => !needle || [
      alert.wallet, alert.market?.question, alert.condition_id, alert.outcome,
      ...(alert.factors ?? []).map(factor => factor.label),
    ].some(value => String(value ?? "").toLowerCase().includes(needle)));
    return filtered.sort((a, b) => sortBy === "amount_desc"
      ? Number(b.total_usd || 0) - Number(a.total_usd || 0)
      : sortBy === "amount_asc"
        ? Number(a.total_usd || 0) - Number(b.total_usd || 0)
        : sortBy === "score_asc"
          ? Number(a.score || 0) - Number(b.score || 0)
          : Number(b.score || 0) - Number(a.score || 0));
  }, [alerts, query, sortBy]);

  const visibleGroups = useMemo(() => {
    const groups = new Map<string, Alert[]>();
    for (const alert of visibleAlerts) {
      const outcome = String(alert.outcome ?? alert.trades?.find(trade => trade.outcome)?.outcome ?? "unknown").trim().toLowerCase();
      const key = `${alert.condition_id || alert.market_id}::${outcome}`;
      groups.set(key, [...(groups.get(key) ?? []), alert]);
    }
    return [...groups.entries()].map(([key, items]) => {
      const ranked = [...items].sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
      return {
        key,
        alerts: ranked,
        top: ranked[0],
        totalUsd: ranked.reduce((sum, item) => sum + Number(item.total_usd || 0), 0),
        wallets: new Set(ranked.map(item => item.wallet)).size,
      };
    }).sort((a, b) => Number(b.top.score || 0) - Number(a.top.score || 0));
  }, [visibleAlerts]);

  const uniqueWallets = new Set(alerts.map(alert => alert.wallet)).size;
  const averageScore = alerts.length ? Math.round(alerts.reduce((sum, alert) => sum + alert.score, 0) / alerts.length) : 0;
  const priorityAlerts = alerts.filter(alert => alert.score >= 90).length;
  const moneyAmount = (value: number) => money(value);
  const scoreClass = (score: number) => score >= 90 ? "score score-v2 high" : score >= 70 ? "score score-v2 medium" : "score score-v2 low";

  return (
    <main className="radar-shell" data-theme={theme}>
      <aside className="sidebar">
        <a className="brand" href="/"><span className="brand-mark"><svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="15" fill="none" stroke="currentColor" strokeWidth="1.6" opacity=".55"/><circle cx="20" cy="20" r="9" fill="none" stroke="currentColor" strokeWidth="1.6" opacity=".8"/><path d="M20 20 32 8M20 20l-1 10" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"/><circle cx="20" cy="20" r="2.7" fill="currentColor"/></svg></span><span>POLYMARKET<span className="brand-muted">RADAR / INTELLIGENCE</span></span></a>
        <div className="sidebar-label">WORKSPACE</div>
        <a className="nav-item active" href="/"><span>⌂</span> Surveillance active <b>{alerts.length}</b></a>
        <a className="nav-item" href="/statistics"><span>▥</span> Statistiques & méthode</a>
        <a className="nav-item" href="/settings"><span>⚙</span> Notifications</a>
        <div className="sidebar-bottom">
          <div className="system-card"><span className="status-dot" /> <span><strong>Scanner actif</strong><small>Synchronisation automatique</small></span></div>
          <button className="logout-button" onClick={() => browserClient().auth.signOut()}>↗ Déconnexion</button>
        </div>
      </aside>

      <section className="main-panel" id="overview">
        <header className="topbar">
          <div><span className="eyebrow">MARKET INTELLIGENCE / BUY SIGNALS</span><h1>Vue d’ensemble</h1><p>Un moteur unique de détection BUY, noté sur 100 avec traçabilité des données.</p></div>
          <div className="topbar-actions"><button className="theme-toggle" onClick={changeTheme} aria-label="Basculer le thème"><span>{theme === "dark" ? "☼" : "◐"}</span>{theme === "dark" ? "Mode clair" : "Mode sombre"}</button><button className="refresh-button" onClick={() => void loadAlerts(true)} disabled={refreshing}>{refreshing ? "Actualisation…" : "↻ Actualiser"}</button></div>
        </header>

        <section className="metric-grid">
          <article className="metric-card metric-primary"><span className="metric-label">Alertes qualifiées</span><strong>{loading ? "—" : visibleGroups.length}</strong><small>Paris affichés · montant minimum : 1 000 $</small><span className="metric-icon">◈</span></article>
          <article className="metric-card"><span className="metric-label">Score moyen</span><strong>{loading ? "—" : `${averageScore}/100`}</strong><small>Sur les alertes affichées</small><span className="metric-icon">↗</span></article>
          <article className="metric-card"><span className="metric-label">Portefeuilles suivis</span><strong>{loading ? "—" : uniqueWallets}</strong><small>Adresses distinctes</small><span className="metric-icon">◎</span></article>
          <article className="metric-card"><span className="metric-label">Priorité renforcée</span><strong>{loading ? "—" : priorityAlerts}</strong><small>Score ≥ 90 / 100</small><span className="metric-icon">✳</span></article>
        </section>

        <section className="alerts-section v2-main-section" id="alerts">
          <div className="section-heading"><div><span className="eyebrow">UNIFIED ENGINE / INFORMED BUY SCORING</span><h2>Alertes BUY</h2><p>Un pari est affiché si son montant associé atteint 1 000 $. Les alertes du même marché et du même résultat sont regroupées, puis classées par meilleur score.</p></div><span className="result-count">{visibleGroups.length} pari{visibleGroups.length > 1 ? "s" : ""}</span></div>

          <div className="toolbar">
            <label className="search-box"><span>⌕</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Rechercher un marché, un portefeuille…" /></label>
            <div className="toolbar-controls">
              <div className="sort-control"><span>Classement</span><strong>Meilleur score en premier</strong></div>
            </div>
          </div>

          {error && <div className="error-banner"><strong>Chargement impossible</strong><span>{error}</span><button onClick={() => void loadAlerts()}>Réessayer</button></div>}
          {loading && <div className="empty-state"><div className="loader" /><strong>Chargement des alertes</strong><span>Connexion sécurisée à votre espace Supabase…</span></div>}
          {!loading && !error && visibleAlerts.length === 0 && <div className="empty-state"><span className="empty-icon">⌕</span><strong>{visibleGroups.length ? "Aucun résultat pour cette recherche" : "Aucun pari qualifié pour le moment"}</strong><span>{alerts.length ? "Modifiez votre recherche." : "Les alertes apparaîtront lorsqu’un BUY obtient un score calculable d’au moins 50/100."}</span></div>}

          <div className="alert-list">
            {visibleGroups.map(group => {
              const alert = group.top;
              const isOpen = expanded === group.key;
              return <article className={isOpen ? "alert-card bet-group expanded" : "alert-card bet-group"} key={group.key}>
                <button className="alert-summary" onClick={() => setExpanded(isOpen ? null : group.key)} aria-expanded={isOpen}>
                  <div className="score-column"><span className="score-caption">MEILLEUR SCORE</span><strong className={scoreClass(alert.score)}>{alert.score}</strong><span className="score-outof">/100</span></div>
                  <div className="alert-main">
                    <div className="alert-title-row"><h3>{alert.market?.question || "Marché non retrouvé"}</h3><span className="side-buy">Achat · {alert.outcome || alert.trades?.find(trade => trade.outcome)?.outcome || "Résultat inconnu"}</span></div>
                    <div className="alert-meta"><span>◉ {group.alerts.length} alerte{group.alerts.length > 1 ? "s" : ""} pour ce pari</span><span>{group.wallets} portefeuille{group.wallets > 1 ? "s" : ""}</span><span>{date(alert.first_trade_at)}</span></div>
                    <div className="alert-tags">{group.alerts.slice(1, 4).map(item => <span key={item.id}>Score <b>{item.score}/100</b></span>)}</div>
                  </div>
                  <div className="amount-column"><span>Montant cumulé</span><strong>{moneyAmount(group.totalUsd)}</strong><small>{group.alerts.length} signal(aux)</small></div>
                  <span className="expand-icon">{isOpen ? "−" : "+"}</span>
                </button>
                {isOpen && <div className="bet-group-details">
                  <div className="bet-group-heading"><strong>{group.alerts.length} alertes liées à ce pari</strong><span>Classées du meilleur au moins bon score</span></div>
                  {group.alerts.map(item => <section className="bet-alert-item" key={item.id}>
                    <div className="bet-alert-head">
                      <div className="bet-alert-score"><strong className={scoreClass(item.score)}>{item.score}</strong><span>/100</span></div>
                      <div className="bet-alert-wallet"><strong>{shortWallet(item.wallet)}</strong><small>{date(item.first_trade_at)} · {item.coverage}% de couverture</small></div>
                      <div className="bet-alert-amount"><strong>{money(item.total_usd)}</strong><small>{item.trades?.length ?? item.trade_ids?.length ?? 0} transaction(s)</small></div>
                    </div>
                    <div className="bet-alert-details">
                      <div className="bet-alert-links"><a className="text-action" href={`https://polymarket.com/profile/${encodeURIComponent(item.wallet)}`} target="_blank" rel="noreferrer">Profil Polymarket ↗</a>{item.market?.url && <a className="text-action" href={item.market.url} target="_blank" rel="noreferrer">Ouvrir le pari ↗</a>}</div>
                      <div className="bet-alert-factors">{(item.factors ?? []).filter(factor => factor.available).map(factor => <span key={factor.code}>{factor.label} <b>{Number(factor.subscore ?? 0).toFixed(0)}/100</b></span>)}</div>
                      {(item.missing_data ?? []).length > 0 && <p className="v2-missing">Données à compléter : {item.missing_data.join(" · ")}</p>}
                      {item.trades?.length ? <div className="trade-table-wrap"><table className="trade-table"><thead><tr><th>DATE</th><th>ISSUE</th><th>PRIX</th><th>MONTANT</th><th>TRANSACTION</th></tr></thead><tbody>{item.trades.map(trade => <tr key={trade.trade_id}><td>{date(trade.traded_at)}</td><td>{trade.outcome || item.outcome || "—"}</td><td>{(Number(trade.price) * 100).toFixed(2)} %</td><td>{money(trade.usd_amount)}</td><td><code>{trade.transaction_hash ? trade.transaction_hash.slice(0, 10) + "…" : trade.trade_id.slice(0, 10) + "…"}</code></td></tr>)}</tbody></table></div> : <p className="no-trades">Détails des transactions non disponibles dans l’historique brut.</p>}
                    </div>
                  </section>)}
                </div>}
              </article>;
            })}
          </div>
          <footer className="list-footer"><span>{updatedAt ? `Données actualisées à ${date(updatedAt)}` : "En attente de synchronisation"}</span><span>Actualisation automatique chaque minute</span></footer>
        </section>
        <footer className="page-footer">POLYMARKET RADAR <span>•</span> Outil d’aide à l’analyse — les alertes ne constituent pas des preuves de fraude.</footer>
      </section>
    </main>
  );
}
