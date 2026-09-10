-- TuRu - קישור פעילות למקור שממנו נוצרה (nullable - פעילויות שהוזנו ידנית פשוט נשארות null).
-- נדרש כדי ש-scan-source תדע אילו פעילויות "שייכות" למקור נתון, לצורך זיהוי "נעלמה מהמקור"
-- (consecutive_missing_scans, ראו 0046) - בלי העמודה הזו אין דרך לשאול "אילו פעילויות קיימות
-- כבר הגיעו מהמקור הזה" בלי לעבור על כל incoming_activities בכל סריקה.
alter table public.activities
  add column if not exists source_id uuid references public.sources(id) on delete set null;

create index if not exists idx_activities_source_id on public.activities(source_id) where source_id is not null;
