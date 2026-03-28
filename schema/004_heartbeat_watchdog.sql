-- ============================================================
-- 004_heartbeat_watchdog.sql
-- Life Engine liveness monitoring
-- Detects when the Life Engine stops running and alerts via Telegram
--
-- SETUP: Replace bot_token and chat_id placeholders in check_life_engine_pulse()
-- ============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Heartbeat table (written by Life Engine on each run)
create table if not exists life_engine_heartbeats (
  id uuid primary key default gen_random_uuid(),
  session_id text not null,
  status text not null default 'alive',  -- alive, degraded, alert_sent
  time_window text,
  checks jsonb default '{}',
  created_at timestamptz default now()
);

create index idx_heartbeats_created_at on life_engine_heartbeats (created_at desc);

alter table life_engine_heartbeats enable row level security;
create policy "Service role full access" on life_engine_heartbeats
  for all using (auth.role() = 'service_role');

-- Staleness detector: runs every 5 min via pg_cron
-- Alerts if no heartbeat in 90 min during waking hours
create or replace function check_life_engine_pulse()
returns void
language plpgsql
as $$
declare
  last_beat timestamptz;
  gap_minutes int;
  current_hour int;
  alert_already_sent boolean;
  -- REPLACE THESE with your own values:
  bot_token text := 'YOUR_TELEGRAM_BOT_TOKEN';
  chat_id text := 'YOUR_TELEGRAM_CHAT_ID';
begin
  -- Only check during waking hours (adjust timezone to yours)
  current_hour := extract(hour from now() at time zone 'America/New_York');
  if current_hour < 7 or current_hour >= 23 then
    return;
  end if;

  select created_at into last_beat
  from life_engine_heartbeats
  order by created_at desc
  limit 1;

  if last_beat is null then
    gap_minutes := 999;
  else
    gap_minutes := extract(epoch from (now() - last_beat)) / 60;
  end if;

  if gap_minutes <= 90 then
    return;
  end if;

  select exists (
    select 1 from life_engine_heartbeats
    where status = 'alert_sent'
      and created_at > coalesce(last_beat, '2000-01-01'::timestamptz)
  ) into alert_already_sent;

  if alert_already_sent then
    return;
  end if;

  perform net.http_post(
    url := 'https://api.telegram.org/bot' || bot_token || '/sendMessage',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := json_build_object(
      'chat_id', chat_id,
      'text', 'Life Engine appears down. Last heartbeat: '
              || coalesce(last_beat::text, 'never')
              || ' (' || gap_minutes || ' min ago)'
    )::jsonb
  );

  insert into life_engine_heartbeats (session_id, status, time_window, checks)
  values ('watchdog', 'alert_sent', 'n/a', '{}'::jsonb);
end;
$$;

-- Schedule watchdog: every 5 min
select cron.schedule('life-engine-watchdog', '*/5 * * * *', $$SELECT check_life_engine_pulse()$$);

-- Schedule cleanup: keep 7 days of heartbeats
select cron.schedule('heartbeat-cleanup', '0 3 * * *',
  $$DELETE FROM life_engine_heartbeats WHERE created_at < now() - interval '7 days' AND status != 'alert_sent'$$);

-- Log migration
insert into schema_log (migration_name, description, sql_executed, executed_by)
values (
  '004_heartbeat_watchdog',
  'Heartbeat monitoring with pg_cron staleness detector and Telegram alerting.',
  '004_heartbeat_watchdog.sql',
  'claude'
);
