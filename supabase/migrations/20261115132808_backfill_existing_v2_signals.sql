
with ordered as (
  select t.*,lag(t.traded_at) over(partition by lower(t.wallet),t.condition_id,t.side,coalesce(t.outcome,'') order by t.traded_at) as previous_at
  from public.trades t where t.usd_amount>0
), marked as (
  select *,case when previous_at is null or traded_at-previous_at>interval '30 minutes' then 1 else 0 end as starts_group
  from ordered
), grouped_rows as (
  select *,sum(starts_group) over(partition by lower(wallet),condition_id,side,coalesce(outcome,'') order by traded_at rows unbounded preceding) as group_number
  from marked
), grouped as (
  select lower(wallet) as wallet,min(market_id) as market_id,condition_id,side,outcome,
    array_agg(trade_id order by traded_at) as trade_ids,sum(usd_amount) as total_usd,
    min(price) as price_min,sum(price*usd_amount)/nullif(sum(usd_amount),0) as price_avg,
    min(traded_at) as first_trade_at,max(traded_at) as last_trade_at
  from grouped_rows group by lower(wallet),condition_id,side,outcome,group_number
  having sum(usd_amount)>=500
)
insert into public.scoring_v2_signals(dedupe_key,wallet,market_id,condition_id,side,outcome,trade_ids,total_usd,price_min,price_avg,first_trade_at,last_trade_at,updated_at)
select g.wallet||'|'||g.condition_id||'|'||g.side||'|'||coalesce(g.outcome,'unknown')||'|'||floor(extract(epoch from g.first_trade_at)/1800)::bigint,
  g.wallet,g.market_id,g.condition_id,g.side,g.outcome,g.trade_ids,round(g.total_usd,2),g.price_min,g.price_avg,g.first_trade_at,g.last_trade_at,now()
from grouped g
on conflict(dedupe_key) do update set trade_ids=excluded.trade_ids,total_usd=excluded.total_usd,price_min=excluded.price_min,
  price_avg=excluded.price_avg,first_trade_at=excluded.first_trade_at,last_trade_at=excluded.last_trade_at,updated_at=now();
select public.refresh_scoring_v2_signals();
