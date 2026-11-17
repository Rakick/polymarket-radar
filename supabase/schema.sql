create table if not exists public.app_settings(id int primary key default 1 check(id=1),data jsonb not null default '{}'::jsonb,updated_at timestamptz not null default now());
create table if not exists public.markets(id text primary key,condition_id text unique not null,slug text not null,question text not null,url text not null,category text,end_date timestamptz,liquidity numeric,volume numeric,closed boolean not null default false,accepting_orders boolean,outcomes jsonb,outcome_prices jsonb,updated_at timestamptz not null default now());
create table if not exists public.wallets(address text primary key,pseudonym text,first_seen_at timestamptz,first_platform_activity_at timestamptz,created_at_verified timestamptz,updated_at timestamptz not null default now());
create table if not exists public.trades(trade_id text primary key,transaction_hash text not null,wallet text not null,pseudonym text,market_id text not null,condition_id text not null,token_id text,side text not null,outcome text,price numeric not null,size numeric not null,usd_amount numeric not null,traded_at timestamptz not null,created_at timestamptz not null default now());
create table if not exists public.alerts(
 id uuid primary key default gen_random_uuid(),
 dedupe_key text unique not null,
 wallet text not null,
 market_id text not null,
 condition_id text not null,
 alert_type text not null,
 score int not null,
 confidence text not null check(confidence in ('high','medium','low')),
 factors jsonb not null default '[]',
 missing_data jsonb not null default '[]',
 trade_ids text[] not null default '{}',
 total_usd numeric not null default 0,
 price_min numeric,
 price_avg numeric,
 outcome text,
 first_trade_at timestamptz,
 last_trade_at timestamptz,
 coverage integer not null default 0 check(coverage between 0 and 100),
 model_version text,
 conditions jsonb not null default '{}'::jsonb,
 scored_at timestamptz,
 source_system text not null default 'legacy_v1',
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create index if not exists alerts_model_score_idx on public.alerts(model_version,score desc,first_trade_at desc);
create index if not exists alerts_wallet_market_time_idx on public.alerts(wallet,condition_id,first_trade_at desc);
create table if not exists public.informed_buy_candidate_queue(
 id uuid primary key default gen_random_uuid(),
 dedupe_key text unique not null,
 candidate jsonb not null,
 status text not null default 'pending' check(status in ('pending','done')),
 attempts integer not null default 0 check(attempts>=0),
 last_error text,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create index if not exists informed_buy_candidate_queue_pending_idx
 on public.informed_buy_candidate_queue(status,created_at) where status='pending';
alter table public.informed_buy_candidate_queue enable row level security;
revoke all on table public.informed_buy_candidate_queue from public,anon,authenticated;
grant select,insert,update,delete on table public.informed_buy_candidate_queue to service_role;
create table if not exists public.scans(id uuid primary key default gen_random_uuid(),started_at timestamptz not null default now(),finished_at timestamptz,status text,window_start bigint,window_end bigint,markets_scanned int not null default 0,trades_fetched int not null default 0,trades_new int not null default 0,alerts_created int not null default 0,errors jsonb not null default '[]',details jsonb);
create table if not exists public.checkpoints(key text primary key,value bigint not null,updated_at timestamptz not null default now());
