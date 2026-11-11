"use client";

import { useState } from "react";
import type { FormEvent } from "react";
import { browserClient } from "@/lib/supabase";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setLoading(true);
    const { error } = await browserClient().auth.signInWithPassword({ email, password });
    if (error) {
      setError("Connexion impossible. Vérifiez votre adresse e-mail et votre mot de passe.");
      setLoading(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-aside">
        <div className="login-brand"><span className="brand-mark">R</span><span>POLYMARKET <b>RADAR</b></span></div>
        <div className="login-message"><span className="eyebrow">OBSERVEZ LES SIGNAUX FAIBLES</span><h1>Les mouvements<br/>qui méritent<br/><em>votre attention.</em></h1><p>Un espace privé pour suivre l’activité inhabituelle sur les marchés politiques de Polymarket.</p></div>
        <div className="login-footnote">ANALYSE • CONTEXTE • VIGILANCE</div>
      </section>
      <section className="login-main">
        <form className="login-form" onSubmit={submit}>
          <span className="eyebrow">ESPACE PERSONNEL</span>
          <h2>Bon retour.</h2>
          <p>Connectez-vous pour accéder à votre tableau de bord.</p>
          <label htmlFor="login-email">Adresse e-mail</label>
          <input id="login-email" className="input login-input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="vous@exemple.com"/>
          <label htmlFor="login-password">Mot de passe</label>
          <input id="login-password" className="input login-input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Votre mot de passe"/>
          {error && <div className="login-error" role="alert">{error}</div>}
          <button className="btn login-submit" type="submit" disabled={loading}>{loading ? "Connexion…" : "Se connecter"} <span>→</span></button>
          <small className="login-security">Connexion sécurisée par Supabase Auth.</small>
        </form>
      </section>
    </main>
  );
}
