-- The BUY history has been consolidated into public.alerts. The legacy
-- V2 score and price-snapshot tables are no longer read by the application.
-- Remove the old retention cron that would otherwise query the dropped table.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid)
    from cron.job
    where command ilike '%market_price_snapshots%';
  end if;
end
$$;

drop function if exists public.refresh_alert_scores_v2();
drop function if exists public.refresh_scoring_v2_signals();

drop table if exists public.alert_scores_v2;
drop table if exists public.scoring_v2_signals;
drop table if exists public.market_price_snapshots;
