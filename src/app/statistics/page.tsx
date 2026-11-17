"use client";

import { useEffect, useState } from "react";
import { browserClient } from "@/lib/supabase";
import StatisticsDashboard from "@/components/StatisticsDashboard";
import LoginPage from "@/components/LoginPage";

export default function StatisticsPage() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  useEffect(() => {
    const client = browserClient();
    client.auth.getSession().then(({ data }) => setAuthenticated(!!data.session));
    const { data } = client.auth.onAuthStateChange((_event, session) => setAuthenticated(!!session));
    return () => data.subscription.unsubscribe();
  }, []);
  if (authenticated === null) return <p className="p-8">Chargement…</p>;
  return authenticated ? <StatisticsDashboard /> : <LoginPage />;
}
