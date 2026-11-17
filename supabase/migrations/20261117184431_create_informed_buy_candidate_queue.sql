create table if not exists public.informed_buy_candidate_queue (
  id uuid primary key default gen_random_uuid(),
  dedupe_key text not null unique,
  candidate jsonb not null,
  status text not null default 'pending' check (status in ('pending','done')),
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists informed_buy_candidate_queue_pending_idx
  on public.informed_buy_candidate_queue(status, created_at)
  where status = 'pending';
alter table public.informed_buy_candidate_queue enable row level security;
revoke all on table public.informed_buy_candidate_queue from public, anon, authenticated;
grant select, insert, update, delete on table public.informed_buy_candidate_queue to service_role;
