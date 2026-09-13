-- TuRu - canonical VENUES (WHERE an activity physically happens). Sits *above* public.locations:
-- locations stays the per-activity address row the app joins for lat/lng/address (untouched),
-- venues is the persistent place entity that many activities/sources can point at over time
-- ("מרכז רוטשטיין" / "רוטשטיינס צורן" / "רוטשטיין רמת אמיר" = one venue via venue_aliases).
--
-- Deliberate scope (documented decision, 2026-09-13): venues are PHYSICAL PLACES ONLY. Publishers/
-- owners of a source (municipality, council, mall chain, organizer, aggregator) are NOT venues -
-- they live as publisher_name/publisher_type on public.sources (0077). A municipality calendar has
-- sources.venue_id = null and each extracted event resolves its own venue (park/library/square).
-- Playgrounds (category 'גן שעשועים') keep venue_id = null - a playground *is* the place.
--
-- Additive only: no existing table/column changes except two nullable FKs. RLS follows the project
-- pattern (is_admin() or is_trusted_uploader() for writes; public read like locations, so the app
-- could show venue info later without another migration).
create table if not exists public.venues (
  id uuid primary key default gen_random_uuid(),
  name_he text not null,
  venue_type text not null default 'other' check (venue_type in (
    'mall', 'shopping_center', 'museum', 'library', 'community_center', 'theater', 'cultural_center',
    'park', 'farm', 'petting_zoo', 'visitor_center', 'nature_site', 'workshop_studio', 'sports_center',
    'attraction', 'public_square', 'other'
  )),
  city text,
  neighborhood text,
  address text,
  lat double precision,
  lng double precision,
  region text check (region in (
    'גוש דן והמרכז', 'השרון', 'ירושלים והסביבה', 'חיפה והקריות', 'הצפון והעמק', 'השפלה והדרום', 'יו"ש והבנימין'
  )),
  chain text,
  website_url text,
  events_url text,
  facebook_url text,
  instagram_url text,
  google_place_id text,
  is_active boolean not null default true,
  -- venue merge never deletes: the loser row stays, points at the keeper, and is_active=false.
  merged_into uuid references public.venues(id) on delete set null,
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_venues_city on public.venues(city);
create index if not exists idx_venues_google_place_id on public.venues(google_place_id) where google_place_id is not null;

-- alias_normalized is computed by the app-side normalizer (supabase/functions/_shared/venues.ts,
-- mirrored in tools/import-tool/venueNaming.js - same intentional two-runtime copy pattern as
-- cityNaming/playgroundNaming). Lookups always go through alias_normalized + city.
create table if not exists public.venue_aliases (
  alias text not null,
  alias_normalized text not null,
  venue_id uuid not null references public.venues(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (alias_normalized, venue_id)
);
create index if not exists idx_venue_aliases_norm on public.venue_aliases(alias_normalized);

alter table public.activities add column if not exists venue_id uuid references public.venues(id) on delete set null;
alter table public.locations add column if not exists venue_id uuid references public.venues(id) on delete set null;
create index if not exists idx_activities_venue on public.activities(venue_id) where venue_id is not null;

alter table public.venues enable row level security;
create policy "venues_read" on public.venues for select using (true);
create policy "venues_write" on public.venues for all
  using (public.is_admin() or public.is_trusted_uploader())
  with check (public.is_admin() or public.is_trusted_uploader());

alter table public.venue_aliases enable row level security;
create policy "venue_aliases_read" on public.venue_aliases for select using (true);
create policy "venue_aliases_write" on public.venue_aliases for all
  using (public.is_admin() or public.is_trusted_uploader())
  with check (public.is_admin() or public.is_trusted_uploader());
