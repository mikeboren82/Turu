-- TuRu - data fix: Google formatted_address parsing ("רחוב, 3090000 זכרון יעקב, ישראל") leaked
-- postal codes into locations.city (audit 2026-09-13: 11 rows whose city is all digits, e.g.
-- '3090000', '2198305'). Null them out so the existing enrich-playground-addresses.js pass
-- (reverse-geocode from the coordinates these rows all have) fills the real city. The parser
-- itself is fixed in _shared/placesDiscovery.ts extractCityFromAddress in the same change.
update public.locations set city = null where city ~ '^[0-9]+$';
