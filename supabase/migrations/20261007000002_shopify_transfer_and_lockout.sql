-- Receiving Tracker: Shopify transfer (Marine Drive -> Renfrew) per shipment, and wrong-password lockout.

-- One Shopify transfer per tracked shipment (created after step 4a, received from step 5)
create table if not exists trk.shopify_transfers (
  shipment_id text primary key,
  status text not null,                 -- PENDING, CREATING, ERROR, CREATED, RECEIVING, RECEIVE_ERROR, RECEIVED, UNLINKED
  generation integer not null default 1, -- +1 each time an unlinked transfer is created again (new idempotency keys)
  transfer_id text,                     -- gid://shopify/InventoryTransfer/...
  transfer_name text,                   -- e.g. #T0012
  shipment_gid text,                    -- gid://shopify/InventoryShipment/... (in transit)
  lines jsonb,                          -- [{ inventoryItemId, upcs: [...], productName, qty }]
  total_qty integer,
  received_qty integer,
  error text,
  attempt_at timestamptz,               -- when a Shopify call was started (claims the row for 5 minutes)
  created_by text, created_at timestamptz,
  received_by text, received_at timestamptz,
  updated_at timestamptz not null default now()
);

-- Wrong passwords (kept 1 day), used to lock a password after repeated failures
create table if not exists trk.auth_failures (
  id bigserial primary key,
  client text not null,
  key text not null,
  at timestamptz not null default now()
);
create index if not exists trk_auth_failures_idx on trk.auth_failures (key, at);

-- Only the Edge Function (database connection) can access trk
alter table trk.shopify_transfers enable row level security;
alter table trk.auth_failures enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on trk.shopify_transfers from %I', r);
      execute format('revoke all on trk.auth_failures from %I', r);
      execute format('revoke all on sequence trk.auth_failures_id_seq from %I', r);
    end if;
  end loop;
end $$;
