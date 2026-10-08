-- Renfrew Stock: the Main Rack's box is MAIN-0 (was MAIN-1). Stock and history move with it.
-- MAIN-0 is the default put-away box (lowest-numbered box of the Main Rack).

insert into trk.renfrew_locations (code, rack, sort) values ('MAIN-0', 'MAIN', 0)
on conflict (code) do update set active = true, rack = excluded.rack;

update trk.renfrew_stock set location_code = 'MAIN-0', updated_at = now() where location_code = 'MAIN-1';
update trk.renfrew_moves set from_code = 'MAIN-0' where from_code = 'MAIN-1';
update trk.renfrew_moves set to_code = 'MAIN-0' where to_code = 'MAIN-1';
update trk.renfrew_locations set active = false where code = 'MAIN-1';
