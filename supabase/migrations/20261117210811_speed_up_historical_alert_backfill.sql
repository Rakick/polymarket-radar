select cron.alter_job(
  job_id := (
    select jobid
    from cron.job
    where jobname = 'polymarket-historical-backfill'
  ),
  schedule := '* * * * *'
);
