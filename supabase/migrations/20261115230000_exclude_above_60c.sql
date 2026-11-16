-- Regle produit : ne pas suivre les probabilites au-dessus de 60c.
-- Les regimes deviennent : longshot < 20c, contested 20c-60c, favorite = exclu.
-- Le seuil est parametrable via app_settings.data->'v2_max_price' (defaut 0.6).

update public.app_settings
set data = data || '{"v2_max_price": 0.6}'::jsonb
where id = 1 and (data->>'v2_max_price') is null;

-- Purge des signaux exclus (favorites et contested au-dessus de 60c).
delete from public.scoring_v2_signals
where regime = 'favorite'
   or coalesce(price_avg, price_min) > coalesce((select nullif((data->>'v2_max_price')::numeric, null) from public.app_settings where id = 1), 0.6);

-- La fonction refresh_scoring_v2_signals supprime desormais automatiquement tout
-- signal dont le prix pondere depasse le seuil, au lieu de le noter en regime favorite.
-- Les alertes legacy ne sont pas impactees : leur filtre prix est deja <= 20c.
