-- 0103 - Valid-storage constraint on activities.category (Phase E, revised Phase G 2026-09-21).
--
-- *** STATUS: APPLIED in production 2026-09-21 (taxonomy write pilot); constraint
-- activities_category_canonical_check is live with the 32 values below (re-verified 2026-09-25). ***
-- Historical note: this file was first prepared while the catalogue was being cleaned (0 violations
-- as of 2026-09-21); enabling the constraint was a separate, explicit decision, taken that day.
--
-- WHAT THIS LIST IS. It is the VALID-STORAGE set, which is NOT the same thing as the set a
-- classifier may choose from. constants/categoryValues.json defines three sets that answer three
-- different questions, and conflating them is what produced the corruption this constraint exists
-- to prevent:
--
--   categories (31)            what may be ASSIGNED - handed to the AI extraction model and used as
--                              the accept-list of sanitizeCategory(), which validates its answer.
--   storageOnlyCategories (1)  what may legally EXIST but is never offered to a classifier.
--   archiveCategories (2)      commitment semantics - an orthogonal overlay, not a third taxonomy.
--
--   valid storage = categories + storageOnlyCategories = the 32 values below.
--
-- WHY 'קייטנה' IS HERE (Phase G). It is an intentional TuRu value, not corruption: it is half of
-- the commitment/restore gate (shouldArchiveForCommitment in tools/import-tool/server.js and
-- lib/submitActivity.js), it has Hebrew and English display labels, and two archived production
-- rows hold it. It was simply never added to `categories`, so the canonical layer read it as
-- invented. The fix is NOT to promote it into `categories` - that would tell every AI classifier to
-- start generating camps - and NOT to overwrite the two rows, which would silently strip their
-- protection from being restored to approved. It is storage-only: legal to hold, never assigned.
--
-- PREREQUISITE CLEANUP - COMPLETED 2026-09-21, in the controlled write phases:
--   'גן חיות'         x1  חי פארק, קריית מוצקין  -> 'חיות וגני חיות' (declared alias; pilot)
--   'חדשנות בחקלאות'  x1  כיתת הפארק, כפר סבא    -> archived as ineligible (no public child/family
--                          offering: a closed gifted-students classroom plus conference rental),
--                          category normalized to 'אחר'. Phase G.
--   'לייזר טאג'       x1  -> 'אטרקציה'   |  'ציור' x1 -> 'יצירה'  |  'הפעלה' x1 -> 'אחר'. Phase F.
--   'קייטנה'          x2  -> UNCHANGED BY DESIGN; admitted by this list instead. Phase G.
-- Re-verify before applying:
--   select category, count(*) from public.activities
--    where category is not null and category not in (<the list below>) group by category;
--
-- WHY NOT 'NOT VALID': postgres supports adding a CHECK as NOT VALID to skip the backfill scan and
-- validate later. Deliberately not used here. The whole point of this constraint is that the
-- catalogue is clean; admitting it while known-bad rows still exist would encode the corruption as
-- acceptable and leave a constraint that silently never gets validated.
--
-- LEGACY VALUE: 'פארק שעשועים' REMAINS ALLOWED. It is still the stored value of the
-- ATTRACTION_COMPLEX concept (displayed as "מתחם אטרקציות"); renaming the persisted value is a
-- separate data migration that is not part of this work.
--
-- TRANSITIONAL VALUES: 'בעלי חיים' and 'אטרקציה' are included because production rows still hold
-- them (16 and 49). They are expected to shrink during later cleanup, not to be rejected at write
-- time today. 'חוג' likewise stays assignable: a model may choose it and the row is auto-archived.
--
-- DRIFT: this list duplicates constants/categoryValues.json because SQL cannot import JSON. It is
-- no longer a hand-maintained hazard - tests/categoryStorageModel.test.js parses the IN (...) list
-- out of THIS FILE and fails if it differs from categories + storageOnlyCategories, so the two
-- cannot drift without CI going red. A lookup TABLE with a foreign key was considered and rejected:
-- it is a much larger change (seed data, RLS, migration ordering, every insert path gaining an FK
-- dependency) than the integrity problem justifies.
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
    'פעילות קהילתית', 'פעילות עירונית', 'חדרי בריחה', 'אחר',
    'קייטנה'
  ));
commit;
