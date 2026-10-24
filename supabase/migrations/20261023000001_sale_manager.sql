-- 特價商品管理（Sale Manager）
-- 獨立的 schema `sale`；由 Edge Function `sale-manager` 透過資料庫連線存取，瀏覽器無法直接讀寫。
-- 需要 pgcrypto（Supabase 預設已安裝在 extensions schema）。

create schema if not exists sale;

-- 設定與密碼（bcrypt 雜湊）
--   pw_access    員工進入系統的共用密碼（未設定＝不需要）
--   pw_manager   主管：套用特價、取消、提前結束、修改結束日期、變更密碼
--   cron_secret  排程（pg_cron）呼叫 Edge Function 用的密鑰（自動產生）
--   last_tick    排程最後一次執行的時間
create table if not exists sale.settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
insert into sale.settings (key, value) values ('cron_secret', encode(extensions.gen_random_bytes(24), 'hex'))
on conflict (key) do nothing;

-- 掃描：Shopify bulk operation（先讀商品，再讀過去 2 年的訂單）
create table if not exists sale.scans (
  id bigserial primary key,
  status text not null,                 -- PRODUCTS, READ_PRODUCTS, ORDERS, READ_ORDERS, DONE, ERROR, CANCELED
  since date not null,                  -- 這天（含）之後的訂單算有銷售
  products_op text,                     -- gid://shopify/BulkOperation/...
  orders_op text,
  attempt_at timestamptz,               -- 讀取結果檔時佔住這筆（5 分鐘）
  candidates jsonb,                     -- 讀完商品後：有庫存、沒有 sale/20off/40off tag 的商品
  results jsonb,                        -- 完成後：符合三個條件的商品
  stats jsonb,
  error text,
  started_by text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

-- 特價活動：開始日 00:00 到結束日 24:00（溫哥華時間）
create table if not exists sale.campaigns (
  id bigserial primary key,
  name text not null,
  start_date date not null,
  end_date date not null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  scan_id bigint,
  created_by text,
  created_at timestamptz not null default now(),
  canceled_at timestamptz,
  canceled_by text,
  ended_early_by text                   -- 「End now」提前結束的人
);

-- 活動中的每個商品
create table if not exists sale.items (
  id bigserial primary key,
  campaign_id bigint not null references sale.campaigns (id),
  product_id text not null,             -- gid://shopify/Product/...
  title text,
  handle text,
  vendor text,
  snapshot jsonb,                       -- 掃描時的款式資料（還沒套用前顯示、匯出用）
  changes jsonb,                        -- 套用時：[{ id, title, sku, barcode, origPrice, origCompareAt, salePrice }]
  status text not null default 'PENDING', -- PENDING, ON_SALE, ENDED, SKIPPED, CANCELED
  note text,
  error text,
  attempts integer not null default 0,
  attempt_at timestamptz,               -- 呼叫 Shopify 時佔住這筆（3 分鐘）
  applied_at timestamptz,
  ended_at timestamptz
);
create index if not exists sale_items_campaign_idx on sale.items (campaign_id, id);
-- 同一個商品同時只能在一個活動裡（還沒開始或特價中）
create unique index if not exists sale_items_open_product_idx on sale.items (product_id) where status in ('PENDING', 'ON_SALE');

-- 活動紀錄
create table if not exists sale.events (
  id bigserial primary key,
  campaign_id bigint,
  action text not null,
  by_name text,
  note text,
  at timestamptz not null default now()
);
create index if not exists sale_events_campaign_idx on sale.events (campaign_id, at);

-- 密碼輸錯紀錄（保留 1 天）
create table if not exists sale.auth_failures (
  id bigserial primary key,
  client text not null,
  key text not null,
  at timestamptz not null default now()
);
create index if not exists sale_auth_failures_idx on sale.auth_failures (key, at);

-- 排程用：有沒有該做的事（避免每 10 分鐘白白呼叫 Edge Function）
create or replace function sale.due_work() returns boolean
language sql stable as $$
  select exists (
    select 1 from sale.items i join sale.campaigns c on c.id = i.campaign_id
    where (i.status = 'PENDING' and c.canceled_at is null and c.start_at <= now() and (i.attempts < 5 or c.end_at <= now()))
       or (i.status = 'ON_SALE' and c.end_at <= now() and i.attempts < 5)
  ) or exists (select 1 from sale.scans where status in ('PRODUCTS', 'READ_PRODUCTS', 'ORDERS', 'READ_ORDERS'))
$$;

-- 只有 Edge Function（資料庫連線）可以存取 sale
alter table sale.settings enable row level security;
alter table sale.scans enable row level security;
alter table sale.campaigns enable row level security;
alter table sale.items enable row level security;
alter table sale.events enable row level security;
alter table sale.auth_failures enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on schema sale from %I', r);
      execute format('revoke all on all tables in schema sale from %I', r);
      execute format('revoke all on all sequences in schema sale from %I', r);
      execute format('revoke all on all functions in schema sale from %I', r);
      execute format('alter default privileges in schema sale revoke all on tables from %I', r);
    end if;
  end loop;
end $$;
