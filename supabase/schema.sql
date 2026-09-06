-- TuRu - schema ראשוני
-- להריץ פעם אחת ב-Supabase Dashboard -> SQL Editor -> Run

create extension if not exists pgcrypto;

-- ============ profiles (פרטי משתמש נוספים מעבר ל-auth.users) ============
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  nickname text not null,
  phone text,
  role text not null default 'user' check (role in ('user','admin')),
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, nickname)
  values (new.id, coalesce(new.raw_user_meta_data->>'nickname', split_part(new.email, '@', 1)));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.is_admin()
returns boolean language sql stable as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

-- ============ locations ============
create table public.locations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  address text,
  region text check (region in ('מרכז','השרון','צפון','דרום')),
  lat double precision,
  lng double precision,
  created_at timestamptz not null default now()
);

-- ============ activities ============
create table public.activities (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  entity_type text not null check (entity_type in ('מקום_קבוע','פעילות','אירוע_קבוע','אירוע')),
  location_id uuid references public.locations(id) on delete set null,
  min_age numeric,
  max_age numeric,
  price_type text check (price_type in ('free','fixed','range')),
  price_amount numeric,
  price_min numeric,
  price_max numeric,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  source text not null default 'manual' check (source in ('manual','user_submitted','scraped')),
  source_url text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index idx_activities_status on public.activities(status);
create index idx_activities_location on public.activities(location_id);

-- ============ activity_schedules ============
create table public.activity_schedules (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references public.activities(id) on delete cascade,
  schedule_type text not null check (schedule_type in ('recurring','one_time','fixed_hours')),
  day_of_week text check (day_of_week in ('ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת')),
  start_time time,
  end_time time,
  one_time_date date
);

create index idx_schedules_activity on public.activity_schedules(activity_id);

-- ============ activity_images ============
create table public.activity_images (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references public.activities(id) on delete cascade,
  url text not null,
  uploaded_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

-- ============ favorites / visited / hidden ============
create table public.favorites (
  user_id uuid not null references auth.users(id) on delete cascade,
  activity_id uuid not null references public.activities(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, activity_id)
);

create table public.visited_activities (
  user_id uuid not null references auth.users(id) on delete cascade,
  activity_id uuid not null references public.activities(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, activity_id)
);

create table public.hidden_activities (
  user_id uuid not null references auth.users(id) on delete cascade,
  activity_id uuid not null references public.activities(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, activity_id)
);

-- ============ notes ============
create table public.personal_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  activity_id uuid not null references public.activities(id) on delete cascade,
  note text not null,
  updated_at timestamptz not null default now(),
  unique (user_id, activity_id)
);

create table public.community_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  activity_id uuid not null references public.activities(id) on delete cascade,
  note text not null,
  created_at timestamptz not null default now()
);

create index idx_community_notes_activity on public.community_notes(activity_id);

-- ============ reports & blocks ============
create table public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references auth.users(id) on delete cascade,
  target_type text not null check (target_type in ('community_note','chat_message','user')),
  target_id uuid not null,
  reason text,
  status text not null default 'pending' check (status in ('pending','resolved')),
  created_at timestamptz not null default now()
);

create index idx_reports_status on public.reports(status);

create table public.blocks (
  user_id uuid primary key references auth.users(id) on delete cascade,
  blocked_by uuid references auth.users(id),
  reason text,
  created_at timestamptz not null default now()
);

-- ============ chat rooms & messages ============
create table public.chat_rooms (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  is_main boolean not null default false,
  created_by uuid references auth.users(id) on delete set null,
  last_message_at timestamptz not null default now(),
  closed_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.chat_rooms(id) on delete cascade,
  sender_id uuid references auth.users(id) on delete set null,
  guest_nickname text,
  content text not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index idx_chat_messages_room on public.chat_messages(room_id, created_at);

-- ============ friendships (future phase - schema only) ============
create table public.friendships (
  user_id uuid not null references auth.users(id) on delete cascade,
  friend_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','accepted')),
  share_location boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (user_id, friend_id)
);

-- ================================================================
-- Row Level Security
-- ================================================================

alter table public.profiles enable row level security;
create policy "profiles_read" on public.profiles for select using (id = auth.uid() or public.is_admin());
create policy "profiles_insert" on public.profiles for insert with check (id = auth.uid());
create policy "profiles_update" on public.profiles for update using (id = auth.uid() or public.is_admin());

alter table public.locations enable row level security;
create policy "locations_read" on public.locations for select using (true);
create policy "locations_insert" on public.locations for insert with check (auth.uid() is not null);
create policy "locations_update" on public.locations for update using (public.is_admin());
create policy "locations_delete" on public.locations for delete using (public.is_admin());

alter table public.activities enable row level security;
create policy "activities_read" on public.activities for select
  using (status = 'approved' or created_by = auth.uid() or public.is_admin());
create policy "activities_insert" on public.activities for insert
  with check (auth.uid() is not null and created_by = auth.uid());
create policy "activities_update" on public.activities for update
  using (created_by = auth.uid() or public.is_admin());
create policy "activities_delete" on public.activities for delete
  using (public.is_admin());

alter table public.activity_schedules enable row level security;
create policy "schedules_read" on public.activity_schedules for select using (
  exists (select 1 from public.activities a where a.id = activity_id
    and (a.status = 'approved' or a.created_by = auth.uid() or public.is_admin()))
);
create policy "schedules_write" on public.activity_schedules for insert with check (
  exists (select 1 from public.activities a where a.id = activity_id
    and (a.created_by = auth.uid() or public.is_admin()))
);
create policy "schedules_update" on public.activity_schedules for update using (
  exists (select 1 from public.activities a where a.id = activity_id
    and (a.created_by = auth.uid() or public.is_admin()))
);
create policy "schedules_delete" on public.activity_schedules for delete using (
  exists (select 1 from public.activities a where a.id = activity_id
    and (a.created_by = auth.uid() or public.is_admin()))
);

alter table public.activity_images enable row level security;
create policy "images_read" on public.activity_images for select using (
  exists (select 1 from public.activities a where a.id = activity_id
    and (a.status = 'approved' or a.created_by = auth.uid() or public.is_admin()))
);
create policy "images_insert" on public.activity_images for insert
  with check (auth.uid() is not null and uploaded_by = auth.uid());
create policy "images_delete" on public.activity_images for delete
  using (uploaded_by = auth.uid() or public.is_admin());

alter table public.favorites enable row level security;
create policy "favorites_own" on public.favorites for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

alter table public.visited_activities enable row level security;
create policy "visited_own" on public.visited_activities for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

alter table public.hidden_activities enable row level security;
create policy "hidden_own" on public.hidden_activities for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

alter table public.personal_notes enable row level security;
create policy "personal_notes_own" on public.personal_notes for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

alter table public.community_notes enable row level security;
create policy "community_notes_read" on public.community_notes for select using (true);
create policy "community_notes_insert" on public.community_notes for insert
  with check (user_id = auth.uid());
create policy "community_notes_update" on public.community_notes for update
  using (user_id = auth.uid() or public.is_admin());
create policy "community_notes_delete" on public.community_notes for delete
  using (user_id = auth.uid() or public.is_admin());

alter table public.reports enable row level security;
create policy "reports_insert" on public.reports for insert
  with check (reporter_id = auth.uid());
create policy "reports_read" on public.reports for select using (public.is_admin());
create policy "reports_update" on public.reports for update using (public.is_admin());

alter table public.blocks enable row level security;
create policy "blocks_admin_all" on public.blocks for all
  using (public.is_admin()) with check (public.is_admin());
create policy "blocks_self_read" on public.blocks for select using (user_id = auth.uid());

alter table public.chat_rooms enable row level security;
create policy "rooms_read" on public.chat_rooms for select using (true);
create policy "rooms_insert" on public.chat_rooms for insert
  with check (auth.uid() is not null and created_by = auth.uid());
create policy "rooms_update" on public.chat_rooms for update
  using (created_by = auth.uid() or public.is_admin());
create policy "rooms_delete" on public.chat_rooms for delete using (public.is_admin());

alter table public.chat_messages enable row level security;
create policy "messages_read" on public.chat_messages for select
  using (deleted_at is null or public.is_admin());
create policy "messages_insert" on public.chat_messages for insert with check (
  auth.uid() is not null
  and sender_id = auth.uid()
  and not exists (select 1 from public.blocks b where b.user_id = auth.uid())
  and not exists (select 1 from public.chat_rooms r where r.id = room_id and r.closed_at is not null)
);
create policy "messages_soft_delete" on public.chat_messages for update using (
  sender_id = auth.uid()
  or exists (select 1 from public.chat_rooms r where r.id = room_id and r.created_by = auth.uid())
  or public.is_admin()
);

alter table public.friendships enable row level security;
create policy "friendships_own" on public.friendships for all
  using (user_id = auth.uid() or friend_id = auth.uid())
  with check (user_id = auth.uid());
