-- 0103 - Canonical constraint on activities.category (Phase E, 2026-09-21).
--
-- *** PREPARED BUT NOT APPLIED - AND NOT YET APPLICABLE. ***
--
-- This is the only Phase E migration that CANNOT simply be run. Applying it today FAILS: the
-- Phase D audit found two production rows holding non-canonical values, and this constraint is
-- exactly what would have prevented them.
--
--   'גן חיות'          x1  - חי פארק, קריית מוצקין
--   'חדשנות בחקלאות'   x1  - כיתת הפארק, כפר סבא
--
-- PREREQUISITE CLEANUP (must happen in the controlled write phase, before this migration):
--   1. Re-classify or null those two rows. 'גן חיות' has a deterministic destination now - it is a
--      declared alias of the new canonical 'חיות וגני חיות' - so it is a HIGH-confidence normalization.
--      'חדשנות בחקלאות' has no canonical destination and needs a human decision (likely 'מדע' or
--      'חווה' on its evidence).
--   2. Re-run the audit and confirm zero non-canonical values:
--        select distinct category from activities where category is not null
--          and category not in (<canonical list>);
--   3. Only then apply this migration.
--
-- WHY NOT 'NOT VALID': postgres supports adding a CHECK as NOT VALID to skip the backfill scan and
-- validate later. Deliberately not used here. The whole point of this constraint is that the
-- catalogue is clean; admitting it while two known-bad rows still exist would encode the corruption
-- as acceptable and leave a constraint that silently never gets validated.
--
-- LEGACY VALUE: 'פארק שעשועים' REMAINS ALLOWED and is listed below. It is still the stored value of
-- the ATTRACTION_COMPLEX concept (displayed as "מתחם אטרקציות"); renaming the persisted value is a
-- separate data migration that is not part of Phase E.
--
-- NEW VALUE: 'חיות וגני חיות' is included - it became canonical in Phase E
-- (constants/categoryValues.json) and rows will start using it once the cleanup phase runs.
--
-- TRANSITIONAL VALUES: 'בעלי חיים' and 'אטרקציה' are included because production rows still hold
-- them. They are expected to shrink during cleanup, not to be rejected at write time today.
--
-- MAINTENANCE HAZARD: this list duplicates constants/categoryValues.json. A future change to that
-- file must be mirrored here. Considered and rejected for now: a lookup TABLE with a foreign key
-- would remove the duplication, but it is a much larger change (seed data, RLS, migration ordering,
-- and every insert path gaining a FK dependency) than the integrity problem currently justifies.
--
-- ROLLBACK:
--   alter table public.activities drop constraint if exists activities_category_canonical_check;
--   (Pure metadata drop, instant, no data loss, no rewrite.)
begin;
alter table public.activities drop constraint if exists activities_category_canonical_check;
alter table public.activities add constraint activities_category_canonical_check
  check (category is null or category in (
    'גן שעשועים', 'ג''ימבורי', 'משחקייה', 'סדנה', 'חוג', 'הצגה', 'מוזיאון לילדים',
    'פארק', 'חווה', 'פינת חי', 'אטרקציה', 'בריכה', 'ספורט', 'יצירה',
    'מוזיקה', 'ריקוד', 'בישול', 'מדע', 'טבע', 'בעלי חיים', 'חיות וגני חיות',
    'פעילות מים', 'טרמפולינות', 'פארק שעשועים', 'קולנוע לילדים', 'ספרייה', 'שעת סיפור',
    'פעילות קהילתית', 'פעילות עירונית', 'חדרי בריחה', 'אחר'
  ));
commit;
