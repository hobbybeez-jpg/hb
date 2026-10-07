-- Renfrew Stock: rack display names, and numbered default boxes (N -> N-1, PP -> PP-1, ...).

create table if not exists trk.racks (
  rack text primary key,
  name text not null,
  sort integer not null default 0
);
alter table trk.racks enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on trk.racks from %I', r);
    end if;
  end loop;
end $$;

insert into trk.racks (rack, name, sort) values
  ('N', 'Nendoroid', 10), ('PP', 'POP UP PARADE', 20), ('PF', 'Prize Figure', 30),
  ('A', 'Action Figure', 40), ('B', 'Blind Box', 50), ('MH', 'MegaHouse', 60), ('PENDING', 'Pending', 1000)
on conflict (rack) do update set name = excluded.name, sort = excluded.sort;

-- Any other rack that already exists keeps its code as its name
insert into trk.racks (rack, name, sort)
select rack, rack, min(sort) from trk.renfrew_locations group by rack
on conflict (rack) do nothing;

-- Number the default boxes; stock in the old box moves to the new one
do $$
declare r text;
begin
  foreach r in array array['N', 'PP', 'PF', 'A', 'B', 'MH'] loop
    if exists (select 1 from trk.renfrew_locations where code = r and active) then
      insert into trk.renfrew_locations (code, rack, sort) values (r || '-1', r, 0)
      on conflict (code) do update set active = true, rack = excluded.rack;
      update trk.renfrew_stock set location_code = r || '-1', updated_at = now() where location_code = r;
      update trk.renfrew_locations set active = false where code = r;
    end if;
  end loop;
end $$;
