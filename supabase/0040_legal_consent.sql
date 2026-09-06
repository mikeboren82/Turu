-- שכבת Legal: מנגנון מינימלי לתיעוד הסכמה לתנאי שימוש/מדיניות פרטיות בעת הרשמה/כניסה.
-- שורה אחת לכל משתמש (upsert לפי user_id) - לא מצטבר היסטוריה, רק המצב העדכני ביותר,
-- בדיוק כפי שנדרש (user_id, terms_version, privacy_version, accepted_at, בלי מידע נוסף).
create table if not exists public.legal_consents (
  user_id uuid primary key references auth.users(id) on delete cascade,
  terms_version text not null,
  privacy_version text not null,
  accepted_at timestamptz not null default now()
);

alter table public.legal_consents enable row level security;

create policy "legal_consents_own_select" on public.legal_consents
  for select using (user_id = auth.uid());
create policy "legal_consents_own_insert" on public.legal_consents
  for insert with check (user_id = auth.uid());
create policy "legal_consents_own_update" on public.legal_consents
  for update using (user_id = auth.uid());
