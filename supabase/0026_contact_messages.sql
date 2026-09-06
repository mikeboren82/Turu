-- WABBIT - שומר כל פנייה מ"צרו קשר" גם ב-DB (לא רק שולח מייל), כדי שיהיה אפשר לצפות בהן
-- ולענות מתוך פינת ניהול ("הודעות ממשתמשים") - אותו עיקרון בדיוק כמו app_feedback (0022),
-- כולל insert פתוח לגמרי (גם לאורחים, בדיוק כמו שטופס "צרו קשר" כבר פתוח היום).
create table public.contact_messages (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  message text not null check (char_length(message) > 0 and char_length(message) <= 5000),
  status text not null default 'new' check (status in ('new', 'replied')),
  admin_reply text,
  replied_at timestamptz,
  created_at timestamptz not null default now()
);

create index idx_contact_messages_created_at on public.contact_messages(created_at desc);

alter table public.contact_messages enable row level security;

-- הטופס באפליקציה לא דורש התחברות - כל אחד יכול לשלוח.
create policy "contact_messages_insert" on public.contact_messages for insert
  with check (true);

-- קריאה/עדכון (סימון "נענה" + שמירת התשובה) - אותו is_admin()/is_trusted_uploader() כמו
-- reports/app_feedback, כדי שגם כלי הניהול (רץ תחת role='importer') יוכל לטפל בפניות.
create policy "contact_messages_read" on public.contact_messages for select
  using (public.is_admin() or public.is_trusted_uploader());
create policy "contact_messages_update" on public.contact_messages for update
  using (public.is_admin() or public.is_trusted_uploader());

grant insert on public.contact_messages to anon, authenticated;
grant select, update on public.contact_messages to authenticated;
