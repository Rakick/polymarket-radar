alter table public.alerts
  add column if not exists scoring_attempts integer not null default 0,
  add column if not exists score_last_attempt_at timestamptz,
  add column if not exists score_retry_after timestamptz,
  add column if not exists score_last_error text;

alter table public.informed_buy_candidate_queue
  add column if not exists next_attempt_at timestamptz not null default now();

create index if not exists alerts_pending_retry_idx
  on public.alerts(score_retry_after, first_trade_at)
  where model_version is null;
create index if not exists informed_buy_candidate_queue_ready_idx
  on public.informed_buy_candidate_queue(status, next_attempt_at, created_at)
  where status = 'pending';
