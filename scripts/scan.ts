// The former local scan runner invoked the retired V1/V2 scoring pipeline.
// Production scanning is now owned by the polymarket-hourly-scan Supabase Edge Function.
console.error(
  "Le scanner local historique est désactivé. Le scanner BUY unifié est exécuté par Supabase Edge Functions.",
);
process.exit(1);
