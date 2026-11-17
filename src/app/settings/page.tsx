"use client";
import { useEffect, useState } from "react";
import { browserClient } from "@/lib/supabase";
import SettingsPanel from "@/components/SettingsPanel";
import LoginPage from "@/components/LoginPage";
export default function SettingsPage() {
  const [authenticated,setAuthenticated]=useState<boolean|null>(null);
  useEffect(()=>{const client=browserClient();client.auth.getSession().then(({data})=>setAuthenticated(!!data.session));const {data}=client.auth.onAuthStateChange((_event,session)=>setAuthenticated(!!session));return()=>data.subscription.unsubscribe();},[]);
  if(authenticated===null)return <p style={{padding:32}}>Chargement…</p>;
  if(!authenticated)return <LoginPage/>;
  return <main style={{padding:32}}><p><a href="/">← Retour au tableau de bord</a></p><SettingsPanel/></main>;
}