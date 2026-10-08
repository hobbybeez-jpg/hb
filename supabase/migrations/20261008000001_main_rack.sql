-- Renfrew Stock: Main Rack (MAIN), listed first. Its first box is the default put-away box
-- for items that have no box yet.

insert into trk.racks (rack, name, sort) values ('MAIN', 'Main Rack', 0)
on conflict (rack) do update set name = excluded.name, sort = excluded.sort;

insert into trk.renfrew_locations (code, rack, sort) values ('MAIN-1', 'MAIN', 0)
on conflict (code) do update set active = true, rack = excluded.rack;
