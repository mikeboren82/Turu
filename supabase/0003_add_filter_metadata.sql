-- WABBIT - הוספת שדות מטא-דאטה לפילטרים המתקדמים
-- אין כפילות עם שדות קיימים (min_age/max_age/price_*/location_id כבר קיימים)

alter table public.activities
  add column category text,
  add column duration_minutes numeric,
  add column indoor_outdoor text check (indoor_outdoor in ('indoor', 'outdoor', 'both')),
  add column booking_requirement text check (
    booking_requirement in ('none', 'walk_in', 'registration_required', 'advance_booking', 'available_now')
  ),
  add column rating numeric check (rating >= 0 and rating <= 5),
  add column weather_suitable text[] not null default '{}',
  add column amenities text[] not null default '{}',
  add column family_fit text[] not null default '{}';

create index idx_activities_category on public.activities(category);

alter table public.locations
  add column city text;

create index idx_locations_city on public.locations(city);
