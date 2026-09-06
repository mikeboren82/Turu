-- WABBIT - עדכון רשימת האזורים הגאוגרפיים לפילטר "אזור בארץ" (7 אזורים במקום הרשימה הישנה)
alter table public.locations drop constraint if exists locations_region_check;
alter table public.locations add constraint locations_region_check
  check (region in (
    'גוש דן והמרכז',
    'השרון',
    'ירושלים והסביבה',
    'חיפה והקריות',
    'הצפון והעמק',
    'השפלה והדרום',
    'יו"ש והבנימין'
  ));
