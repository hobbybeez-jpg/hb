-- Renfrew Stock: Tool rack (TOOL), after MegaHouse and before Pending, with its first box TOOL-1

insert into trk.racks (rack, name, sort) values ('TOOL', 'Tool', 70)
on conflict (rack) do update set name = excluded.name, sort = excluded.sort;

insert into trk.renfrew_locations (code, rack, sort) values ('TOOL-1', 'TOOL', 70)
on conflict (code) do update set active = true, rack = excluded.rack;
