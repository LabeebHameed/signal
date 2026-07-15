-- Schedule the poll-pages Edge Function every 15 minutes via pg_cron + pg_net.
--
-- The function URL and admin token are read from Supabase Vault so this
-- migration contains no project-specific values. Before (or after) applying,
-- create the two secrets once per project:
--
--   select vault.create_secret('https://<project-ref>.supabase.co/functions/v1/poll-pages', 'poll_function_url');
--   select vault.create_secret('<ADMIN_TOKEN value>', 'admin_token');

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
      'x-admin-token', (select decrypted_secret from vault.decrypted_secrets where name = 'admin_token')
    ),
    body := '{"background": true}'::jsonb,
    timeout_milliseconds := 15000
  );
  $$
);
