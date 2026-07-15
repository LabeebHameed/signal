-- Schedule the poll-pages Edge Function every 15 minutes via pg_cron + pg_net.
--
-- The admin token comes from settings.admin_token (single source of truth,
-- managed in the app). The function URL is project-specific and is stored once
-- in Supabase Vault:
--
--   select vault.create_secret('https://<project-ref>.supabase.co/functions/v1/poll-pages', 'poll_function_url');

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'poll-watched-pages',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'poll_function_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-admin-token', (select admin_token from public.settings where id = 1)
    ),
    body := '{"background": true}'::jsonb,
    timeout_milliseconds := 15000
  );
  $$
);
