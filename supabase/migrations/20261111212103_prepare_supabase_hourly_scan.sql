create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

alter table public.scans drop constraint if exists scans_status_check;
alter table public.scans
  add constraint scans_status_check
  check (status = any (array['running'::text, 'success'::text, 'partial'::text, 'failed'::text]));

create or replace function public.validate_scan_cron_secret(candidate text)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select coalesce(
    candidate is not null
    and length(candidate) >= 32
    and exists (
      select 1
      from vault.decrypted_secrets
      where name = 'polymarket_scan_cron_secret'
        and decrypted_secret = candidate
    ),
    false
  );
$$;

revoke all on function public.validate_scan_cron_secret(text) from public, anon, authenticated;
grant execute on function public.validate_scan_cron_secret(text) to service_role;

do $$
begin
  if not exists (
    select 1 from vault.secrets where name = 'polymarket_scan_cron_secret'
  ) then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'polymarket_scan_cron_secret',
      'Private authentication token for the Polymarket Radar hourly scan Edge Function'
    );
  end if;
end;
$$;