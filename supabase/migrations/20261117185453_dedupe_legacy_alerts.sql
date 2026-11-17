-- Remove duplicate V1/V2 alert rows with identical transaction IDs and aggregates.
delete from public.alerts duplicate
using public.alerts keeper
where duplicate.id = '88606b7a-65bf-4a27-b691-dbe8b4712872'::uuid
  and keeper.id = '972d942d-1976-48e9-b773-e885b64226fa'::uuid
  and duplicate.wallet = keeper.wallet
  and duplicate.condition_id = keeper.condition_id
  and duplicate.trade_ids = keeper.trade_ids
  and duplicate.total_usd = keeper.total_usd
  and duplicate.first_trade_at = keeper.first_trade_at
  and duplicate.last_trade_at = keeper.last_trade_at;