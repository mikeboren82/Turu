# TURU MONSTER + CLEANER — UNIFIED DATA-INTEGRITY & STABILIZATION REPORT
**Date:** 2026-09-19 · **Worktree:** `C:\Users\mbore\turu-monster-work` · **Branch:** `monster-work` · **Starting HEAD:** `240eee476da582c84cf8afb88e8f6f6c651ef164` (main, contains the 2026-09-17 master program `78a4b65`) · **Nothing was committed during the program; committed on `monster-work` afterwards at the owner's request, not pushed.**

Continuation program (not a restart): every requirement was verified against HEAD first and classified ALREADY_SATISFIED / NEEDS_COMPLETION / NEEDS_REPAIR / BLOCKED / NOT_APPLICABLE (ledger in §AC). Success criterion: truthful data + safe repair + measurable prevention + no silent corruption — where a metric did not improve, this report says so.

---

## A. Executive summary

1. **The Cleaner could believe a repair succeeded when it did not.** `activities_update` RLS allows only the row's creator or an admin; the Cleaner bot is role `importer`. Every UPDATE on an activity it did not create returned 0 rows with no error and was classified `already_filled` (4 historical `missing_venue` cases on NULL-owner rows confirmed). **Fixed in code**: every conditional write is now verified by a re-read (`verifiedUpdate`); a still-needed write is `write_denied` → explicit failure, case not resolved, counted per run. The authorization root cause needs the RLS migration `0099` — **written, not applied by owner decision** (§M). 54 NULL-owner rows remain unrepairable by the bot; that is now visible, not silent.
2. **Temporal approval gate implemented and deployed**: a recurring event without weekdays, or an "אירוע" without a one-time schedule, can no longer auto-approve (Deno `missingTemporalEvidence`, scan-source gate + `ימי פעילות` gating issue; Node twin in the Cleaner hand-back and review-queue reprocessing). One-time-without-date was ALREADY_SATISFIED (proven by tests). In the first production cohort after the deploy, **33 of 105 candidates were held by the new gate**; evergreen places / OSM / Google playgrounds are untouched.
3. **Settlement centroids are now authoritative for every settlement that had a bad or missing one**: CBS "קובץ היישובים" 2024 (ITM/EPSG:2039, explicit conversion, known-place validated) → 1,268 HIGH identity matches (code + name or ≤ 1 km corroboration): 1,075 already valid (≤ 2 km, left as they are), **92 wrong by > 5 km, 9 off by 2–5 km and 92 missing → 193 replaced** (`geocode_source = 'cbs:bycode2024'`), 2 identity conflicts + 46 codes absent from CBS 2024 explicitly unresolved.
4. **`city` = the canonical user-facing settlement.** 1,006 published rows carried a non-canonical city (692 regional councils, 88 Arabic-script OSM values, ~160 spelling/alias variants, Latin strings). The missing_city pipeline was extended (`replace_city`): dry run **690 HIGH proposals (526 coordinates + council agreement, 160 normalizations, 4 address)**; after the CBS centroid repair and 10 curated aliases the apply resolved **726 rows** (19 in the verification batch + 707; 561 regional councils, 240 spelling/alias variants, 47 Arabic/Latin/unknown strings; methods: reverse geocode 396, nearest dominant settlement of the same council 201, spelling normalization 124, address 5) with value guards and 0 denied writes. Remaining non-canonical: 232 — 132 unresolved (83 council-only evidence, 49 no named settlement), 46 conflicts, 12 need corroboration, **37 Palestinian localities classified individually as a service-area decision** (103 before the centroid repair; never renamed, never bulk-archived), and 5 foreign points (Aqaba ×3 Jordan, Irbid, Lebanon) archived `outside_service_area`. The shared resolver learned 27 aliases that pass the tightened rule (5 learned in the first pass were revoked by the rule: generic words "גולן"/"צפון", a substring of another settlement, two historical names) + 10 curated spelling variants.
5. **Fresh Monster validation cohort (8 active sources, real production path)**: 61 new canonical subjects → 78 new Cleaner cases = **127.9 / 100 TOTAL**, of which **14 AVOIDABLE = 23 / 100**. TOTAL is *not* comparable with the historical 35.4 / 39.1: 29 of the 78 cases are the new gate's own `ימי פעילות` holds (intended: silently-approved recurring events became review items) and the cohort is two hard municipal/organizer calendars; excluding the gate-created class TOTAL is 80 / 100 — still worse, so the honest reading is **directionally worse on TOTAL, inconclusive on comparability, and 23 / 100 AVOIDABLE is the first measured baseline of its kind**. Two systemic avoidable causes were fixed upstream and deployed (corroborated category hint; identity-less pending-queue guard).
6. **Idempotency**: the rescan found **17 duplicate pending candidates stacked** by identity-less (no city/date) re-detections — a real Monster defect, fixed (source-scoped name guard), verified on a third rescan (0 twins, 24 skipped as pending), the 17 rows closed with reason. No duplicate canonical activities, no duplicate Cleaner cases.
7. **Images**: 413 open missing-image cases dry-run: 211 resolvable, 144 only a site-default/generic image (correctly refused), 56 no usable image, 2 blocked. **199 HIGH-kind images attached** in four bounded batches (182 event_specific, 14 event_series, 3 venue_specific; 10 weaker organizer-wide candidates released untouched; 1 placeholder-flag write denied on a NULL-owner row — surfaced, not hidden); 6 sampled images visually verified as the event's own poster. Open image cases 413 → 217; published non-playground rows without an image 417 → 222.
8. **Schedules were never invented**: the historical 67 schedule-less events are 77 rows today; page evidence yields **0 HIGH**, 6 MEDIUM, 17 permanent-offering suspects (museum programmes, birthday packages, repertoire shows — the MODEL is wrong, not the field), 46 no evidence → all stay published with UNKNOWN availability (not searchable by day/time), nothing written.

---

## B. Repository / worktree safety
- Path `C:\Users\mbore\turu-monster-work`, branch `monster-work`, starting HEAD `240eee4` (verified; fast-forwarded once at the owner's request from `b14f336`). Clean at start; no reset/stash/clean/checkout/commit/push at any point.
- Main tree `C:\Users\mbore\KidsApp` never accessed for code; the only copy from it was `tools/import-tool/.env` (gitignored credentials) with explicit owner approval.
- The Windows task "TuRu Cleaner pilot" (runs `cleaner.js` from the MAIN tree every 20 min) was **disabled** for the program with owner approval and re-enabled at the end.
- Pre-existing uncommitted changes in this worktree: none.

## C. Before / after metrics (live, 2026-09-19)
| Metric | Before (16:00) | After | Note |
|---|---|---|---|
| Published activities | 5,683 | 5,682 | +4 new from the cohort scans, −5 archived outside the service area |
| Published without canonical city | 57 | 57 | historical 59; the 57 are explained (58 `city_unresolved` / 3 human archives) |
| Published with regional council as city | 692 | **132** | 83 council-only evidence + 49 rural/no named settlement, all explained |
| Arabic-script city values | 88 (55 distinct) | **64** | 14 Israeli localities repaired; the rest are Palestinian localities (decision) / conflicts |
| Weak (centroid) coordinates stamped | 137 | 139 | honest exposure kept (+2 new) |
| `created_by = NULL` published | 54 | 54 | unchanged by design (§M) |
| Pending update review rows | 248 | 257 | +9 real updates from the cohort scans (historical 229) |
| Settlement centroids: council-heuristic suspects / CBS-wrong | 100 / 92 | 0 wrong vs CBS | 193 repaired; 20 without any centroid |
| Non-playground published without image | 417 | **222** | 199 attached (§N) |
| Open Cleaner cases | 1,423 | ~1,355 | +105 missing_location / +64 metadata are the cohort's NEW candidates (57 held for review) — surfaced, not created by repair; −198 image cases resolved |
| Open missing_image cases | 413 | **217** | remaining = generic-only 144 + no image 56 + retries |

## D. Legacy cohort reconciliation
- **Google-sourced playgrounds**: 686 published `גן שעשועים` rows carry a `google_place_id` (+15 Google non-playgrounds, 26 archived). Scanner metadata (`settlement_scan_candidates.place_kind`) exists for 439 of them: PLAYGROUND 145, PARK_WITH_PLAYGROUND 52, **PARK 201, UNCERTAIN 41**; 412 approved rows have no candidate row (imported directly). Already fixed before this run (2026-09-17): 13 misclassified by name → 7 reclassified, 2 archived, 4 human. The historical "480" cohort could not be reproduced exactly (no stored definition); the current PARK+UNCERTAIN cohort (242) is its successor.
- **Schedule-less events (historical 67)**: today 77 published non-playground rows lack a usable schedule: 2 one-time without date (`פסטיבל האורות`, `תערוכת הבלונים`, manual), 2 "אירוע" with no schedule rows, **65 "אירוע_קבוע" with no schedule rows**, 8 permanent venues. 68 of them have an archived Cleaner `missing_schedule` case (`insufficient_required_data`, explained), 10 open. The "62 recurring extractions without weekdays" no longer exist as live rows (0 recurring rows without `day_of_week`).
- **Permanent venues without hours (historical 7)**: 8 today (משחקייה ×6 incl. פאנקי מאנקי כפר יונה / ג'ימבו פליי, פארק שעשועים ×2) — availability UNKNOWN, left as is.
- **OSM playgrounds**: 4,397 published, all with an OSM node id in `source_url`, 2 with schedules; intentionally schedule-less, untouched, never opened as `missing_schedule` (playgrounds are exempt in `discover.js`).

## E. Google playground integrity
- Name-based classifier (`lib/playVenueClassifier.js`) extended with HIGH rules for **petting zoos → פינת חי, botanical gardens → טבע, pump tracks / skate parks → ספורט** and MEDIUM (human) for nature sites (שלולית חורף / חורשה / שמורה); public gardens ("גינת…", "גן הבנים", "Habanim Garden") are never reclassified on the name alone (tests). Discovery opened 18 `misclassified` candidates; the Cleaner pass claimed 14: **5 reclassified HIGH by name rule** (`+category`, e.g. פינת חי / botanical garden / pump track), **9 archived `requires_human_judgment`** (MEDIUM nature/attraction names), 0 denied writes (none of the 14 was a NULL-owner row).
- Evidence limits: the scanner stored no Google `types` or opening hours; no Places key exists on the Cleaner machine (`external_limit`). PARK-kind names: 107 say playground, 343 say park/garden, a handful are commercial ("בבילון פארק", "פלא פארק", "אקשן לנד", "ג'ונגל כיף") → **AMBIGUOUS / human**, not auto-reclassified (a mass "PARK → פארק" change would be a large unexpected reclassification — STOP condition; reported instead).
- Regression found: `קיפצובה` exists twice (official `פארק שעשועים` venue + a Google-scanner `גן שעשועים` row 0.6 km away) — a place duplicate the ≤ 80 m rule cannot see; for a person.
- **Opening hours**: no trustworthy source data is stored for Google playgrounds; the schema (`activity_schedules.fixed_hours`, one row per weekday possible) *can* represent weekday-specific hours; nothing was written because there is no evidence. Smallest compatible step: a bounded Places-details pass with a key (paid — not done).

## F. Schedule-less event integrity
- `recover-event-schedules.js` (new, dry-run default): provenance page + detail page + official page → JSON-LD Event dates (HIGH) / dates & weekdays in the card that names the event (MEDIUM) / permanent markers. Result on the 77: **DATES_FOUND_HIGH 0**, DATES_FOUND_MEDIUM 5, WEEKDAYS_FOUND_MEDIUM 1 (מדרחוב נחלת בנימין: שלישי, שישי), PERMANENT_OFFERING_SUSPECTED 17, NO_EVIDENCE 46, PLACE 8. Policy: only HIGH may be written → **0 schedule rows written, 0 events archived, nothing fabricated**.
- Model question (§8): the 17 suspects (Safari birthday/group packages, museum programmes and exhibitions, Karon repertoire shows, "כרטיס משולב") are permanent offerings filed as `אירוע_קבוע`; correcting `entity_type` en masse is a product decision (proposed: a permanent-offering semantics rather than forcing a date). The 2 date-less one-time events (`פסטיבל האורות`, `סיורי לינה - ספטמבר 2026`) need a person.
- Approval prevention: see §A.2; tests in `_shared/extraction.test.ts`, `tests/temporalEvidence.test.js`.

## G. Permanent venue availability
UNKNOWN stays UNKNOWN: no fixed-hours rows were written for the 8 venues; `missingTemporalEvidence` explicitly returns null for `מקום_קבוע` (tested), so evergreen places are never blocked or "opened every day".

## H. OSM enrichment feasibility
Feasible and bounded: all 4,397 rows keep their OSM node id; `audit-osm-playgrounds.js` already batches 300 ids per Overpass query (3 public endpoints, no key). `access`, `opening_hours`, `fee`, `operator` tags can be fetched the same way (~15 requests) and written fill-null with `address_source`-style provenance. Not run (not needed for any verified repair in this program).

## I. Settlement centroid authority
- **Source**: CBS "קובץ היישובים" bycode 2024 (`reference/cbs-settlements-2024.json`, provenance header; raw files in the session scratchpad). Mirror: data.gov.il dataset `localities-in-israel` (2023 edition, resource `d47a54ff-…`, last modified 2025-04-08). Licence: CBS terms of use (copy/derive/commercial with attribution) / data.gov.il "Other (Open)". The table's previous `source` (`data.gov.il/citiesandsettelments`, Population Authority) has **no coordinate fields at all** — the old centroids came from an unconstrained Nominatim name geocode.
- **Identity**: CBS code (= `settlements.settlement_id`) + name agreement (`heKey` Hebrew / English / transliteration) or the current centroid within 1 km (4 CBS spelling variants: הרצלייה, דבורייה, כוכב יאיר, בית אריה-עופרים). Names are evidence, the code is identity.
- **CRS**: `קואורדינטות` = 12-digit packed ITM easting+northing in metres (EPSG:2039; 10-digit tens-of-metres only for form-530 pseudo-areas, 164 rows, skipped). `lib/itm.js`: TM inverse on GRS80 + Helmert to WGS84. Known-place validation (Jerusalem 0.6 km, Tel Aviv 1.0, Ariel 0.1, Haifa 2.1 [Hadar = built-up centre], Be'er Sheva 0.6, Eilat 1.0, Katzrin 0.3, Ma'alot 0.3) in `tests/itm.test.js`.
- **Dry run → batch 20 → DB check (published activities' median distance to the new origin: אלפי מנשה 0.63 km, אלון שבות 0.25, עלמון 1.01) → remaining 173**. Classification: AUTHORITATIVE_MATCH_HIGH 1,268 (ALREADY_VALID 1,075 · OFF 9 · WRONG 92 · NO_CURRENT 92), IDENTITY_CONFLICT 2 (`מחנה יוכבד*`, `אובנת`/`אבנת` — both without a current centroid), NO_AUTHORITATIVE_MATCH 46 (codes not in CBS 2024 — 20 still have no centroid, explicitly unresolved). Reports `settlement-centroid-cbs-2026-09-19-{dryrun,applied}.json` keep every old value.
- Search origins verified after the write for north / centre / Jerusalem / south / small / West Bank / rural (§S).

## J. Regional council / locality audit
- Baseline 692 rows (SQL) — the audit ran on **1,006** non-canonical published cities (councils + variants + Arabic + Latin).
- Classes (brief §17, from the evidence actually used): **A coordinates → locality 526** (reverse geocode names the village, or nearest dominant CBS settlement ≤ 1 km with the same council), **B venue locality 0**, **C address locality 4**, **E council-only evidence 83 + 16 single-signal**, **F conflicting 50** (e.g. stored council גלבוע vs reverse village of another council; Hebron rows 28 km from the CBS point), **G rural / no named settlement 29**, H variant normalized 160, P Palestinian locality 103, X outside service area 4, RETRY 31 (geocoder).
- **Invariant documented**: `locations.city` = the canonical user-facing settlement (`normalizeCityName(settlements.name_he)`, e.g. "תל אביב יפו", "דאלית אל כרמל"); `region` = Turu product region (kept — the CBS district office is coarser: Golan stays "הצפון והגליל"); a regional council is never a city; `address` = street text; `settlement_id` lives in the resolver, not on the row. No second city field.
- Resolution path used: canonical venue › address locality › coordinate-to-settlement (reverse geocode → CBS settlement, else nearest dominant settlement of the same council) › nothing else. Never the council centroid or office.
- Applied: **726 rows** (19 verification batch inspected in the DB → 707 continuation; 561 councils → localities, 240 variants, 47 Arabic/Latin/unknown; by origin: OSM import 642, Google scanner 34, Monster sources 32, manual/legacy 18), value-guarded `citiesCorrected`, region untouched, 0 denied; UNRESOLVED 132 / CONFLICT 46 / NEEDS_CORROBORATION 12 untouched with reasons; report `city-not-canonical-2026-09-19-{dryrun,applied}.json` (the final dry run after the apply shows the 232 remaining).

## K. Split spelling audit
240 variant rows normalized through the SHARED resolver only (תל אביב → תל אביב יפו ×87, קדימה/צורן → קדימה צורן ×30, בית אריה עופרים → בית אריה, Latin/Cyrillic spellings, …); 10 geocoder spelling variants the resolver did not know were added to `settlement_aliases` as curated rows (דלית אל-כרמל, עוספייא, נוה אילן, נוה ימין, ג'וליס, חיספין, כנרת מושבה, תושייה, מר'אר, כפר ביל"ו ב׳ — each checked against an existing CBS target) and 27 were learned by `learnSettlementAlias` (Arabic / Latin / Cyrillic spellings of the resolved settlement, plene variants such as יוקנעם עילית, טירת הכרמל). The learning rule was tightened during the program after it accepted "גולן → קשת" and "צפון → באר שבע" (generic geographic words), "שער חפר → גבעת שפירא" (substring of another settlement) and two historical names — those 5 were revoked (`reevaluate-learned-aliases.js`) and the rule now refuses them (tests). No second normalization table.

## L. Border / locality leakage audit
88 rows / 55 Arabic-script values, each classified with coordinates + reverse geocode + CBS knowledge, never by script: **ISRAEL_LOCALITY_MISRESOLVED → repaired** (نحف→נחף, أبو غوش→אבו גוש, الجش→ג'ש, شقيب السلام→שגב שלום, كسيفة→כסיפה, أم الفحم→אום אל פחם, كفر مندا→כפר מנדא, إعبلين→אעבלין, شعب→שעב, طوبا الزنغرية→טובא זנגריה, المزرعة→מזרעה, مجدل شمس→מג'דל שמס, المغار→מגאר, مجلس إقليمي القيصوم→מכחול); **OUTSIDE_SERVICE_AREA → archived** (العقبة ×2 Jordan, حي الملعب Irbid, إسكندرونة Lebanon); **PALESTINIAN_LOCALITY_CORRECT_BUT_OUTSIDE_CBS → decision** (رام الله ×8, غزة ×7 and the Gaza camps, بيرزيت, سلفيت, عناتا ×3, بيت جالا/بيت ساحور/بيت لحم, the West Bank camps — 103 rows in total incl. Israeli rows whose coordinates fall in Area A/B such as 33 "מועצה אזורית שומרון" points); AMBIGUOUS: الخليل ×5 (CONFLICT with the CBS "חברון" point 28 km away), دالية الكرمل ×5 (geocoder spelling — now aliased, resolves on the next pass), جت (NEEDS_CORROBORATION). Root cause of the leak: the OSM import took `addr:city`/`is_in` in Arabic; the geocoder leak path (city-only fallback) was closed on 2026-09-17.

## M. Cleaner authorization / RLS
- **Root cause**: `activities_update USING (created_by = auth.uid() OR is_admin())`; `activity_schedules` policies follow the activity; the bot is `importer` (`is_trusted_uploader()` true, `is_admin()` false). `created_by` = the human/bot who inserted the row; service-role inserts (retired `scan-settlement-gaps`: `created_by: null`; `scan-source`: `source.created_by ?? null`) can leave it NULL. Origin of the 54: 43 Google-scanner playgrounds (2026-09-11…14), 11 scan-source rows of 3 sources whose `created_by` is NULL.
- **Authorization matrix (no-op self-assignment updates, current policies)**: ANON: select approved ✓, every update 0. USER A / USER B: activities 0, schedules 0, cleaner_cases 0, **locations 1 (any authenticated user may update any location row — pre-existing gap, the app's `submitActivity` fill-in relies on it; not changed here)**. IMPORTER BOT: bot-owned activity ✓, cleaner_cases ✓, locations ✓, schedules of bot-owned ✓, **NULL-owner activity 0 (silent)**, its schedules 0. ADMIN: everything ✓.
- **Fix**: `verifiedUpdate` / `classifyZeroRowWrite` / `applyActivityPatch` in `cleaner/apply.js`, wired through every Cleaner write path (address, coordinates, venue link, city, image placeholder flag, misclassified category/status, outside-service-area archive, missing-coordinates archive, enrichment fill-null); `write_denied` → `markAttemptFailed` (retry with error) never `resolveCase`; `counters.writeDenied`; 9 regression tests (`tests/zeroRowWrite.test.js`). Also fixed: `--dry-run` used to write attempts/archives.
- **Historical NULL cohort**: 54 rows — not rewritten (no fake ownership). Migration `supabase/0099_system_maintenance_rls.sql` (`can_maintain_activity(created_by, source_id)`: importer/admin may maintain rows with `created_by IS NULL` or `source_id IS NOT NULL`; normal users unchanged) is written and reviewed but **NOT APPLIED — owner decision "report only"**. Until it is applied the Cleaner will report `write_denied` on those rows instead of resolving them.
- **Prevention**: with 0099 the definition "ingestion-owned" covers future service-role rows without touching `created_by`; without it, new scan-source rows of sources whose `created_by` is NULL keep entering the unrepairable state (3 such sources today).

## N. Missing images
- Architecture reused as is (`imageResolver` hierarchy event_specific > event_series > venue_specific > organizer_specific > generic_fallback, `imageProbe` validation, downgrades for site-default and reuse). New: `--image-kinds=` rollout flag in `cleaner.js` (weaker kinds are released untouched), dry-run outcomes now print the kind.
- Baseline 413 open cases (municipality 50%, venue_operator, community centres; `detail_url` present on 1 → detail traversal absent on almost every image-poor source).
- **Dry run (413)**: RESOLVABLE 211 · AMBIGUOUS (only the host's default og:image — refused, `generic_only` 153) 144 · NO_IMAGE_FOUND 56 (26 no candidate at all, 24 candidates too small / logo pattern / banner, 6 mixed) · BLOCKED_SOURCE 2 (image URL 404). RIGHTS: every attached image keeps `image_source_type` + `needs_rights_review` by host rule (existing model).
- **Bounded apply** (`--cases=` the dry-run-resolvable case ids, `--image-kinds=event_specific,venue_specific,event_series`; `organizer_specific` / `generic_fallback` released untouched): batch 1 (15 by priority: 1 attached, 1 archived `image_unavailable_only`, 13 retry — showed that priority order ≠ resolvability, hence the case-list batches), batch 2 (40: **38 attached**, 2 released), batch 3 (85: **80 attached**, 4 released, 1 retry), batch 4 (85: **80 attached**, 4 released, 1 retry, **1 `write_denied`** on the placeholder flag of a NULL-owner activity — the image row exists, the flag could not be cleared, recorded on the case). **Total 199 attached** (182 event_specific, 14 event_series, 3 venue_specific), 10 `organizer_specific` candidates released, 0 generic images. Open cases 413 → 217 (the 144 generic-only + 56 no-image + retries); non-playground rows without an image 417 → 222. **Visual verification** of 6 attached images (הדבורה מאיה, תירס חם, קסמים בשחקים, המיקרופון הוא קישופון, שלגיה, CIRCO LAND): all six are the event's own poster/flyer or the show's photo — correct subject, acceptable crop, no logo, no placeholder, no unrelated artwork; `needs_rights_review` set by host rule where the image is off-host (smarticket / coing CDNs).
- **Monster feedback**: image debt clusters on sources without detail traversal (municipal calendars: 104 failures on the listing page alone, 54 after the venue site); the 144 generic-only cases are a source limitation (one og:image per site). Prevention lever = enable `adapter_config.detail_traversal` on the image-poor municipal sources (list in the dry-run log) — configuration, proposed not applied (per-source scan-time cost).

## O. Cleaner debt baseline (before validation)
Open 1,423 (incomplete_address 325, missing_image 413, missing_location 45, missing_region 138, missing_required_metadata 152, missing_schedule 10, missing_venue 258, unverified_location 82); resolved 1,834; archived 741 (all explained; 0 unexplained); backoff/stuck 0 beyond window (report-cleaner). After the program (before the image batches): open 1,553 — the increase is the validation cohort's own new candidates (missing_location 45 → 105, missing_required_metadata 152 → 216 incl. the gate's `ימי פעילות` holds, missing_schedule 10 → 15, missing_venue 258 → 266) plus 48 newly discovered cases; misclassified 14 resolved / 13 archived; missing_city unchanged (124 resolved / 85 archived).

## P. Validation cohort
- Denominator definition: **NEW CANONICAL SUBJECT = an `activities` row created in the window by a cohort source + an `incoming_activities` row with `match_type='new'` found in the window by a cohort source**; updates, duplicates, rediscovered historical debt and Cleaner rediscovery excluded. Implemented in `run-monster-cohort.js` (documented in-file).
- Cohort (8 ACTIVE `generic_html` sources, REAL path `scan_source_now` → pg_net → scan-source): עיריית רעננה (dense listing + detail, Sharon), היכל התרבות כרמיאל (venue + detail, north), מוזיאון ארץ ישראל (evergreen offerings, centre), היכל התרבות אשקלון (dated events + detail, south), עיריית רמת השרון (location-problematic, 114 location cases), קניון כפר סבא הירוקה (image-problematic; returned HTTP 522 this run), תיאטרון הקרון (כרטיסים) (Jerusalem, clean control), החברה להגנת הטבע (nationwide organizer).
- Funnel (T0 13:54:49Z): 18 pages checked / 12 changed / 15 AI calls / 105 candidates: **59 new (2 auto-approved, 47 needs_review, 10 new), 19 updates, 27 duplicates**; issues on the new rows: מחיר 80 (soft), **ימי פעילות 33 (new gate)**, עיר 19, קטגוריה 10, קהל יעד 6, תאריך 3. Listing funnel where recorded: Ra'anana 22/22 cards matched, SPNI 40/37/3, Eretz-Israel museum 20/3/17 (offerings, not events — measured, not re-extracted).
- **New canonical subjects 61 → Cleaner discovery → 78 cases = 127.9 / 100** (missing_required_metadata 37 — 29 of them `ימי פעילות`/gate-created —, missing_location 37, unverified_location 2, missing_venue 2; by source: רמת השרון 43, SPNI 28, museum 7). **AVOIDABLE 14 = 23 / 100** (metadata derivable from the page/name+family 6; location evidence on the source page 5; prior activity of the same source with the same label 3). HONEST_UNRESOLVABLE 64 (no venue name on municipal cards, no weekdays anywhere on the page, etc.).

## Q. Comparison
Historical 35.4 (first baseline) and 39.1 (2026-09-17) per 100 were computed over all subjects since the first Cleaner run (thousands of auto-approved playgrounds/venues dilute the ratio) with the pre-gate issue set. This cohort is 61 subjects from two hard sources with the gate active: TOTAL 127.9 / 100 (80 / 100 excluding the gate-created class) — **directionally worse on TOTAL, but the definitions and cohort make a direct comparison invalid**; no historical AVOIDABLE figure exists, so **23 / 100 AVOIDABLE is the baseline going forward**. No statistical claim is made from 61 subjects.

## R. Cleaner → Monster feedback
- Avoidable root causes: (1) category derivable from name keyword + source family (6) → **fixed**: `_shared/categoryHints.ts` (lockstep with the Cleaner tables), wired into `sanitizeCandidate` with `category_source` provenance, tests, deployed; (2) location evidence on the listing page (5) → *not* changed upstream: the Cleaner's `source_page` MEDIUM evidence on a municipal calendar is typically the publisher's own address, i.e. the very laundering pattern closed on 2026-09-17 — counted as avoidable by definition but unsafe to automate; (3) same-source prior activity with the same label (3, SPNI tours without a city) → documented next step (Monster-side reuse of the source's own location knowledge, mirroring the Cleaner `existing` stage).
- Idempotency defect found by the rescan → **fixed + deployed** (identity-less pending-queue guard); verification rescan: 0 twins, 24 `skipped_pending_in_queue` on SPNI.
- Rerun outcome: the verification rescan of the two stacking sources produced 14 genuinely new subjects and 0 duplicates (§T).

## S. Regression cases
- חוות ארץ האיילים: city כפר עציון, address NULL (the "367, ביתר עילית" road number stays cleared), coords 31.6651,35.1127 ✓. פאנקי מאנקי כפר יונה: משחקייה ✓. ג'ימבו פליי: משחקייה, פרדסיה, address ✓. חי פארק: one live per place (Kiryat Motzkin zoo, Kfar Saba petting zoo) + the archived duplicate ✓. גולי והגיטרה: 8 occurrences with booking links, HIGH detail address הפלמ"ח 2 א, detail provenance ✓. קיפצובה: city צובה ✓ (and the place duplicate noted in §E). Representative repaired MISSING_CITY rows: 57 remain without city (58 archived `city_unresolved`, 3 human — unchanged).
- Temporal / entity: OSM playground without schedule valid ✓ (discover exempts playgrounds; gate returns null for מקום_קבוע); Google playground not blindly trusted ✓ (classifier rules + Cleaner cases); one-time without date cannot auto-approve ✓ (sanitize `תאריך` + `isPlausibleEventDate` + gate); recurring without days cannot auto-approve ✓ (new); permanent venue may lack a schedule ✓; failed enrichment never fabricates ✓ (0 writes); reclassification preserves provenance ✓ (`resolution.evidence.was`); cleanup idempotent ✓ (§T). Temporal-search implementation untouched.
- Settlement search origins (after the CBS write): כרמיאל 0.17 km from the known centre / median activity distance 0.92 km · חיפה 2.9 / 3.6 · תל אביב יפו 0.5 / 4.0 · רעננה 0.35 / 0.84 · ירושלים 0.34 / 3.45 · באר שבע 0.8 / 2.4 · אשקלון 0.96 / 1.5 · אילת 0.2 / 1.3 · קצרין 0.2 / 0.8 · צובה 0.26 / 0.3 · אריאל 0.29 / 1.0 · מודיעין עילית 0.14 / 0.9 · עלמון (repaired) 0.01 / 1.0 · אלפי מנשה (repaired) 0.01 / 0.63 · אלוני הבשן / רמת מגשימים (rural council settlements) 0.24 / 0.72 km from the known centre. Distance sorting, nearby and Smart Radius all read `settlements` lat/lng through `fetchSettlementCoords` — origin correctness is what changed; the app code was not touched.
- Cleaner lifecycle: discovery idempotent (second discover: 48 new cases for the cohort's new subjects, 1,797 existing untouched, 6 closed externally); dedup by unique key; HIGH-only writes; MEDIUM no-write (schedules, images of weaker kinds released); archive reasons on every archive; human judgment (`requires_human_judgment` for conflicts / Palestinian localities); retry/backoff untouched; stale-write guards + **zero-row protection** tested; authorization failure explicit (`write_denied`).
- Monster: listing funnel recorded on every scan, detail traversal (Ra'anana 15/25 fetched, Carmiel 8/40), venue/place identity and pre-insert dedup untouched, pending-update supersede untouched, **pending-queue stacking fixed**, URL roles / occurrences untouched, approval gate extended.

## T. Idempotency
- Rescan of the 8 sources (T1 14:04:43Z): 21 pages / 4 changed / 6 AI calls; 2 genuinely new activities (different names), 42 "new" candidates of which **17 were open twins of first-scan candidates** (16 without fingerprint, 17 without event key) → defect fixed (§R), the 17 closed as `duplicate` with `archive_reason = duplicate_of_pending_candidate` (rows kept). No duplicate canonical activities; no duplicate occurrences; Cleaner discovery created no duplicate cases (unique key).
- Verification rescan of the two sources (T2 14:11:35Z, guard deployed): 23 rows — 14 new (no twin of any open candidate), 6 duplicates, SPNI `skipped_pending_in_queue = 24`; 0 activities created. Idempotency holds after the fix.

## U. Tests
- Node (`tools/import-tool`): **113 / 113 pass** (was 87; new: `temporalEvidence` 5, `zeroRowWrite` 9, `cityNotCanonical` 8, `itm` 3, classifier +1, missingCity +1 assertion).
- Deno (`_shared`): **164 pass + 1 FAIL** — the pre-existing escape-room expectation (`extraction.test.ts:120`, expects `review`, code returns `reject` for family + min_age 18; unchanged from `cfb9748`, not touched). New: temporal gate 2 tests, categoryHints 2 tests.
- `deno check scan-source/index.ts`: 16 type notices — **identical count on HEAD** (supabase-js generic typing), none introduced.
- RLS matrix executed as SQL role simulation (no-op updates). Integration: real production scans (3 rounds), real Cleaner runs (discover ×2, misclassified, images), real repairs verified by re-reading the DB.
- **New failures introduced: 0.**

## V. Production writes (exact)
| Write | Dry run | Applied | Guard |
|---|---|---|---|
| `settlements` lat/lng ← CBS | 1,268 classified | **193** (20 + 173), `geocode_source='cbs:bycode2024'` | `.eq(lat,old).eq(lng,old)` / `.is(lat,null)` |
| `settlement_aliases` | — | 10 curated + 32 learned − 5 revoked = 27 learned kept | existence-checked / all-rows-fit + tightened lexical rule |
| `locations.city` (city_not_canonical) | 1,006 classified | **726** | `.eq(city, stored value)`, region untouched |
| `activities` archived `outside_service_area` | 5 identified (Jordan ×4, Lebanon ×1) | **5** (guarded SQL on the exact ids) | `status='approved'` guard, rows kept |
| `incoming_activities` duplicates closed | 17 identified | 17 (`duplicate_of_pending_candidate`) | exact id set |
| `activity_images` (+ placeholder flag) | 413 classified | **199** inserted (1 flag write denied, recorded) | insert only when none; flag write verified |
| `activities` misclassified category/status | 18 candidates | 5 reclassified (9 to human) | `.eq(category,'גן שעשועים')`, verified |
| `activity_schedules` (schedule recovery) | 77 classified | **0** | HIGH only — none found |
| `cleaner_cases` | — | normal lifecycle writes of the runs above | leases |
No deletes. No LOW/MEDIUM automatic mutation. Every apply has a dry-run JSON with old values.

## W. Migrations
`supabase/0099_system_maintenance_rls.sql` (RLS grant to the importer on ingestion-owned rows; backward compatible, additive) — **written, NOT applied** (owner decision, twice). `supabase/0100_cleaner_city_not_canonical_issue.sql` (CHECK widening, additive) — **APPLIED after the program** with owner approval; discovery then recorded the 227 remaining non-canonical rows as `city_not_canonical` cases and the normal lifecycle closed all of them with reasons: **144 `city_unresolved`** (council-only / no named settlement), **83 `requires_human_judgment`** (46 conflicts + 37 Palestinian localities, decision deferred). 0 writes, 0 denied. Until 0100 the `discover.js` fallback (`skippedByConstraint`) kept discovery running.

## X. Deployments / restarts
- `scan-source` edge function deployed **twice** (16:5x gate + category hint / identity-less guard). Rollback = redeploy from `main`.
- Admin server: could not be started from the worktree (blocked); publishing through the Cleaner hand-back was therefore not exercised (it defers with an explicit error, never fakes success).
- Cleaner pilot task: disabled at 16:02, **re-enabled at the end of the program** (it still runs the MAIN tree's Cleaner code — without zero-row protection — until this branch is merged).

## Y. External costs
- Nominatim reverse geocodes: 846 attempts (815 ok) in the city dry run — all cached on disk (`logs/reverse-cache.json`), the apply and the final dry run hit the cache; CBS files fetched once (public, free). Anthropic (Haiku) extraction calls via the 18 production scans of this program: **24** (44 pages checked, 18 changed). Image probing: HEAD/partial GETs on candidate images (free). No SerpAPI, no Google Places, no new paid service.

## Z. Exact files changed (worktree, uncommitted)
Modified: `supabase/functions/_shared/extraction.ts`, `extraction.test.ts`, `supabase/functions/scan-source/index.ts`, `tools/import-tool/cleaner.js`, `cleaner/apply.js`, `cleaner/cityResolver.js`, `cleaner/discover.js`, `cleaner/fieldEnricher.js`, `cleaner/lifecycle.js`, `lib/canonicalSettlement.js`, `lib/playVenueClassifier.js`, `report-cleaner.js`, `reprocess-review-queue.js`, `tests/missingCity.test.js`, `tests/playVenueClassifier.test.js`, `THE-CLEANER.md`, `THE-MONSTER.md`.
New: `supabase/0099_system_maintenance_rls.sql`, `supabase/0100_cleaner_city_not_canonical_issue.sql`, `supabase/functions/_shared/categoryHints.ts` + `.test.ts`, `tools/import-tool/lib/temporalEvidence.js`, `lib/itm.js`, `audit-city-not-canonical.js`, `audit-settlement-centroids-cbs.js`, `recover-event-schedules.js`, `run-monster-cohort.js`, `reevaluate-learned-aliases.js`, `reference/cbs-settlements-2024.json`, `tests/temporalEvidence.test.js`, `tests/zeroRowWrite.test.js`, `tests/cityNotCanonical.test.js`, `tests/itm.test.js`, report JSONs (`settlement-centroid-cbs-*`, `city-not-canonical-*`, `schedule-recovery-*`, `monster-cohort-*`), this report. Main tree (`KidsApp`) verified untouched at the end (its own 27 uncommitted entries, branch `main`).

## AA. Remaining blockers
1. RLS migration 0099 not applied → 54 NULL-owner rows (and future rows of 3 NULL-creator sources) unrepairable by the Cleaner (now explicit).
2. ~~Migration 0100~~ — applied after the program; the 227 remaining rows are now explained Cleaner cases.
3. Service-area policy for Palestinian localities (37 rows, `requires_human_judgment` cases) — owner chose "decide later".
4. No Places key on the Cleaner machine → Google-playground type/hours verification impossible without paid calls.
5. Admin server not runnable from the worktree → Cleaner publishing not exercised in this program.

## AB. Remaining risks
- `locations_update` allows any authenticated user to modify any location row (found by the matrix; not changed because the app's submission flow uses it) — MUST FIX candidate.
- The pilot task runs the MAIN tree's Cleaner code (without zero-row protection) until this branch is merged.
- 1,075 Nominatim-derived centroids are validated only to ≤ 2 km (fine for city search; not authoritative provenance).
- MEDIUM `source_page` location evidence on municipal calendars can be the publisher's address — the Cleaner writes MEDIUM addresses; the shared-point guard catches most, not all.

## AC. Requirement coverage ledger
| # | Workstream | Status | Evidence / what remains |
|---|---|---|---|
| 1 | Worktree safety | COMPLETED | §B |
| 2 | Architecture mapping | COMPLETED | THE-CLEANER.md / THE-MONSTER.md read + extended |
| 3 | Live baseline | COMPLETED | §C |
| 4 | Legacy cohort reconciliation | COMPLETED | §D |
| 5 | Google playground verification | PARTIAL | name-rule classification + Cleaner pass done; type/hours verification BLOCKED (no Places key); 242 PARK/UNCERTAIN rows remain AMBIGUOUS for a person |
| 6 | Opening hours | NOT_APPLICABLE (no evidence) | schema can represent weekday hours; nothing written |
| 7 | Schedule-less 67 | COMPLETED (0 HIGH) | §F; 6 MEDIUM + 17 model suspects + 2 date-less one-time events for a person |
| 8 | Event misclassification | PARTIAL | 17 suspects identified with evidence; entity_type not changed (product semantics decision) |
| 9 | Permanent venues hours | ALREADY_SATISFIED | UNKNOWN kept; tests |
| 10 | Entity-type-aware approval gates | COMPLETED | one-time ALREADY_SATISFIED (tests); recurring/אירוע implemented + deployed + 33 held in production |
| 11 | OSM schedule-less preserved / enrichment feasibility | COMPLETED | §D, §H |
| 12–16 | Authoritative centroids | COMPLETED | §I; 2 conflicts + 46 unmatched explicit |
| 17–19 | Regional council / locality | COMPLETED | §J; 726 repaired; the 227 remaining are closed Cleaner cases with reasons (144 unresolved rural/council-only, 83 human: conflicts + Palestinian localities) |
| 20 | Split spellings | COMPLETED | §K |
| 21 | Border / locality leakage | COMPLETED (classification) / BLOCKED (policy) | §L |
| 22–25 | Cleaner writes / zero-row protection | COMPLETED (code+tests) | §M |
| 26 | Historical NULL cohort | BLOCKED | 0099 not applied (owner decision) |
| 27 | Prevention of unrepairable rows | BLOCKED | same |
| 28–33 | Missing images | COMPLETED (bounded) | §N |
| 34 | Image feedback into Monster | PARTIAL | clusters identified; detail traversal on image-poor sources = configuration proposal |
| 35 | Cleaner debt baseline | COMPLETED | §O |
| 36–39 | Validation cohort | COMPLETED | §P |
| 40 | Cleaner → Monster feedback | COMPLETED (2 fixes deployed) | §R; prior-activity reuse = next step |
| 41 | Idempotency | COMPLETED (defect found + fixed) | §T |
| 42–46 | Regressions | COMPLETED | §S |
| 47 | Test suites | COMPLETED | §U |
| 48 | Write discipline | COMPLETED | §V |
| 50 | External cost | COMPLETED | §Y |
| 51 | Social | NOT_APPLICABLE | untouched; `access.status = NOT_CONFIGURED` stands; no scraping |

## AD. Top five next steps
1. **MUST FIX** — apply `0099` (importer may maintain ingestion-owned rows); then run `cleaner.js --issue=misclassified` / `missing_venue` again: the `write_denied` cases resolve. (`0100` is applied.)
2. **MUST FIX** — tighten `locations_update` to owner-of-a-linked-activity / trusted roles after adapting `lib/submitActivity.js` (currently any user can edit any location).
3. **MUST FIX** — decide the service-area policy for Palestinian localities (103 rows) and the entity semantics of permanent offerings (17 rows); both are one script run away.
4. **PRODUCT / COVERAGE** — enable `detail_traversal` on the image-poor municipal sources and reuse the source's own prior location knowledge in scan-source (the two remaining avoidable clusters).
5. **PRODUCT / COVERAGE** — bounded Google Places details pass (types + opening hours) for the 242 PARK/UNCERTAIN playgrounds once a key is available.

---

## Final questions
1. **Already satisfied before this run**: one-time events cannot auto-approve without a date; permanent venues keep UNKNOWN hours; OSM playgrounds are exempt from schedule debt; Cleaner discovery is idempotent; archive reasons exist everywhere; the 7 name-rule misclassifications of 2026-09-17; the 2026-09-17 border-leak archives (Jordan/Gaza rows of the missing_city cohort).
2. **Google-playground problems still present**: 242 PARK/UNCERTAIN rows whose Google name says park/garden/commercial venue; no stored types or hours; 18 new name-rule cases (petting zoos, botanical gardens, pump tracks) and the קיפצובה duplicate.
3. **Safely reclassified / archived / unresolved**: 5 reclassified HIGH this run (+7 on 2026-09-17), 0 archived as non-places this run (+2 on 2026-09-17), 9 sent to human judgment (+4), 5 foreign-territory Google/OSM rows archived `outside_service_area`; **242 PARK/UNCERTAIN rows remain unresolved** (no Google types/hours stored, no Places key) plus the קיפצובה place duplicate.
4. **One-time event without a date → approved?** No (sanitize `תאריך` gating issue + `isPlausibleEventDate` + `missingTemporalEvidence`; Cleaner hand-back and review-queue reprocessing refuse too).
5. **Recurring event without days → approved?** No (new gate, deployed; `ימי פעילות` gating issue; 33 held in production).
6. **OSM playgrounds schedule-less and safe?** Yes (4,397 untouched; discover exempts playgrounds; gate null for places).
7. **Schedules fabricated?** None (0 schedule rows written).
8. **Centroids authoritative or explicitly unresolved?** 193 authoritative (CBS), 1,075 validated ≤ 2 km against CBS, 4 identity-by-coordinates, 2 conflicts + 46 unmatched + 20 without any centroid explicitly unresolved.
9. **Can a known bad centroid still influence distance?** No known one: every centroid > 2 km from its CBS point was replaced; the 20 without a centroid produce no origin (city search falls back to no distance, as before).
10. **`city` means**: the canonical user-facing settlement — `normalizeCityName(settlements.name_he)`; never a regional council; `region` is the product region.
11. **Council rows resolved to localities**: **561 of 692** (regional council → the actual settlement, each by reverse geocode naming the village with the stored council agreeing, or by the nearest dominant CBS settlement of that council ≤ 1 km).
12. **Council-only remaining and why**: 83 council-only evidence (the geocoder knows only the council and no CBS settlement is dominant within 1 km) + 29 with no named settlement + 16 single-signal + 50 conflicts — genuinely rural or contradictory; never snapped to the council.
13. **Split spellings via the shared resolver?** Yes — 160 normalizations; 10 curated aliases + learned aliases live in `settlement_aliases`.
14. **Palestinian values classified individually?** Yes — 55 values × coordinates + reverse geocode + CBS proximity; 14 Israeli localities repaired, 4 foreign archived, 103 rows flagged for the service-area decision, 0 bulk actions by script.
15. **Can the Cleaner repair system-owned published activities?** Bot-owned ones yes (matrix); NULL-owner ones **no** until 0099 — and it now says so.
16. **Can the Cleaner still silently affect zero rows and resolve?** No — `verifiedUpdate` re-reads after every 0-row write; tests cover venue link, address, coordinates, city, image flag, category/status, archive.
17. **Historical created_by=NULL cohort**: 54 unchanged; classified (43 retired Google scanner, 11 scan-source with NULL-creator sources); repair path defined (0099), not applied.
18. **Missing-image cases at start**: 413 open (432 historical).
19. **Safely repaired**: 199 (HIGH kinds only; 6 visually verified; 10 weaker candidates released; 1 flag write denied and recorded).
20. **Dominant remaining image failure classes**: only a site-default/generic image (144), no candidate on any page (26), candidates too small / logo / banner (24).
21. **Prevented upstream**: none by code in this program (image extraction unchanged); the lever is detail traversal on the image-poor sources (proposal).
22. **Cohort size**: 61 new canonical subjects (2 activities + 59 new candidates) from 8 sources / 105 candidates.
23. **TOTAL new debt / 100**: 127.9 (80 excluding the gate-created `ימי פעילות` class).
24. **AVOIDABLE / 100**: 23 (14 cases).
25. **Direction vs history**: TOTAL looks worse but is not comparable (definition + cohort); AVOIDABLE has no historical counterpart → **inconclusive**, with 23 / 100 as the new baseline.
26. **Largest remaining new-debt class**: missing_required_metadata (37, mostly the gate's `ימי פעילות`) tied with missing_location (37, municipal cards without a venue name).
27. **Avoidable duplicate in the cohort?** In the first scan no; the rescan stacked 17 identity-less pending twins → fixed and closed.
28. **Did rescan create duplicate activities / occurrences / cases?** Activities: 0 duplicates (2 genuinely new). Occurrences: 0. Cleaner cases: 0 duplicates (unique key). Pending candidates: 17 (defect, fixed, verified 0 on the third scan).
29. **Prior named regression cases correct?** Yes (§S), plus one new finding (קיפצובה duplicate place).
30. **New test failure?** None (Node 112/112; Deno 164 + the known 1).
31. **Escape-room Deno failure**: unchanged and still reproducible (`extraction.test.ts:120`, `reject` vs expected `review`) — untouched.
32. **Social correctly blocked?** Yes — untouched, `NOT_CONFIGURED`, no scraping, no bypass.
33. **Remaining issue that can materially corrupt user-facing location/distance?** The 20 settlements without any centroid (no origin, no wrong origin); 112 rural rows still show a council as city (no distance impact); `locations_update` open to any user (integrity risk, not automated corruption).
34. **Remaining issue where the Cleaner believes a repair succeeded when it did not?** None known in the worktree code; the MAIN tree's pilot still runs the old code until merge.
35. **Has the feedback loop reduced AVOIDABLE new debt?** Not yet measurable: the two upstream fixes were deployed after the measurement; the verification rescan could not re-measure (pages unchanged → no re-extraction). Evidence of prevention exists for the gate (33 holds) and the pending guard (24 skips); AVOIDABLE reduction remains to be measured on the next changed-page cohort.
