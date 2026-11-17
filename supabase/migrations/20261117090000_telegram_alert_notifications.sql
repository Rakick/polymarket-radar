create table if not exists public.telegram_connections (
  user_id uuid primary key references auth.users(id) on delete cascade,
  chat_id bigint not null unique,
  telegram_username text,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.telegram_link_codes (
  code_hash text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists telegram_link_codes_expiry_idx on public.telegram_link_codes(expires_at);
create table if not exists public.telegram_notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  alert_id uuid not null references public.alerts(id) on delete cascade,
  chat_id bigint not null,
  status text not null default 'pending' check (status in ('pending','sent')),
  attempts integer not null default 0,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(alert_id, chat_id)
);
alter table public.telegram_connections enable row level security;
alter table public.telegram_link_codes enable row level security;
alter table public.telegram_notification_deliveries enable row level security;
revoke all on public.telegram_connections, public.telegram_link_codes, public.telegram_notification_deliveries from public, anon, authenticated;
grant select, insert, update, delete on public.telegram_connections, public.telegram_link_codes, public.telegram_notification_deliveries to service_role;
