"use client";
import { useEffect, useState } from "react";
import { browserClient } from "@/lib/supabase";
export default function SettingsPanel() {
  const [connected, setConnected] = useState(false), [username, setUsername] = useState<string | null>(null);
  const [loading, setLoading] = useState(true), [creating, setCreating] = useState(false);
  const [link, setLink] = useState(""), [error, setError] = useState("");
  async function request(path: string, method = "GET") {
    const { data } = await browserClient().auth.getSession(), token = data.session?.access_token;
    if (!token) throw new Error("Session expirée. Reconnectez-vous.");
    const response = await fetch(path, { method, headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Une erreur est survenue.");
    return payload;
  }
  async function refresh() {
    try { const data = await request("/api/telegram/link"); setConnected(data.connected); setUsername(data.username); }
    catch (e) { setError(e instanceof Error ? e.message : "Erreur inconnue"); }
    finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, []);
  async function createLink() {
    setCreating(true); setError(""); setLink("");
    try { const data = await request("/api/telegram/link", "POST"); setLink(data.url); }
    catch (e) { setError(e instanceof Error ? e.message : "Erreur inconnue"); }
    finally { setCreating(false); }
  }
  return <section className="card" style={{ padding: 24, maxWidth: 720 }}>
    <h1>Notifications Telegram</h1>
    <p>Recevez une alerte uniquement lorsque les six critères sont tous vérifiés :</p>
    <ul>
      <li>Prix moyen d'achat inférieur à 60 ¢</li><li>Montant de transaction ≥ 2 500 $</li>
      <li>Âge du compte vérifié ≤ 7 jours</li><li>Concentration sur le résultat ≥ 90 %</li>
      <li>Score de taille relative ≥ 70/100</li><li>Score global ≥ 80/100</li>
    </ul>
    <p><strong>État :</strong> {loading ? "Vérification…" : connected ? `Connecté${username ? ` (@${username})` : ""}` : "Non connecté"}</p>
    <button type="button" onClick={createLink} disabled={creating}>{creating ? "Création du lien…" : connected ? "Reconnecter Telegram" : "Connecter Telegram"}</button>
    {link && <p><a href={link} target="_blank" rel="noreferrer">Ouvrir Telegram et activer le bot ↗</a><br/><small>Ce lien expire dans 10 minutes et ne peut être utilisé qu'une fois.</small></p>}
    {error && <p role="alert">{error}</p>}
    <p><small>Canal activé : Telegram uniquement. Aucun SMS, e-mail ou push.</small></p>
  </section>;
}