"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { browserClient } from "@/lib/supabase";
import { computeV2Scores } from "@/lib/scoring-v2";

type Factor = { code?: string; label?: string; label_fr?: string; label_en?: string; points?: number; score?: number; weight?: number; detail?: string };
type Trade = { trade_id: string; transaction_hash: string; wallet: string; pseudonym: string | null; side: string; outcome: string | null; price: number; size: number; usd_amount: number; traded_at: string };
type Market = { question: string; url: string; category: string | null; liquidity: number | null; volume: number | null; end_date: string | null };
type V2Signal = {
  id: string; dedupe_key: string; wallet: string; market_id: string; condition_id: string;
  side: string; outcome: string | null; trade_ids: string[]; total_usd: number; price_min: number | null; price_avg: number | null;
  first_trade_at: string; last_trade_at: string; score: number; coverage: number; regime: string;
  factors: Factor[]; missing_data: string[]; model_version: string; computed_at: string | null;
  market: Market | null; trades: Trade[];
};
type Alert = {
  id: string; wallet: string; market_id: string; condition_id: string; alert_type: string;
  score: number; confidence: string; factors: Factor[]; missing_data: string[]; trade_ids: string[];
  total_usd: number; price_min: number | null; outcome: string | null;
  first_trade_at: string | null; last_trade_at: string | null; created_at: string;
  market: Market | null; trades: Trade[];
  scoring_v2?: { score: number; coverage: number; regime?: string; factors: { code: string; label: string; score: number; weight: number; detail: string }[]; unavailable: string[]; model_version?: string; computed_at?: string } | null;
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
  const [signalsV2, setSignalsV2] = useState<V2Signal[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [sortBy, setSortBy] = useState("amount_desc");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [activeView, setActiveView] = useState("overview");

  useEffect(() => {
    const saved = window.localStorage.getItem("radar-theme");
    if (saved === "light" || saved === "dark") setTheme(saved);
  }, []);

  const changeTheme = () => setTheme((current) => {
    const next = current === "dark" ? "light" : "dark";
    window.localStorage.setItem("radar-theme", next);
    return next;
  });

  const navigateTo = (view: string) => {
    setActiveView(view);
    document.getElementById(view)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

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
      setSignalsV2(payload.signalsV2 ?? []);
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

  const v2Scores = useMemo(() => computeV2Scores(alerts), [alerts]);

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
        case "v2_desc": return (v2Scores.get(b.id)?.score ?? 0) - (v2Scores.get(a.id)?.score ?? 0);
        case "v2_asc": return (v2Scores.get(a.id)?.score ?? 0) - (v2Scores.get(b.id)?.score ?? 0);
        default: return Number(b.total_usd || 0) - Number(a.total_usd || 0);
      }
    });
  }, [alerts, query, filter, sortBy, v2Scores]);

  const highConfidence = alerts.filter((a) => a.confidence === "high").length;
  const totalVolume = alerts.reduce((sum, a) => sum + Number(a.total_usd || 0), 0);
  const uniqueWallets = new Set([...alerts.map((a) => a.wallet), ...signalsV2.map((s) => s.wallet)]).size;
  const averageV2 = signalsV2.length ? Math.round(signalsV2.reduce((sum, signal) => sum + Number(signal.score || 0), 0) / signalsV2.length) : 0;
  const highV2 = signalsV2.filter((signal) => signal.score >= 75).length;

  return (
    <main className="radar-shell" data-theme={theme}>
      <aside className="sidebar">
        <a className="brand" href="#overview" onClick={() => setActiveView("overview")}><span className="brand-mark"><svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="15" fill="none" stroke="currentColor" strokeWidth="1.6" opacity=".55"/><circle cx="20" cy="20" r="9" fill="none" stroke="currentColor" strokeWidth="1.6" opacity=".8"/><path d="M20 20 32 8M20 20l-1 10" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"/><circle cx="20" cy="20" r="2.7" fill="currentColor"/></svg></span><span>POLYMARKET<span className="brand-muted">RADAR / INTELLIGENCE</span></span></a>
        <div className="sidebar-label">WORKSPACE</div>
        <button className={`nav-item ${activeView === "overview" ? "active" : ""}`} onClick={() => navigateTo("overview")}><span>⌂</span> Vue d’ensemble</button>
        <button className={`nav-item ${activeView === "v2-signals" ? "active" : ""}`} onClick={() => navigateTo("v2-signals")}><span>◈</span> Intelligence V2 <b>{signalsV2.length}</b></button>
        <button className={`nav-item ${activeView === "v1-alerts" ? "active" : ""}`} onClick={() => navigateTo("v1-alerts")}><span>⌁</span> Alertes V1 <b>{alerts.length}</b></button>
        <div className="sidebar-label nav-secondary-label">MONITORING</div>
        <div className="nav-static"><span>◎</span> Surveillance active</div>
        <div className="sidebar-bottom">
          <div className="system-card"><span className="status-dot" /> <span><strong>Scanner actif</strong><small>Synchronisation automatique</small></span></div>
          <button className="logout-button" onClick={() => browserClient().auth.signOut()}>↗ Déconnexion</button>
        </div>
      </aside>

      <section className="main-panel" id="overview">
        <header className="topbar">
          <div><span className="eyebrow">MARKET INTELLIGENCE / LIVE MONITORING</span><h1>Vue d’ensemble</h1><p>Détection et analyse des activités atypiques sur les marchés prédictifs.</p></div>
          <div className="topbar-actions"><button className="theme-toggle" onClick={changeTheme} aria-label="Basculer le thème"><span>{theme === "dark" ? "☼" : "◐"}</span>{theme === "dark" ? "Mode clair" : "Mode sombre"}</button><button className="refresh-button" onClick={() => void loadAlerts(true)} disabled={refreshing}>{refreshing ? "Actualisation…" : "↻ Actualiser"}</button></div>
        </header>

        <section className="metric-grid">
          <article className="metric-card metric-primary"><span className="metric-label">Signaux V2 qualifiés</span><strong>{loading ? "—" : signalsV2.length}</strong><small>Score minimum affiché : 50 / 100</small><span className="metric-icon">◈</span></article>
          <article className="metric-card"><span className="metric-label">Score V2 moyen</span><strong>{loading ? "—" : `${averageV2}/100`}</strong><small>Sur les signaux actuellement visibles</small><span className="metric-icon">↗</span></article>
          <article className="metric-card"><span className="metric-label">Portefeuilles suivis</span><strong>{loading ? "—" : uniqueWallets}</strong><small>Adresses distinctes identifiées</small><span className="metric-icon">◎</span></article>
          <article className="metric-card"><span className="metric-label">Signaux à forte intensité</span><strong>{loading ? "—" : highV2}</strong><small>Score V2 supérieur ou égal à 75</small><span className="metric-icon">✳</span></article>
        </section>

        <section className="alerts-section v2-main-section" id="v2-signals">
          <div className="section-heading"><div><span className="eyebrow">PRIMARY ENGINE / SCORING V2</span><h2>Intelligence des signaux</h2><p>Signaux qualifiés sur l’ensemble des régimes de prix, achats et ventes confondus.</p></div><span className="result-count">{signalsV2.length} signal{signalsV2.length > 1 ? "x" : ""}</span></div>
          {!loading && signalsV2.length === 0 && <div className="empty-state"><strong>Aucun signal V2 pour le moment</strong><span>Les signaux apparaîtront après le prochain passage du scanner sur les marchés.</span></div>}
          <div className="alert-list">
            {signalsV2.map((signal) => {
              const key = `v2:${signal.id}`;
              const isOpen = expanded === key;
              return <article className={isOpen ? "alert-card expanded" : "alert-card"} key={key}>
                <button className="alert-summary" onClick={() => setExpanded(isOpen ? null : key)} aria-expanded={isOpen}>
                  <div className="score-column"><span className="score-caption">V2 · {signal.regime}</span><strong className="score score-v2">{signal.score}</strong><span className="score-outof">/100</span></div>
                  <div className="alert-main">
                    <div className="alert-title-row"><h3>{signal.market?.question || "Marché non retrouvé"}</h3><span className={signal.side === "BUY" ? "side-buy" : "side-sell"}>{signal.side === "BUY" ? "Achat" : "Vente"} · {signal.outcome || "Résultat inconnu"}</span></div>
                    <div className="alert-meta"><span>Portefeuille <code>{shortWallet(signal.wallet)}</code></span><span>{date(signal.first_trade_at)}</span><span>Couverture {signal.coverage}%</span></div>
                    <div className="alert-tags">{(signal.factors ?? []).slice(0,3).map((factor,i) => <span key={factor.code ?? i}>{factor.label_fr || factor.label_en || factor.code} <b>{Number(factor.score ?? 0).toFixed(0)}/100</b></span>)}</div>
                  </div>
                  <div className="amount-column"><span>Montant associé</span><strong>{money(signal.total_usd)}</strong><small>{signal.trades?.length ?? signal.trade_ids?.length ?? 0} transaction(s)</small></div>
                  <span className="expand-icon">{isOpen ? "−" : "+"}</span>
                </button>
                {isOpen && <div className="alert-details">
                  <div className="detail-grid">
                    <div className="detail-block"><span className="detail-label">PORTEFEUILLE</span><strong className="mono">{shortWallet(signal.wallet)}</strong><div className="wallet-actions"><button className="text-action" onClick={() => navigator.clipboard?.writeText(signal.wallet)}>Copier l’adresse</button><a className="text-action" href={`https://polymarket.com/profile/${encodeURIComponent(signal.wallet)}`} target="_blank" rel="noreferrer">Voir le profil Polymarket ↗</a></div></div>
                    <div className="detail-block"><span className="detail-label">PRIX MOYEN PONDÉRÉ</span><strong>{signal.price_avg == null ? "—" : `${(Number(signal.price_avg)*100).toFixed(2)} %`}</strong></div>
                    <div className="detail-block"><span className="detail-label">PRIX MINIMUM</span><strong>{signal.price_min == null ? "—" : `${(Number(signal.price_min)*100).toFixed(2)} %`}</strong></div>
                    <div className="detail-block"><span className="detail-label">RÉGIME DE PRIX</span><strong>{signal.regime}</strong></div>
                    <div className="detail-block"><span className="detail-label">PREMIÈRE TRANSACTION</span><strong>{date(signal.first_trade_at)}</strong></div>
                    <div className="detail-block"><span className="detail-label">DERNIÈRE TRANSACTION</span><strong>{date(signal.last_trade_at)}</strong></div>
                  </div>
                  <div className="detail-section"><h4>Décomposition du nouveau score · {signal.score}/100</h4><div className="factor-list">{(signal.factors ?? []).map((factor,i) => <div className="factor-row" key={factor.code ?? i}><span className="factor-dot factor-dot-v2" /><div><strong>{factor.label_fr || factor.label_en || factor.code}</strong><small>{factor.detail || "Facteur calculé"}</small></div><b>{Number(factor.score ?? 0).toFixed(0)}/100 · {Number(factor.weight ?? 0).toFixed(0)} %</b></div>)}</div></div>
                  {(signal.missing_data ?? []).length > 0 && <div className="missing-note"><strong>Données encore manquantes</strong><span>{signal.missing_data.join(" · ")}</span><small>La couverture indique la part des pondérations effectivement calculées.</small></div>}
                  <div className="detail-section"><div className="subheading-row"><h4>Transactions du signal</h4><span>{signal.trades?.length ?? 0} chargée(s)</span></div>
                    {signal.trades?.length ? <div className="trade-table-wrap"><table className="trade-table"><thead><tr><th>DATE</th><th>SENS</th><th>ISSUE</th><th>PRIX</th><th>QUANTITÉ</th><th>MONTANT</th><th>TRANSACTION</th></tr></thead><tbody>{signal.trades.map((trade) => <tr key={trade.trade_id}><td>{date(trade.traded_at)}</td><td><span className={trade.side === "BUY" ? "side-buy" : "side-sell"}>{trade.side === "BUY" ? "Achat" : "Vente"}</span></td><td>{trade.outcome || signal.outcome || "—"}</td><td>{(Number(trade.price)*100).toFixed(2)} %</td><td>{Number(trade.size).toLocaleString("fr-FR",{maximumFractionDigits:2})}</td><td>{money(trade.usd_amount)}</td><td><code>{trade.transaction_hash ? trade.transaction_hash.slice(0,10)+"…" : trade.trade_id.slice(0,10)+"…"}</code></td></tr>)}</tbody></table></div> : <p className="no-trades">Les transactions associées ne sont plus présentes dans l’historique brut.</p>}
                  </div>
                  <div className="detail-footer"><span>ID marché : <code>{signal.market_id}</code></span><span>Condition : <code>{shortWallet(signal.condition_id)}</code></span>{signal.market?.url && <a href={signal.market.url} target="_blank" rel="noreferrer">Ouvrir le marché sur Polymarket ↗</a>}</div>
                </div>}
              </article>;
            })}
          </div>
        </section>

        <section className="alerts-section v1-section" id="v1-alerts">
          <div className="section-heading"><div><span className="eyebrow">LEGACY ENGINE / V1</span><h2>Alertes historiques</h2><p>Moteur historique conservé en complément. Chaque signal reste une piste à examiner, pas une preuve de fraude.</p><div className="scoring-legend"><span><b className="legend-old" /> Ancien score : moteur de détection actuel</span><span><b className="legend-new" /> Nouveau score : expérimental, données partielles</span></div></div><span className="result-count">{visibleAlerts.length} résultat{visibleAlerts.length > 1 ? "s" : ""}</span></div>

          <div className="toolbar">
            <label className="search-box"><span>⌕</span><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Rechercher un marché, un portefeuille…" /></label>
            <div className="toolbar-controls">
              <div className="filter-group">
                {[["all","Toutes"],["high","Confiance élevée"],["medium","Moyenne"],["low","Faible"],["grouped","Groupées"]].map(([key,label]) =>
                  <button key={key} className={filter === key ? "filter-chip selected" : "filter-chip"} onClick={() => setFilter(key)}>{label}</button>
                )}
              </div>
              <label className="sort-control"><span>Trier par</span><select value={sortBy} onChange={(e) => setSortBy(e.target.value)}><option value="amount_desc">Montant : décroissant</option><option value="amount_asc">Montant : croissant</option><option value="score_desc">Ancien score : décroissant</option><option value="score_asc">Ancien score : croissant</option><option value="v2_desc">Nouveau score : décroissant</option><option value="v2_asc">Nouveau score : croissant</option></select></label>
            </div>
          </div>

          {error && <div className="error-banner"><strong>Chargement impossible</strong><span>{error}</span><button onClick={() => void loadAlerts()}>Réessayer</button></div>}
          {loading && <div className="empty-state"><div className="loader" /><strong>Chargement des alertes</strong><span>Connexion sécurisée à votre espace Supabase…</span></div>}
          {!loading && !error && visibleAlerts.length === 0 && <div className="empty-state"><span className="empty-icon">⌕</span><strong>{alerts.length ? "Aucun résultat pour ces filtres" : "Aucune alerte enregistrée"}</strong><span>{alerts.length ? "Modifiez votre recherche ou choisissez un autre filtre." : "Les nouveaux signaux apparaîtront ici après leur détection."}</span></div>}

          <div className="alert-list">
            {visibleAlerts.map((alert) => {
              const isOpen = expanded === alert.id;
              const v2 = alert.scoring_v2 ?? v2Scores.get(alert.id);
              return <article className={isOpen ? "alert-card expanded" : "alert-card"} key={alert.id}>
                <button className="alert-summary" onClick={() => setExpanded(isOpen ? null : alert.id)} aria-expanded={isOpen}>
                  <div className="score-pair"><div className="score-column"><span className="score-caption">V2 · PRINCIPAL</span><strong className="score score-v2">{v2?.score ?? "—"}</strong><span className="score-outof">/100</span></div><div className="score-column score-column-legacy"><span className="score-caption">V1</span><strong className={alert.score >= 70 ? "score score-secondary high" : alert.score >= 40 ? "score score-secondary medium" : "score score-secondary low"}>{alert.score}</strong><span className="score-outof">/100</span></div></div>
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

                  <div className="detail-section v2-panel"><div className="subheading-row"><h4>Nouveau scoring — {v2?.score ?? "—"}/100</h4><span>{v2?.coverage ?? 0} % des pondérations couvertes{alert.scoring_v2?.regime ? ` · régime ${alert.scoring_v2.regime}` : ""}{alert.scoring_v2?.model_version ? ` · ${alert.scoring_v2.model_version}` : ""}</span></div><p className="v2-disclaimer">Score calculé par Supabase à partir des transactions observées, des références par marché et des snapshots de prix disponibles. La couverture indique la part des pondérations effectivement calculées ; le ROI/win rate et l’impact post-trade restent partiels tant que l’historique nécessaire n’est pas accumulé.</p><div className="factor-list">{(v2?.factors ?? []).map((factor) => <div className="factor-row" key={factor.code}><span className="factor-dot factor-dot-v2" /><div><strong>{factor.label}</strong><small>{factor.detail}</small></div><b>{factor.score.toFixed(0)}/100 · {factor.weight} %</b></div>)}</div>{(v2?.unavailable ?? []).length > 0 && <p className="v2-missing">À compléter : {v2?.unavailable.join(" · ")}</p>}</div><div className="detail-section"><h4>Pourquoi l’ancien moteur a déclenché cette alerte ?</h4><div className="factor-list">{(alert.factors ?? []).map((factor,i) => <div className="factor-row" key={factor.code ?? i}><span className="factor-dot" /><div><strong>{factor.label_fr || factor.label_en || factor.code}</strong><small>{factor.detail || "Facteur détecté"}</small></div><b>+{Number(factor.points ?? 0).toFixed(1)} pts</b></div>)}</div></div>

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
