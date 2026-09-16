-- TuRu - adds 'escape_room' as a first-class venues.venue_type (2026-09-16), alongside the new
-- app/MONSTER category "חדרי בריחה". Additive only: drops and recreates the existing CHECK
-- constraint with the SAME full list of previously-valid values plus one new one - verified live
-- against the current constraint definition (venues_venue_type_check) before writing this, not
-- copied blindly from the original 0076_venues.sql migration.
alter table public.venues drop constraint if exists venues_venue_type_check;
alter table public.venues add constraint venues_venue_type_check check (venue_type in (
  'mall', 'shopping_center', 'museum', 'library', 'community_center', 'theater', 'cultural_center',
  'park', 'farm', 'petting_zoo', 'visitor_center', 'nature_site', 'workshop_studio', 'sports_center',
  'attraction', 'public_square', 'escape_room', 'other'
));
