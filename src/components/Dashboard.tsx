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
          <article className="metric-card metric-primary"><span className="metric-label">Alertes qualifiées</span><strong>{loading ? "—" : alerts.length}</strong><small>Score minimum : 50 / 100</small><span className="metric-icon">◈</span></article>
          <article className="metric-card"><span className="metric-label">Score moyen</span><strong>{loading ? "—" : `${averageScore}/100`}</strong><small>Sur les alertes affichées</small><span className="metric-icon">↗</span></article>
          <article className="metric-card"><span className="metric-label">Portefeuilles suivis</span><strong>{loading ? "—" : uniqueWallets}</strong><small>Adresses distinctes</small><span className="metric-icon">◎</span></article>
          <article className="metric-card"><span className="metric-label">Priorité renforcée</span><strong>{loading ? "—" : priorityAlerts}</strong><small>Score ≥ 90 / 100</small><span className="metric-icon">✳</span></article>
        </section>

        <section className="alerts-section v2-main-section" id="alerts">
          <div className="section-heading"><div><span className="eyebrow">UNIFIED ENGINE / INFORMED BUY SCORING</span><h2>Alertes BUY</h2><p>Une alerte est conservée à partir de 50/100. Les critères de vérification sont informatifs et ne bloquent pas sa création.</p></div><span className="result-count">{alerts.length} alerte{alerts.length > 1 ? "s" : ""}</span></div>

          <div className="toolbar">
            <label className="search-box"><span>⌕</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Rechercher un marché, un portefeuille…" /></label>
            <div className="toolbar-controls">
              <label className="sort-control"><span>Trier par</span><select value={sortBy} onChange={event => setSortBy(event.target.value)}><option value="score_desc">Score : décroissant</option><option value="score_asc">Score : croissant</option><option value="amount_desc">Montant : décroissant</option><option value="amount_asc">Montant : croissant</option></select></label>
            </div>
          </div>

          {error && <div className="error-banner"><strong>Chargement impossible</strong><span>{error}</span><button onClick={() => void loadAlerts()}>Réessayer</button></div>}
          {loading && <div className="empty-state"><div className="loader" /><strong>Chargement des alertes</strong><span>Connexion sécurisée à votre espace Supabase…</span></div>}
          {!loading && !error && visibleAlerts.length === 0 && <div className="empty-state"><span className="empty-icon">⌕</span><strong>{alerts.length ? "Aucun résultat pour cette recherche" : "Aucune alerte qualifiée pour le moment"}</strong><span>{alerts.length ? "Modifiez votre recherche." : "Les alertes apparaîtront lorsqu’un BUY obtient un score calculable d’au moins 50/100."}</span></div>}

          <div className="alert-list">
            {visibleAlerts.map(alert => {
              const isOpen = expanded === alert.id;
              return <article className={isOpen ? "alert-card expanded" : "alert-card"} key={alert.id}>
                <button className="alert-summary" onClick={() => setExpanded(isOpen ? null : alert.id)} aria-expanded={isOpen}>
                  <div className="score-column"><span className="score-caption">SCORE UNIQUE</span><strong className={scoreClass(alert.score)}>{alert.score}</strong><span className="score-outof">/100</span></div>
                  <div className="alert-main">
                    <div className="alert-title-row"><h3>{alert.market?.question || "Marché non retrouvé"}</h3><span className="side-buy">Achat · {alert.outcome || "Résultat inconnu"}</span></div>
                    <div className="alert-meta"><span>{alert.alert_type === "grouped" ? "◉ Achats groupés" : "◉ Achat isolé"}</span><span>Portefeuille <code>{shortWallet(alert.wallet)}</code></span><span>{date(alert.first_trade_at)}</span><span>Couverture {alert.coverage}%</span></div>
                    <div className="alert-tags">{(alert.factors ?? []).filter(factor => factor.available).slice(0, 3).map(factor => <span key={factor.code}>{factor.label} <b>{Number(factor.subscore ?? 0).toFixed(0)}/100</b></span>)}</div>
                  </div>
                  <div className="amount-column"><span>Montant associé</span><strong>{moneyAmount(alert.total_usd)}</strong><small>{alert.trades?.length ?? alert.trade_ids?.length ?? 0} transaction(s)</small></div>
                  <span className="expand-icon">{isOpen ? "−" : "+"}</span>
                </button>

                {isOpen && <div className="alert-details">
                  <div className="detail-grid">
                    <div className="detail-block"><span className="detail-label">PORTEFEUILLE</span><strong className="mono">{shortWallet(alert.wallet)}</strong><div className="wallet-actions"><button className="text-action" onClick={() => navigator.clipboard?.writeText(alert.wallet)}>Copier l’adresse</button><a className="text-action" href={`https://polymarket.com/profile/${encodeURIComponent(alert.wallet)}`} target="_blank" rel="noreferrer">Voir le profil Polymarket ↗</a></div></div>
                    <div className="detail-block"><span className="detail-label">PRIX MOYEN PONDÉRÉ</span><strong>{alert.price_avg == null ? "—" : `${(Number(alert.price_avg) * 100).toFixed(2)} %`}</strong></div>
                    <div className="detail-block"><span className="detail-label">PRIX MINIMUM</span><strong>{alert.price_min == null ? "—" : `${(Number(alert.price_min) * 100).toFixed(2)} %`}</strong></div>
                    <div className="detail-block"><span className="detail-label">PREMIÈRE TRANSACTION</span><strong>{date(alert.first_trade_at)}</strong></div>
                    <div className="detail-block"><span className="detail-label">DERNIÈRE TRANSACTION</span><strong>{date(alert.last_trade_at)}</strong></div>
                    <div className="detail-block"><span className="detail-label">CATÉGORIE</span><strong>{alert.market?.category || "—"}</strong></div>
                  </div>

                  <div className="detail-section v2-panel">
                    <div className="subheading-row"><h4>Décomposition du score · {alert.score}/100</h4><span>{alert.coverage}% des pondérations calculées · {alert.model_version || "recalcul en attente"}</span></div>
                    <p className="v2-disclaimer">Les facteurs indisponibles contribuent zéro point. Leurs poids ne sont pas redistribués entre les autres facteurs.</p>
                    <div className="factor-list">{(alert.factors ?? []).map(factor => <div className="factor-row" key={factor.code}><span className={factor.available ? "factor-dot factor-dot-v2" : "factor-dot"} /><div><strong>{factor.label}</strong><small>{factor.detail}</small></div><b>{factor.available ? `${Number(factor.subscore ?? 0).toFixed(1)}/100 · ${factor.weight}% · +${Number(factor.contribution ?? 0).toFixed(1)} pts` : `Indisponible · ${factor.weight}%`}</b></div>)}</div>
                    {(alert.missing_data ?? []).length > 0 && <p className="v2-missing">Données à compléter : {alert.missing_data.join(" · ")}</p>}
                  </div>

                  <div className="detail-section">
                    <div className="subheading-row"><h4>Six critères de vérification</h4><span>Information — aucun critère ne bloque l’alerte</span></div>
                    <div className="factor-list">{(alert.conditions ?? []).map(condition => <div className="factor-row" key={condition.code}><span className="factor-dot factor-dot-v2" /><div><strong>{condition.label}</strong><small>{condition.detail}</small></div><b className={condition.value === true ? "condition-yes" : condition.value === false ? "condition-no" : "condition-unknown"}>{condition.value === true ? "Oui" : condition.value === false ? "Non" : "Inconnu"}</b></div>)}</div>
                  </div>

                  <div className="detail-section"><div className="subheading-row"><h4>Transactions associées</h4><span>{alert.trades?.length ?? 0} chargée(s) / {alert.trade_ids?.length ?? 0} référencée(s)</span></div>
                    {alert.trades?.length ? <div className="trade-table-wrap"><table className="trade-table"><thead><tr><th>DATE</th><th>SENS</th><th>ISSUE</th><th>PRIX</th><th>QUANTITÉ</th><th>MONTANT</th><th>TRANSACTION</th></tr></thead><tbody>{alert.trades.map(trade => <tr key={trade.trade_id}><td>{date(trade.traded_at)}</td><td><span className="side-buy">Achat</span></td><td>{trade.outcome || alert.outcome || "—"}</td><td>{(Number(trade.price) * 100).toFixed(2)} %</td><td>{Number(trade.size).toLocaleString("fr-FR", { maximumFractionDigits: 2 })}</td><td>{money(trade.usd_amount)}</td><td><code>{trade.transaction_hash ? trade.transaction_hash.slice(0, 10) + "…" : trade.trade_id.slice(0, 10) + "…"}</code></td></tr>)}</tbody></table></div> : <p className="no-trades">Les identifiants sont conservés, mais les détails de ces transactions ne sont plus disponibles dans l’historique brut.</p>}
                  </div>
                  <div className="detail-footer"><span>ID marché : <code>{alert.market_id}</code></span><span>Condition : <code>{shortWallet(alert.condition_id)}</code></span>{alert.market?.url && <a href={alert.market.url} target="_blank" rel="noreferrer">Ouvrir le marché sur Polymarket ↗</a>}</div>
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
