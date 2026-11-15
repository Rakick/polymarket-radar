
create table if not exists public.market_price_snapshots (
 id bigint generated always as identity primary key,
 market_id text not null references public.markets(id) on delete cascade,
 condition_id text not null,
 captured_at timestamptz not null default now(),
 outcome_prices jsonb not null,
 volume numeric,
 liquidity numeric,
 source text not null default 'gamma_catalogue'
);
create index if not exists market_price_snapshots_market_time_idx on public.market_price_snapshots(market_id,captured_at desc);
create table if not exists public.alert_scores_v2 (
 alert_id uuid primary key references public.alerts(id) on delete cascade,
 score integer not null check(score between 0 and 100),
 coverage integer not null check(coverage between 0 and 100),
 regime text not null check(regime in ('longshot','contested','favorite','unknown')),
 factors jsonb not null default '[]'::jsonb,
 missing_data jsonb not null default '[]'::jsonb,
 model_version text not null default 'v2.1.0',
 computed_at timestamptz not null default now()
);
create index if not exists alert_scores_v2_score_idx on public.alert_scores_v2(score desc);
alter table public.market_price_snapshots enable row level security;
alter table public.alert_scores_v2 enable row level security;
CREATE OR REPLACE FUNCTION public.capture_market_price_snapshot()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.outcome_prices is null or jsonb_typeof(new.outcome_prices) <> 'array' then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.outcome_prices is not distinct from new.outcome_prices
     and old.volume is not distinct from new.volume
     and old.liquidity is not distinct from new.liquidity then
    return new;
  end if;
  if not exists (
    select 1 from public.market_price_snapshots s
    where s.market_id = new.id and s.captured_at > now() - interval '20 minutes'
  ) then
    insert into public.market_price_snapshots(market_id, condition_id, captured_at, outcome_prices, volume, liquidity)
    values (new.id, new.condition_id, now(), new.outcome_prices, new.volume, new.liquidity);
  end if;
  return new;
end;
$function$
;
drop trigger if exists trg_capture_market_price_snapshot on public.markets;
create trigger trg_capture_market_price_snapshot after insert or update of outcome_prices,volume,liquidity on public.markets
for each row execute function public.capture_market_price_snapshot();
insert into public.market_price_snapshots(market_id,condition_id,captured_at,outcome_prices,volume,liquidity)
select m.id,m.condition_id,now(),m.outcome_prices,m.volume,m.liquidity from public.markets m
where m.outcome_prices is not null and jsonb_typeof(m.outcome_prices)='array'
and not exists(select 1 from public.market_price_snapshots s where s.market_id=m.id);
CREATE OR REPLACE FUNCTION public.refresh_alert_scores_v2()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  a public.alerts%rowtype;
  m public.markets%rowtype;
  v_trade_count integer;
  v_trade_total numeric;
  v_weighted_price numeric;
  v_first_trade timestamptz;
  v_last_trade timestamptz;
  v_outcome text;
  v_side text;
  v_regime text;
  w_size numeric;
  w_conviction numeric;
  w_wallet numeric;
  w_timing numeric;
  w_impact numeric;
  w_coordination numeric;
  v_market_n integer;
  v_median numeric;
  v_mad numeric;
  v_z numeric;
  s_size numeric;
  s_conviction numeric;
  s_wallet numeric;
  s_timing numeric;
  s_impact numeric;
  s_coordination numeric;
  v_liquidity_share numeric;
  v_volume_share numeric;
  v_age_days numeric;
  v_wallet_raw_count integer;
  v_wallet_raw_sum numeric;
  v_wallet_markets integer;
  v_wallet_first_raw date;
  v_archive_count numeric;
  v_archive_sum numeric;
  v_wallet_avg numeric;
  v_wallet_age_score numeric;
  v_wallet_ticket_score numeric;
  v_wallet_breadth_score numeric;
  v_wallet_parts integer;
  v_days_to_resolution numeric;
  v_outcome_index integer;
  v_pre_price numeric;
  v_post_price numeric;
  v_impact_change numeric;
  v_other_wallets integer;
  v_coord_rows integer;
  v_score numeric;
  v_coverage integer;
  v_factors jsonb;
  v_missing jsonb;
  v_detail text;
  v_done integer := 0;
begin
  for a in select * from public.alerts order by created_at desc limit 2000 loop
    select * into m from public.markets where id = a.market_id;

    select count(*)::integer,
           coalesce(sum(t.usd_amount), a.total_usd),
           case when sum(t.usd_amount) > 0 then sum(t.price * t.usd_amount) / sum(t.usd_amount) end,
           min(t.traded_at), max(t.traded_at),
           (array_agg(t.outcome order by t.traded_at) filter (where t.outcome is not null))[1],
           (array_agg(t.side order by t.traded_at) filter (where t.side is not null))[1]
      into v_trade_count, v_trade_total, v_weighted_price, v_first_trade, v_last_trade, v_outcome, v_side
    from public.trades t where t.trade_id = any(a.trade_ids);

    v_trade_total := coalesce(nullif(v_trade_total,0), a.total_usd, 0);
    v_first_trade := coalesce(v_first_trade, a.first_trade_at);
    v_last_trade := coalesce(v_last_trade, a.last_trade_at);
    v_outcome := coalesce(v_outcome, a.outcome);
    v_side := coalesce(v_side, 'BUY');
    v_weighted_price := coalesce(v_weighted_price, a.price_min);

    if v_weighted_price is null or v_weighted_price <= 0 then
      v_regime := 'unknown';
      w_size := 20; w_conviction := 15; w_wallet := 25; w_timing := 10; w_impact := 20; w_coordination := 10;
    elsif v_weighted_price < 0.20 then
      v_regime := 'longshot';
      w_size := 18; w_conviction := 18; w_wallet := 24; w_timing := 10; w_impact := 20; w_coordination := 10;
    elsif v_weighted_price <= 0.80 then
      v_regime := 'contested';
      w_size := 20; w_conviction := 15; w_wallet := 25; w_timing := 10; w_impact := 20; w_coordination := 10;
    else
      v_regime := 'favorite';
      w_size := 18; w_conviction := 15; w_wallet := 27; w_timing := 10; w_impact := 20; w_coordination := 10;
    end if;

    v_factors := '[]'::jsonb;
    v_missing := '[]'::jsonb;
    v_score := 0;
    v_coverage := 0;

    -- Robust size anomaly: median/MAD of log trade size within the same market.
    select count(*)::integer,
           percentile_cont(0.5) within group(order by ln(greatest(t.usd_amount, 1)))
      into v_market_n, v_median
    from public.trades t
    where t.market_id = a.market_id and t.usd_amount > 0
      and t.traded_at >= now() - interval '180 days';
    if v_market_n >= 5 then
      select percentile_cont(0.5) within group(order by abs(ln(greatest(t.usd_amount,1)) - v_median))
        into v_mad
      from public.trades t
      where t.market_id = a.market_id and t.usd_amount > 0
        and t.traded_at >= now() - interval '180 days';
      if coalesce(v_mad,0) > 0 then
        v_z := (ln(greatest(v_trade_total,1)) - v_median) / (1.4826 * v_mad);
        s_size := greatest(0,least(100,50 + 20*v_z));
        v_factors := v_factors || jsonb_build_array(jsonb_build_object(
          'code','relative_size','label','Taille relative','label_fr','Taille relative',
          'score',round(s_size,1),'weight',w_size,'points',round(s_size*w_size/100,1),
          'detail',format('Écart robuste à la médiane/MAD de %s transactions du même marché',v_market_n)));
        v_score := v_score + s_size*w_size; v_coverage := v_coverage + w_size;
      else
        v_missing := v_missing || jsonb_build_array('dispersion de taille insuffisante (MAD nul)');
      end if;
    else
      v_missing := v_missing || jsonb_build_array('baseline de taille par marché (moins de 5 transactions)');
    end if;

    -- Conviction proxy: share of current book liquidity; cumulative volume share is disclosed, not treated as 24h volume.
    if coalesce(m.liquidity,0) > 0 then
      v_liquidity_share := v_trade_total / m.liquidity;
      v_volume_share := case when coalesce(m.volume,0)>0 then v_trade_total/m.volume else null end;
      s_conviction := greatest(0,least(100,50 + 20*log(10,greatest(v_liquidity_share,0.000001)/0.01)));
      v_detail := format('Mise = %s%% de la liquidité courante%s',round(v_liquidity_share*100,3),
        case when v_volume_share is null then '' else format(' · %s%% du volume cumulé (pas 24 h)',round(v_volume_share*100,4)) end);
      v_factors := v_factors || jsonb_build_array(jsonb_build_object(
        'code','conviction','label','Conviction financière','label_fr','Conviction financière',
        'score',round(s_conviction,1),'weight',w_conviction,'points',round(s_conviction*w_conviction/100,1),'detail',v_detail));
      v_score := v_score + s_conviction*w_conviction; v_coverage := v_coverage + w_conviction;
    else
      v_missing := v_missing || jsonb_build_array('liquidité du marché');
    end if;

    -- Wallet profile proxy: verified age, average observed ticket and observed market breadth.
    select count(*)::integer, coalesce(sum(t.usd_amount),0), count(distinct t.market_id)::integer, min(t.traded_at)::date
      into v_wallet_raw_count, v_wallet_raw_sum, v_wallet_markets, v_wallet_first_raw
    from public.trades t where lower(t.wallet)=lower(a.wallet);
    select coalesce(sum(x.trade_count),0), coalesce(sum(x.total_usd),0)
      into v_archive_count, v_archive_sum
    from public.trade_archive_daily x
    where lower(x.wallet)=lower(a.wallet)
      and (v_wallet_first_raw is null or x.trade_date < v_wallet_first_raw);
    v_wallet_avg := case when coalesce(v_wallet_raw_count,0)+coalesce(v_archive_count,0)>0
      then (coalesce(v_wallet_raw_sum,0)+coalesce(v_archive_sum,0))/(v_wallet_raw_count+v_archive_count) else null end;

    select case when w.created_at_verified is not null
      then greatest(0,extract(epoch from (now()-w.created_at_verified))/86400) end
      into v_age_days from public.wallets w where lower(w.address)=lower(a.wallet);
    v_wallet_parts := 0; s_wallet := 0;
    if v_age_days is not null then
      v_wallet_age_score := greatest(0,least(100,100*(1-v_age_days/365)));
      s_wallet := s_wallet + v_wallet_age_score; v_wallet_parts := v_wallet_parts + 1;
    end if;
    if v_wallet_avg is not null and v_wallet_avg > 0 then
      v_wallet_ticket_score := greatest(0,least(100,50 + 25*log(10,greatest(v_trade_total/v_wallet_avg,0.000001))));
      s_wallet := s_wallet + v_wallet_ticket_score; v_wallet_parts := v_wallet_parts + 1;
    end if;
    if coalesce(v_wallet_raw_count,0)+coalesce(v_archive_count,0) >= 5 then
      v_wallet_breadth_score := greatest(0,least(100,100*coalesce(v_wallet_markets,0)/10.0));
      s_wallet := s_wallet + v_wallet_breadth_score; v_wallet_parts := v_wallet_parts + 1;
    end if;
    if v_wallet_parts > 0 then
      s_wallet := s_wallet / v_wallet_parts;
      v_detail := format('Profil observable partiel · âge vérifié: %s jours · tickets observés: %s · marchés observés: %s',
        coalesce(round(v_age_days)::text,'indisponible'),coalesce(round(v_wallet_avg)::text,'indisponible'),coalesce(v_wallet_markets,0));
      v_factors := v_factors || jsonb_build_array(jsonb_build_object(
        'code','wallet_profile','label','Profil du portefeuille (proxy)','label_fr','Profil du portefeuille (proxy)',
        'score',round(s_wallet,1),'weight',round(w_wallet*v_wallet_parts/3.0),'points',round(s_wallet*w_wallet*v_wallet_parts/300.0,1),'detail',v_detail));
      v_score := v_score + s_wallet*w_wallet*v_wallet_parts/3.0;
      v_coverage := v_coverage + round(w_wallet*v_wallet_parts/3.0);
    else
      v_missing := v_missing || jsonb_build_array('profil historique du portefeuille');
    end if;
    v_missing := v_missing || jsonb_build_array('ROI et win rate fiables (historique de marchés résolus insuffisant)');

    -- Timing before resolution.
    if m.end_date is not null and v_first_trade is not null then
      v_days_to_resolution := extract(epoch from (m.end_date-v_first_trade))/86400;
      if v_days_to_resolution >= 0 then
        s_timing := greatest(0,least(100,100-abs(log(10,v_days_to_resolution+0.25)-0.7)*42));
      else
        s_timing := 0;
      end if;
      v_factors := v_factors || jsonb_build_array(jsonb_build_object(
        'code','timing','label','Timing','label_fr','Timing','score',round(s_timing,1),
        'weight',w_timing,'points',round(s_timing*w_timing/100,1),
        'detail',format('%s jours avant la résolution',round(v_days_to_resolution,1))));
      v_score := v_score + s_timing*w_timing; v_coverage := v_coverage + w_timing;
    else
      v_missing := v_missing || jsonb_build_array('date de résolution / timing');
    end if;

    -- Post-trade price impact, using the market outcome price series captured by the trigger.
    v_outcome_index := null; v_pre_price := null; v_post_price := null;
    if v_outcome is not null and m.outcomes is not null then
      select (e.ordinality-1)::integer into v_outcome_index
      from jsonb_array_elements_text(m.outcomes) with ordinality as e(value,ordinality)
      where lower(e.value)=lower(v_outcome) limit 1;
    end if;
    if v_outcome_index is not null and v_first_trade is not null and v_last_trade is not null then
      select (s.outcome_prices ->> v_outcome_index)::numeric into v_pre_price
      from public.market_price_snapshots s
      where s.market_id=a.market_id and s.captured_at <= v_first_trade
        and s.captured_at >= v_first_trade - interval '3 hours'
      order by s.captured_at desc limit 1;
      select (s.outcome_prices ->> v_outcome_index)::numeric into v_post_price
      from public.market_price_snapshots s
      where s.market_id=a.market_id and s.captured_at >= v_last_trade + interval '30 minutes'
        and s.captured_at <= v_last_trade + interval '4 hours'
      order by s.captured_at asc limit 1;
    end if;
    if v_pre_price is not null and v_post_price is not null then
      v_impact_change := case when v_side='SELL' then v_pre_price-v_post_price else v_post_price-v_pre_price end;
      s_impact := greatest(0,least(100,50+250*v_impact_change));
      v_factors := v_factors || jsonb_build_array(jsonb_build_object(
        'code','market_impact','label','Impact après transaction','label_fr','Impact après transaction',
        'score',round(s_impact,1),'weight',w_impact,'points',round(s_impact*w_impact/100,1),
        'detail',format('Variation directionnelle à ~1 h: %s points de probabilité',round(v_impact_change*100,2))));
      v_score := v_score + s_impact*w_impact; v_coverage := v_coverage + w_impact;
    else
      v_missing := v_missing || jsonb_build_array('impact post-trade (attente de snapshots avant et après)');
    end if;

    -- Same-outcome, same-side wallets within the coordination window.
    select count(*)::integer, count(distinct t.wallet)::integer
      into v_coord_rows, v_other_wallets
    from public.trades t
    where t.condition_id=a.condition_id
      and coalesce(t.outcome,'')=coalesce(v_outcome,'')
      and t.side=coalesce(v_side,'BUY')
      and lower(t.wallet)<>lower(a.wallet)
      and t.usd_amount >= 250
      and t.traded_at between coalesce(v_first_trade,a.first_trade_at)-interval '30 minutes'
                          and coalesce(v_last_trade,a.last_trade_at)+interval '30 minutes';
    if v_coord_rows > 0 then
      s_coordination := greatest(0,least(100,v_other_wallets*25));
      v_factors := v_factors || jsonb_build_array(jsonb_build_object(
        'code','coordination','label','Coordination multi-portefeuilles','label_fr','Coordination multi-portefeuilles',
        'score',round(s_coordination,1),'weight',w_coordination,'points',round(s_coordination*w_coordination/100,1),
        'detail',format('%s autres portefeuilles sur le même résultat/sens dans ±30 min',v_other_wallets)));
      v_score := v_score + s_coordination*w_coordination; v_coverage := v_coverage + w_coordination;
    else
      v_missing := v_missing || jsonb_build_array('coordination (pas de transaction comparable dans la fenêtre observée)');
    end if;

    v_score := case when v_coverage>0 then round(v_score/v_coverage) else 0 end;
    insert into public.alert_scores_v2(alert_id,score,coverage,regime,factors,missing_data,model_version,computed_at)
    values(a.id,greatest(0,least(100,v_score))::integer,v_coverage,v_regime,v_factors,v_missing,'v2.1.0',now())
    on conflict(alert_id) do update set score=excluded.score,coverage=excluded.coverage,regime=excluded.regime,
      factors=excluded.factors,missing_data=excluded.missing_data,model_version=excluded.model_version,computed_at=excluded.computed_at;
    v_done := v_done + 1;
  end loop;
  return v_done;
end;
$function$
;
revoke all on function public.refresh_alert_scores_v2() from public,anon,authenticated;
grant execute on function public.refresh_alert_scores_v2() to service_role;
revoke all on function public.capture_market_price_snapshot() from public,anon,authenticated;
grant execute on function public.capture_market_price_snapshot() to service_role;
