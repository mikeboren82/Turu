-- TuRu - הגדרות תמחור+תקציב ל-scan-settlement-gaps (בקשת המשתמש, 2026-09-12: "לפני כל Batch
-- חשב estimated cost. אם העלות הצפויה גבוהה מה-budget - עצור לפני ביצוע"). מחירים הם קירוב
-- שמרני-כלפי-מעלה (Google Places API New pricing tiers, נבדק ב-2026-09) - העלות האמיתית
-- שנצפתה בפועל (חשבון Google Cloud, 2026-09-11/12) הייתה ₪0.00 גם על נפח גדול בהרבה, כנראה
-- בזכות מכסת-חינם חודשית - אבל התקרה כאן היא בדיקה אמיתית, לא קישוטית: אם הצפי חורג, העדכון
-- הבא צריך אישור מפורש לפני הרצה, לא רק "כנראה יהיה בסדר".
insert into public.automation_settings (key, value) values
  -- Nearby Search (IDs-only field mask) - Google's Essentials SKU, ללא עלות.
  ('settlement_scan_price_id_only_usd', '0'),
  -- Text Search (Pro-tier field mask - displayName/address/location/types/uri).
  ('settlement_scan_price_text_search_usd', '0.032'),
  -- Nearby Search (Pro-tier field mask) - לא בשימוש כרגע ב-scan-settlement-gaps, קיים
  -- לעתיד/ל-playground_discovery.py.
  ('settlement_scan_price_nearby_search_usd', '0.032'),
  -- Place Details עם field mask "photos" בלבד - קירוב שמרני (הבדיקה בפועל תמיד הייתה ₪0
  -- בחשבון, ראו הערה למעלה - נשמר גבוה-מכוון כדי שהתקרה תהיה אמיתית ולא תמיד-עוברת-בקלות).
  ('settlement_scan_price_place_details_usd', '0.005'),
  -- תקרת-עלות-משוערת per batch (worst-case: כל batch_size יישובים בבדיקה זולה + כל daily_pro_
  -- budget מילויים יקרים + תמונה לכל אחד) - אם החישוב המוקדם חורג מזה, ה-batch לא רץ בכלל.
  ('settlement_scan_max_batch_cost_usd', '2.00')
on conflict (key) do nothing;
