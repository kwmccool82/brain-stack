-- ============================================================
-- 003_telegram_helper.sql
-- Sends Telegram messages via pg_net HTTP POST
-- Used by remote Life Engine triggers that don't have a local Telegram plugin
--
-- SETUP: Before running this migration, replace the placeholder values below
-- with your actual Telegram bot token and chat ID.
-- ============================================================

create extension if not exists pg_net;

create or replace function send_telegram_message(
  msg text,
  parse_mode text default null
)
returns bigint
language plpgsql
as $$
declare
  -- REPLACE THESE with your own values:
  bot_token text := 'YOUR_TELEGRAM_BOT_TOKEN';
  chat_id text := 'YOUR_TELEGRAM_CHAT_ID';
  request_id bigint;
  body_json jsonb;
begin
  body_json := json_build_object(
    'chat_id', chat_id,
    'text', msg
  )::jsonb;

  -- Only include parse_mode if explicitly set to a valid Telegram value
  if parse_mode is not null and parse_mode in ('HTML', 'MarkdownV2', 'Markdown') then
    body_json := body_json || json_build_object('parse_mode', parse_mode)::jsonb;
  end if;

  select net.http_post(
    url := 'https://api.telegram.org/bot' || bot_token || '/sendMessage',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := body_json
  ) into request_id;

  return request_id;
end;
$$;

-- Log migration
insert into schema_log (migration_name, description, sql_executed, executed_by)
values (
  '003_telegram_helper',
  'Create send_telegram_message() function for remote Life Engine triggers via pg_net.',
  '003_telegram_helper.sql',
  'claude'
);
