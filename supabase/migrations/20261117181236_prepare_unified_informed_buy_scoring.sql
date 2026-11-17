-- This migration was applied to the production database before its SQL file
-- was synchronized into version control. Keep it idempotent for new environments.
alter table public.alerts
  add column if not exists price_avg numeric,
  add column if not exists coverage integer not null default 0,
  add column if not exists model_version text,
  add column if not exists conditions jsonb not null default '{}'::jsonb,
  add column if not exists scored_at timestamptz,
  add column if not exists source_system text not null default 'legacy_v1';

create index if not exists alerts_model_score_idx
  on public.alerts(model_version, score desc, first_trade_at desc);
create index if not exists alerts_wallet_market_time_idx
  on public.alerts(wallet, condition_id, first_trade_at desc);

-- Merge BUY signal evidence into the canonical alert row where trades overlap.
with merged as (
  select
    a.id,
    array_agg(distinct trade_id order by trade_id) as trade_ids,
    max(s.total_usd) as total_usd,
    min(s.price_min) as price_min,
    (array_agg(s.price_avg order by s.updated_at desc))[1] as price_avg,
    min(s.first_trade_at) as first_trade_at,
    max(s.last_trade_at) as last_trade_at
  from public.alerts a
  join public.scoring_v2_signals s
    on s.side = 'BUY' and a.trade_ids && s.trade_ids
  cross join lateral unnest(a.trade_ids || s.trade_ids) as tid(trade_id)
  group by a.id
)
update public.alerts a
set
  trade_ids = m.trade_ids,
  total_usd = greatest(a.total_usd, m.total_usd),
  price_min = case
    when a.price_min is null then m.price_min
    when m.price_min is null then a.price_min
    else least(a.price_min, m.price_min)
  end,
  price_avg = coalesce(a.price_avg, m.price_avg),
  first_trade_at = case
    when a.first_trade_at is null then m.first_trade_at
    when m.first_trade_at is null then a.first_trade_at
    else least(a.first_trade_at, m.first_trade_at)
  end,
  last_trade_at = case
    when a.last_trade_at is null then m.last_trade_at
    when m.last_trade_at is null then a.last_trade_at
    else greatest(a.last_trade_at, m.last_trade_at)
  end,
  source_system = 'legacy_v1+v2_merged',
  updated_at = now()
from merged m
where a.id = m.id;

-- Import BUY-only signals which have no canonical alert counterpart.
insert into public.alerts (
  dedupe_key, wallet, market_id, condition_id, alert_type,
  score, confidence, factors, missing_data, trade_ids, total_usd,
  price_min, price_avg, outcome, first_trade_at, last_trade_at,
  coverage, model_version, conditions, scored_at, source_system
)
select
  s.dedupe_key, s.wallet, s.market_id, s.condition_id,
  case when cardinality(s.trade_ids) > 1 then 'grouped' else 'single' end,
  0, 'low', '[]'::jsonb, '[]'::jsonb, s.trade_ids, s.total_usd,
  s.price_min, s.price_avg, s.outcome, s.first_trade_at, s.last_trade_at,
  0, null, '{}'::jsonb, null, 'legacy_v2_only'
from public.scoring_v2_signals s
where s.side = 'BUY'
  and not exists (
    select 1 from public.alerts a
    where a.dedupe_key = s.dedupe_key or a.trade_ids && s.trade_ids
  )
on conflict (dedupe_key) do nothing;
