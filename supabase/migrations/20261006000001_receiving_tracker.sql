-- 進貨進度追蹤（Receiving Tracker）
-- 獨立的 schema `trk`；只「讀取」庫存系統的 wh.*，從不寫入 wh。
-- 由 Edge Function `receiving-tracker` 透過資料庫連線存取，瀏覽器無法直接讀寫。
-- 需要 pgcrypto（Supabase 預設已安裝在 extensions schema）。

create schema if not exists trk;

-- 設定：go_live（開始追蹤的時間）與各種密碼（bcrypt 雜湊）
--   pw_access  員工進入系統的共用密碼（未設定＝不需要）
--   pw_step3   主管1：確認入庫存
--   pw_step4a  主管2：上架系統
--   pw_admin   撤銷步驟、管理 Renfrew 貨架格位（未設定時可用 pw_step3 / pw_step4a）
create table if not exists trk.settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

-- 每張被追蹤的點貨單（shipment_id 對應 wh.shipments.shipment_id）
create table if not exists trk.shipments (
  shipment_id text primary key,
  supplier text,
  name text,
  created_at timestamptz,
  added_at timestamptz not null default now(),
  s2_at timestamptz, s2_by text,           -- 倉庫：數量已確認
  s3_at timestamptz, s3_by text,           -- 主管1：確認入庫存
  s4a_at timestamptz, s4a_by text,         -- 主管2：上架系統
  s4b_at timestamptz, s4b_by text, s4b_note text,  -- Renfrew：清點無誤
  s5_at timestamptz, s5_by text, s5_note text      -- Renfrew：上架店內（完成後隱藏）
);
create index if not exists trk_shipments_open_idx on trk.shipments (s5_at, created_at desc);

-- 步驟紀錄（完成 / 撤銷）
create table if not exists trk.events (
  id bigserial primary key,
  shipment_id text not null,
  step text not null,
  action text not null,
  by_name text,
  note text,
  at timestamptz not null default now()
);
create index if not exists trk_events_shipment_idx on trk.events (shipment_id, at);

-- 步驟 4b 的清點結果（每一行 Renfrew 商品）
create table if not exists trk.renfrew_checks (
  shipment_id text not null,
  line_id text not null,
  upc text,
  product_name text,
  expected_qty integer not null default 0,
  counted_qty integer not null default 0,
  put_qty integer not null default 0,      -- 已歸架數量
  primary key (shipment_id, line_id)
);
create index if not exists trk_renfrew_checks_upc_idx on trk.renfrew_checks (upc);

-- Renfrew 倉庫貨架格位
create table if not exists trk.renfrew_locations (
  code text primary key,
  rack text not null,
  sort integer not null default 0,
  active boolean not null default true,
  note text
);

-- Renfrew 倉庫庫存（shipment_id = '' 表示手動加入、不屬於任何進貨表）
create table if not exists trk.renfrew_stock (
  id bigserial primary key,
  location_code text not null references trk.renfrew_locations(code),
  upc text not null,
  product_name text,
  shipment_id text not null default '',
  qty integer not null check (qty > 0),
  updated_at timestamptz not null default now(),
  unique (location_code, upc, shipment_id)
);
create index if not exists trk_renfrew_stock_upc_idx on trk.renfrew_stock (upc);
create index if not exists trk_renfrew_stock_shipment_idx on trk.renfrew_stock (shipment_id);

-- Renfrew 異動紀錄
create table if not exists trk.renfrew_moves (
  id bigserial primary key,
  upc text not null,
  product_name text,
  shipment_id text not null default '',
  from_code text,
  to_code text,
  qty integer not null,
  reason text not null,
  by_name text,
  at timestamptz not null default now()
);
create index if not exists trk_renfrew_moves_at_idx on trk.renfrew_moves (at desc);
create index if not exists trk_renfrew_moves_upc_idx on trk.renfrew_moves (upc);

-- 預設貨架：N、PP、PF、A、B、MH、PENDING（之後可在畫面上新增格位，例如 N-1、N-2）
insert into trk.renfrew_locations (code, rack, sort) values
  ('N', 'N', 10), ('PP', 'PP', 20), ('PF', 'PF', 30), ('A', 'A', 40),
  ('B', 'B', 50), ('MH', 'MH', 60), ('PENDING', 'PENDING', 90)
on conflict (code) do nothing;

-- 開始追蹤的時間：此後在庫存系統建立的點貨單都會自動出現
insert into trk.settings (key, value) values ('go_live', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
on conflict (key) do nothing;

-- 上線時尚未 Finalize 的點貨單也一併追蹤（步驟 1 已完成）
do $$
begin
  if to_regclass('wh.shipments') is not null then
    insert into trk.shipments (shipment_id, supplier, name, created_at)
    select shipment_id, supplier, name, created_at from wh.shipments
    where coalesce(status, '') <> 'FINALIZED'
    on conflict (shipment_id) do nothing;
  end if;
end $$;

-- 只有 Edge Function（資料庫連線）可以存取 trk
alter table trk.settings enable row level security;
alter table trk.shipments enable row level security;
alter table trk.events enable row level security;
alter table trk.renfrew_checks enable row level security;
alter table trk.renfrew_locations enable row level security;
alter table trk.renfrew_stock enable row level security;
alter table trk.renfrew_moves enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on schema trk from %I', r);
      execute format('revoke all on all tables in schema trk from %I', r);
      execute format('revoke all on all sequences in schema trk from %I', r);
      execute format('alter default privileges in schema trk revoke all on tables from %I', r);
    end if;
  end loop;
end $$;
