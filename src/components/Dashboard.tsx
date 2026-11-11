"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { browserClient } from "@/lib/supabase";

type Factor = { code?: string; label_fr?: string; label_en?: string; points?: number; detail?: string };
type Trade = { trade_id: string; transaction_hash: string; wallet: string; pseudonym: string | null; side: string; outcome: string | null; price: number; size: number; usd_amount: number; traded_at: string };
type Market = { question: string; url: string; category: string | null; liquidity: number | null; volume: number | null; end_date: string | null };
type Alert = {
  id: string; wallet: string; market_id: string; condition_id: string; alert_type: string;
  score: number; confidence: string; factors: Factor[]; missing_data: string[]; trade_ids: string[];
  total_usd: number; price_min: number | null; outcome: string | null;
  first_trade_at: string | null; last_trade_at: string | null; created_at: string;
  market: Market | null; trades: Trade[];
};

const money = (value: number | string | null | undefined) =>
  value == null ? "—" : new Intl.NumberFormat("fr-FR", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Number(value));
const date = (value: string | null | undefined) =>
  value ? new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "Non renseigné";
const shortWallet = (value: string) => value ? value.slice(0, 8) + "…" + value.slice(-6) : "Inconnu";
const confidenceLabel = (value: string) => value === "high" ? "Élevée" : value === "medium" ? "Moyenne" : "Faible";
const missingLabel: Record<string, string> = {
  wallet_age: "Date de création du compte Polymarket", wallet_baseline: "Historique de transactions du portefeuille",
  wallet_baseline_partial: "Historique partiel du portefeuille",
};

export default function Dashboard() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [sortBy, setSortBy] = useState("amount_desc");
  const [expanded, setExpanded] = useState<string | null>(null);

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
    const filtered = alerts.filter((a) => {
      const matchesQuery = !needle || [
        a.wallet, a.market?.question, a.condition_id, ...(a.factors ?? []).map((f) => f.label_fr),
      ].some((v) => String(v ?? "").toLowerCase().includes(needle));
      const matchesFilter = filter === "all"
        || (filter === "high" && a.confidence === "high")
        || (filter === "medium" && a.confidence === "medium")
        || (filter === "low" && a.confidence === "low")
        || (filter === "grouped" && a.alert_type === "grouped");
      return matchesQuery && matchesFilter;
    });
    return filtered.sort((a, b) => {
      switch (sortBy) {
        case "amount_asc": return Number(a.total_usd || 0) - Number(b.total_usd || 0);
        case "score_desc": return Number(b.score || 0) - Number(a.score || 0);
        case "score_asc": return Number(a.score || 0) - Number(b.score || 0);
        default: return Number(b.total_usd || 0) - Number(a.total_usd || 0);
      }
    });
  }, [alerts, query, filter, sortBy]);

  const highConfidence = alerts.filter((a) => a.confidence === "high").length;
  const totalVolume = alerts.reduce((sum, a) => sum + Number(a.total_usd || 0), 0);
  const uniqueWallets = new Set(alerts.map((a) => a.wallet)).size;

  return (
    <main className="radar-shell">
      <aside className="sidebar">
        <a className="brand" href="#"><span className="brand-mark">R</span><span>POLYMARKET<span className="brand-muted">RADAR</span></span></a>
        <div className="sidebar-label">ESPACE DE TRAVAIL</div>
        <a className="nav-item active" href="#alerts"><span>◈</span> Vue d’ensemble</a>
        <a className="nav-item" href="#alerts"><span>⌁</span> Alertes détectées <b>{alerts.length}</b></a>
        <div className="sidebar-bottom">
          <div className="system-card"><span className="status-dot" /> <span><strong>Scanner actif</strong><small>Synchronisation automatique</small></span></div>
          <button className="logout-button" onClick={() => browserClient().auth.signOut()}>↗ Déconnexion</button>
        </div>
      </aside>

      <section className="main-panel">
        <header className="topbar">
          <div><span className="eyebrow">SURVEILLANCE DES MARCHÉS</span><h1>Vue d’ensemble</h1><p>Repérez les mouvements inhabituels et explorez les signaux détectés.</p></div>
          <button className="refresh-button" onClick={() => void loadAlerts(true)} disabled={refreshing}>{refreshing ? "Actualisation…" : "↻ Actualiser"}</button>
        </header>

        <section className="metric-grid">
          <article className="metric-card"><span className="metric-label">Alertes détectées</span><strong>{loading ? "—" : alerts.length}</strong><small>Sur l’ensemble de l’historique disponible</small><span className="metric-icon">◈</span></article>
          <article className="metric-card"><span className="metric-label">Portefeuilles concernés</span><strong>{loading ? "—" : uniqueWallets}</strong><small>Adresses distinctes signalées</small><span className="metric-icon">⌘</span></article>
          <article className="metric-card"><span className="metric-label">Volume associé</span><strong>{loading ? "—" : money(totalVolume)}</strong><small>Somme des montants des alertes</small><span className="metric-icon">$</span></article>
          <article className="metric-card"><span className="metric-label">Confiance élevée</span><strong>{loading ? "—" : highConfidence}</strong><small>Alertes avec données suffisamment complètes</small><span className="metric-icon">✓</span></article>
        </section>

        <section className="alerts-section" id="alerts">
          <div className="section-heading"><div><span className="eyebrow">CENTRE DE SIGNALEMENT</span><h2>Alertes récentes</h2><p>Chaque signal est une piste à examiner, pas une preuve de fraude.</p></div><span className="result-count">{visibleAlerts.length} résultat{visibleAlerts.length > 1 ? "s" : ""}</span></div>

          <div className="toolbar">
            <label className="search-box"><span>⌕</span><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Rechercher un marché, un portefeuille…" /></label>
            <div className="toolbar-controls">
              <div className="filter-group">
                {[["all","Toutes"],["high","Confiance élevée"],["medium","Moyenne"],["low","Faible"],["grouped","Groupées"]].map(([key,label]) =>
                  <button key={key} className={filter === key ? "filter-chip selected" : "filter-chip"} onClick={() => setFilter(key)}>{label}</button>
                )}
              </div>
              <label className="sort-control"><span>Trier par</span><select value={sortBy} onChange={(e) => setSortBy(e.target.value)}><option value="amount_desc">Montant : décroissant</option><option value="amount_asc">Montant : croissant</option><option value="score_desc">Score : décroissant</option><option value="score_asc">Score : croissant</option></select></label>
            </div>
          </div>

          {error && <div className="error-banner"><strong>Chargement impossible</strong><span>{error}</span><button onClick={() => void loadAlerts()}>Réessayer</button></div>}
          {loading && <div className="empty-state"><div className="loader" /><strong>Chargement des alertes</strong><span>Connexion sécurisée à votre espace Supabase…</span></div>}
          {!loading && !error && visibleAlerts.length === 0 && <div className="empty-state"><span className="empty-icon">⌕</span><strong>{alerts.length ? "Aucun résultat pour ces filtres" : "Aucune alerte enregistrée"}</strong><span>{alerts.length ? "Modifiez votre recherche ou choisissez un autre filtre." : "Les nouveaux signaux apparaîtront ici après leur détection."}</span></div>}

          <div className="alert-list">
            {visibleAlerts.map((alert) => {
              const isOpen = expanded === alert.id;
              return <article className={isOpen ? "alert-card expanded" : "alert-card"} key={alert.id}>
                <button className="alert-summary" onClick={() => setExpanded(isOpen ? null : alert.id)} aria-expanded={isOpen}>
                  <div className="score-column"><span className="score-caption">{alert.score >= 70 ? "PRIORITAIRE" : alert.score >= 40 ? "NORMALE" : "À SURVEILLER"}</span><strong className={alert.score >= 70 ? "score high" : alert.score >= 40 ? "score medium" : "score low"}>{alert.score}</strong><span className="score-outof">/ 100</span></div>
                  <div className="alert-main">
                    <div className="alert-title-row"><h3>{alert.market?.question || "Marché non retrouvé"}</h3><span className={`confidence-pill ${alert.confidence}`}>{confidenceLabel(alert.confidence)} confiance</span></div>
                    <div className="alert-meta"><span>{alert.alert_type === "grouped" ? "◉ Activité groupée" : "◉ Transaction isolée"}</span><span>Portefeuille <code>{shortWallet(alert.wallet)}</code></span><span>{date(alert.created_at)}</span></div>
                    <div className="alert-tags">{(alert.factors ?? []).slice(0,3).map((f,i) => <span key={f.code ?? i}>{f.label_fr || f.label_en || f.code} <b>+{Number(f.points ?? 0).toFixed(1)}</b></span>)}</div>
                  </div>
                  <div className="amount-column"><span>Montant associé</span><strong>{money(alert.total_usd)}</strong><small>{alert.trades?.length ?? alert.trade_ids?.length ?? 0} transaction(s)</small></div>
                  <span className="expand-icon">{isOpen ? "−" : "+"}</span>
                </button>

                {isOpen && <div className="alert-details">
                  <div className="detail-grid">
                    <div className="detail-block"><span className="detail-label">PORTEFEUILLE</span><strong className="mono">{shortWallet(alert.wallet)}</strong><div className="wallet-actions"><button className="text-action" onClick={() => navigator.clipboard?.writeText(alert.wallet)}>Copier l’adresse</button><a className="text-action" href={`https://polymarket.com/profile/${encodeURIComponent(alert.wallet)}`} target="_blank" rel="noreferrer">Voir le profil Polymarket ↗</a></div></div>
                    <div className="detail-block"><span className="detail-label">PRIX MINIMUM OBSERVÉ</span><strong>{alert.price_min == null ? "—" : `${(Number(alert.price_min) * 100).toFixed(2)} %`}</strong></div>
                    <div className="detail-block"><span className="detail-label">PREMIÈRE TRANSACTION</span><strong>{date(alert.first_trade_at)}</strong></div>
                    <div className="detail-block"><span className="detail-label">DERNIÈRE TRANSACTION</span><strong>{date(alert.last_trade_at)}</strong></div>
                    <div className="detail-block"><span className="detail-label">LIQUIDITÉ DU MARCHÉ</span><strong>{money(alert.market?.liquidity)}</strong></div>
                    <div className="detail-block"><span className="detail-label">CATÉGORIE</span><strong>{alert.market?.category || "—"}</strong></div>
                  </div>

                  <div className="detail-section"><h4>Pourquoi cette alerte ?</h4><div className="factor-list">{(alert.factors ?? []).map((factor,i) => <div className="factor-row" key={factor.code ?? i}><span className="factor-dot" /><div><strong>{factor.label_fr || factor.label_en || factor.code}</strong><small>{factor.detail || "Facteur détecté"}</small></div><b>+{Number(factor.points ?? 0).toFixed(1)} pts</b></div>)}</div></div>

                  {(alert.missing_data ?? []).length > 0 && <div className="missing-note"><strong>Informations non disponibles</strong><span>{alert.missing_data.map((key) => missingLabel[key] || key).join(" · ")}</span><small>Ces données manquantes expliquent le niveau de confiance réduit. Elles ne sont pas assimilées à des anomalies.</small></div>}

                  <div className="detail-section"><div className="subheading-row"><h4>Transactions associées</h4><span>{alert.trades?.length ?? 0} chargée(s) / {alert.trade_ids?.length ?? 0} référencée(s)</span></div>
                    {alert.trades?.length ? <div className="trade-table-wrap"><table className="trade-table"><thead><tr><th>DATE</th><th>SENS</th><th>ISSUE</th><th>PRIX</th><th>QUANTITÉ</th><th>MONTANT</th><th>TRANSACTION</th></tr></thead><tbody>{alert.trades.map((trade) => <tr key={trade.trade_id}><td>{date(trade.traded_at)}</td><td><span className={trade.side === "BUY" ? "side-buy" : "side-sell"}>{trade.side === "BUY" ? "Achat" : "Vente"}</span></td><td>{trade.outcome || alert.outcome || "—"}</td><td>{(Number(trade.price) * 100).toFixed(2)} %</td><td>{Number(trade.size).toLocaleString("fr-FR",{maximumFractionDigits:2})}</td><td>{money(trade.usd_amount)}</td><td><code>{trade.transaction_hash ? trade.transaction_hash.slice(0,10)+"…" : trade.trade_id.slice(0,10)+"…"}</code></td></tr>)}</tbody></table></div> : <p className="no-trades">Les identifiants des transactions sont enregistrés, mais leurs détails ne sont pas disponibles dans la table des transactions.</p>}
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
