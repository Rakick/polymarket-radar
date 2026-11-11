select cron.unschedule('polymarket-radar-hourly');
select cron.schedule(
  'polymarket-radar-hourly',
  '* * * * *',
  $job$
    select net.http_post(
      url := 'https://ugozjtjjsbkqdxmebbhk.supabase.co/functions/v1/polymarket-hourly-scan',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'polymarket_scan_cron_secret'
          limit 1
        )
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 120000
    );
  $job$
);