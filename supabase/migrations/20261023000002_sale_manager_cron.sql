-- 特價管理（Sale Manager）的排程：每 10 分鐘檢查一次，
-- 有該做的事（活動到開始／結束時間、掃描進行中）才呼叫 Edge Function `sale-manager` 的 tick。
-- tick 用 sale.settings 的 cron_secret 驗證；anon key 是公開金鑰（tracker.html 也有），只用來通過 Supabase 閘道。
-- 換了 Supabase 專案時，把下面的網址和 anon key 換成新專案的。

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'sale-manager-tick',
  '*/10 * * * *',
  $cron$
  select net.http_post(
    url := 'https://ibizemppcvlllhczjkgu.supabase.co/functions/v1/sale-manager',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImliaXplbXBwY3ZsbGxoY3pqa2d1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAzODE3NDEsImV4cCI6MjEwNTk1Nzc0MX0.dQsH967XdQ920DVzp2XB84S8JlhueWjNOgatC5OaOCI',
      'x-sale-cron', (select value from sale.settings where key = 'cron_secret')
    ),
    body := '{"fn":"tick"}'::jsonb,
    timeout_milliseconds := 150000
  )
  where sale.due_work()
  $cron$
);
