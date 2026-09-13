# Turu activity-ingestion platform — Phase 1 close-out report (2026-09-13)

Phase 1 = foundation + first national expansion of the ingestion platform (plan `cosmic-tinkering-heron`).
This report is a **milestone measurement, not a completion claim**: the goal remains a continuously
expanding national ingestion platform that measures where it is weak and closes gaps systematically.
Phase 2 starts from the "Phase 2 entry point" section at the end.

Data sources for every number here: `coverage-report-baseline-before-phase1.json` (BEFORE, 11:01Z),
`coverage-report-2026-09-13.json` (AFTER, 14:42Z; frozen as `coverage-report-phase2-baseline.json`),
`review-queue-classification-2026-09-13.json`, `node compare-coverage.js`, live DB queries during close-out.

---

## 1. BEFORE → AFTER (whole system)

| Metric | BEFORE | AFTER | Δ |
|---|---|---|---|
| Sources (registry rows) | 11 | 135 | +124 |
| Active sources | 11 | 103 | +92 |
| Paused sources (visible, with reason) | 0 | 32 | +32 |
| Social-only source rows (FB/IG, disabled, visible) | 0 | 7 | +7 |
| Venues (canonical WHERE) | 0 | 58 | +58 |
| Live activities (status approved) | 5,060 | 5,447 | +387 |
| Live non-playground activities | 115 | 501 | +386 |
| Live dated activities (one-time / recurring) | 3 | 322 | +319 |
| Activities linked to a venue | 0 | 167 | +167 |
| Activities with `source_id` provenance | 16 | 403 | +387 |
| `activity_sources` provenance rows | 0 | ~5,300 (backfill 5,254 + new) | |
| Coverage gaps (gap engine) | 61 (9 high) | 35 (3 high) | −26 |
| Source health | 11 healthy | 101 healthy / 32 auto-paused / 2 failing | |
| Review queue (open) | n/a (not measured) | 707 (488 new + 219 update) | classified below |
| Auto-approved / approved from queue, last 30d | – | 629 | |
| Duplicates prevented by the scanner, last 30d | – | 97 | |

### By region (active sources | venues | non-playground live activities)

| Region | sources | venues | non-PG activities |
|---|---|---|---|
| הצפון והעמק | 0 → 18 | 0 → 5 | 14 → 66 |
| חיפה והקריות | 2 → 8 | 0 → 8 | 7 → 15 |
| השרון | 2 → 13 | 0 → 9 | 42 → 110 |
| גוש דן והמרכז | 4 → 23 | 0 → 18 | 28 → 205 |
| ירושלים והסביבה | 2 → 8 | 0 → 7 | 7 → 43 |
| השפלה והדרום | 1 → 25 | 0 → 10 | 17 → 62 |
| יו"ש והבנימין | 0 → 1 | 0 → 0 | 0 → 0 |
| (no region: national aggregators/chains) | 0 → 7 | – | – |

### By source family (active): farm 6→3, museum 4→6, mall 0→26, municipality 0→42, ticketing 0→5, library 0→2, aggregator 0→6, theater 0→2, community_center 0→8, attraction 0→3.

### By category (non-playground live, largest changes): הצגה 1→72, שעת סיפור 0→68, אחר 6→55, פעילות קהילתית 1→48, יצירה 1→30, מוזיקה 0→28, סדנה 5→23, מוזיאון לילדים 7→19, משחקייה 8→19, ספורט 6→13, טבע 4→11, ריקוד 0→8, ספרייה 0→7, מדע 2→6, בישול 0→5, בעלי חיים 2→5. Still thin: פעילות מים 4, קולנוע לילדים 4, בריכה 2, פעילות עירונית 0.

---

## 2. Audit findings — status

| # | Finding (BEFORE) | Status | What was done |
|---|---|---|---|
| C1 | AI extraction broke on Hebrew abbreviations (unescaped `"` in JSON) — 5/11 sources failing for a week | **Fixed** | `repairHebrewGershayim` + `repairUnescapedQuotes` (Deno `_shared/extraction.ts`, Node mirror), retry-once, prompt tells the model to use `״`; tests in both runtimes |
| C2 | `activities.source_id` never written (0/5,209) → "missing from source" dead | **Fixed** | Every creation path sets it; backfilled where the incoming row carried it (16 → 403 live rows) |
| C3 | No canonical venue; `locations` is 1:1 junk labels | **Fixed (foundation)** | `venues` + `venue_aliases` (58 venues), alias resolution in scanner + approve path; 167 activities linked. Playgrounds keep `venue_id = null` by design |
| H1 | City normalized only after matching | **Fixed** | normalize on both sides before similarity |
| H2 | Auto-approve ignored source trust / date clarity | **Fixed (policy)** | trust-gated auto-publish (≥ 80 or `is_trusted`, zero gating issues, one-time date ≤ 180d, not a stale repost) + child-relevance gate |
| H3 | No failure backoff / auto-pause | **Fixed** | health model healthy → failing → backed_off → attention_required → auto_paused (only 404/403 kinds, never priority ≥ 8), reactivate endpoint |
| H4 | Multi-source provenance impossible | **Fixed** | `activity_sources` junction (created / seen / updated relations), written on create, duplicate and update |
| H5 | Postal codes leaking into `city` | **Fixed** | `splitFormattedAddress`, migration 0080 |
| H6 | Extraction overflowed `max_tokens` on long pages | **Mitigated** | 16k tokens, 30-activities cap per page, DOM-free text path for >400 KB pages (Azrieli) |
| M1 | Matching/naming logic duplicated across Node/Deno/Python | **Open (documented)** | copies kept in sync where touched; mirror tests assert parity |
| M2 | `last_verified_at` meaningless | **Partially** | `last_seen_at` now maintained by scans; no freshness UI |
| M3 | Mixed adult/child municipal calendars | **Fixed** | `assessChildRelevance` (audience field + adult-marker list); adult items rejected before the queue |
| M4 | Recurring events never expire | **Open (debt)** | no season / valid-until model |
| L1 | `sources.type` only a fetch enum | **Fixed** | `source_kind`, `publisher_*`, `venue_id`, `priority`, `discovery_batch`, `strategy` |
| L2 | No venue merge/alias admin | **Fixed (minimal)** | `/venues` page: list, alias add, merge (loser kept inactive with `merged_into`) |
| L3 | Deno tests never ran | **Fixed** | Deno as devDependency; `npm test` = 7 Node + 69 Deno, green |
| new | **Duplicate activities from twin queue rows** (found during close-out) | **Fixed + cleaned** | see §5 |
| new | `/api/incoming` 500 once the queue linked > 700 activities (`in()` filter URL too long) | **Fixed** | chunked `fetchByIds` |

Schema added (all additive, applied to prod): `0076_venues`, `0077_sources_registry_fields`, `0078_activity_sources`,
`0079_event_fingerprint`, `0080_fix_postal_code_cities`, `0081_local_relay_strategy`. No rows deleted anywhere.

---

## 3. Source registry & source health (AFTER)

- **Registry**: 135 sources in `source-manifest.json` (74 initial verified batch + 61 from the 2026-09-13 gap-driven discovery pass #2), 58 venues. Seeding is idempotent (`seed-venues-and-sources.js --apply`).
- **Health**: 101 healthy, 32 paused with an explicit reason, 2 failing (one 404, one WAF). Failure kinds seen: gone_404 ×3, access_403_waf ×1, unknown ×1.
- **Paused, by reason (all visible in admin, none dropped)**:
  - `blocked_or_waf` (15): iShow South aggregator, azrieli.com corporate, ירושלים ברשת, מתנ"ס מתן, רשות הטבע והגנים, מוזיאון המדע בלומפילד, מתנ"ס גן יבנה, BIG Fashion Nazareth, עיריית ירושלים, תרבות אשדוד ×2, מתנ"ס מודיעין עילית, עזריאלי חיפה, עיריית קריית שמונה, עיריית קריית גת.
  - `js_only` (12): BIG chain, עיריית נצרת, מרכז קהילתי עמק חפר, קניוני עופר, מוזיאון ישראל ×2, עיריית רמת גן, iTravelJerusalem, עיריית אשקלון, plus 3 social page rows.
  - `unsupported_platform` (4): Facebook/Instagram rows for רותם, רוטשטיין ×2, גרנד קניון ב"ש.
  - `auto_paused` (1): Kenyonim.com aggregator.
- **Cloud-IP blocking is a platform constraint**: many municipal/venue sites (Herzliya, Modi'in, Haifa/Incapsula, Givatayim, Ganei Tikva, Even Yehuda, Lev HaSharon, Nof HaGalil, Madatech, G-City, Havayot, KS library) serve full HTML to a local IP but 403/timeout for Supabase edge IPs. Mitigation shipped: `relay-scan.js` (`--mark-blocked --all`) fetches locally and posts page text via `relay_scan_source` RPC; one relay pass produced ~250 events. **Dependency**: the relay runs only while the admin machine runs — not yet scheduled.

---

## 4. Source yield — active ≠ healthy ≠ productive

Productivity over the last 30 days (`report-coverage.js` → `sourceYield`, `productivity`):

| Class | Count | Meaning |
|---|---|---|
| productive | 49 | at least one approved/live activity |
| queue_only | 28 | scans find items, nothing approved yet (untrusted trust score, or waiting in review) |
| zero_yield | 23 | scans succeed (HTTP 200) but 0 activities extracted |
| failing | 3 | scans error (מוזיאון הילדים חולון unknown ×4, סי מול אשדוד 404, עיריית נתניה WAF) |
| paused | 32 | see §3 |

By region (active: productive / queue-only / zero-yield / failing | created 30d | pending in queue):

| Region | active | p / q / z / f | created | pending |
|---|---|---|---|---|
| הצפון והעמק | 18 | 7 / 5 / 6 / 0 | 52 | 33 |
| חיפה והקריות | 8 | 4 / 2 / 2 / 0 | 13 | 34 |
| השרון | 13 | 8 / 2 / 2 / 1 | 68 | 64 |
| גוש דן והמרכז | 23 | 12 / 5 / 5 / 1 | 182 | 97 |
| ירושלים והסביבה | 8 | 6 / 2 / 0 / 0 | 42 | 48 |
| השפלה והדרום | 25 | 12 / 6 / 6 / 1 | 78 | 265 |
| יו"ש והבנימין | 1 | 0 / 0 / 1 / 0 | 0 | 0 |
| national (no region) | 7 | 0 / 6 / 1 / 0 | 0 | 166 |

By family (active → productive, created 30d): municipality 42 → 22 (196), mall 26 → 6 (43), community_center 8 → 4 (30), museum 6 → 4 (36), aggregator 6 → 0 (0), ticketing 5 → 4 (50), farm 3 → 2 (2), attraction 3 → 3 (12), library 2 → 2 (37), theater 2 → 2 (29).

**Top productive sources**: עיריית רמת השרון 42 live, עיריית גבעתיים 34, עיריית רעננה (tickets) 26, היכל התרבות כרמיאל 25, עיריית הרצליה 23, בית אריאלה 22, מוזיאון ארץ ישראל 19, תיירות אשדוד 19, קניון כפר סבא הירוקה 18, עיריית גני תקווה 17, ספריות חוויות רחובות 15.

**Zero-yield active sources (23) — the most valuable fix list, because they are already registered big-city sources**: עיריית תל אביב-יפו, עיריית פתח תקווה, עיריית ראשון לציון, עיריית חולון, עיריית באר שבע, עיריית אשדוד + החברה העירונית אשדוד, עיריית לוד, עיריית נהריה, עיריית טבריה, עיריית כרמיאל, עיריית נוף הגליל, מועצה אזורית שומרון, תיירות כפרית לב השרון (4 scans, 0), G-City chain, קניון שבעת הכוכבים, עזריאלי הנגב (6 scans, 0), מרכז רוטשטיין page, ממלכת הילדים (מוזיאון הכט), החברה למרכזים קהילתיים צפת, מתנ"ס טירת כרמל, החברה העירונית אשקלון, זהר הצפון. Likely causes (to verify per source in Phase 2 pass 1): seed URL is a landing page rather than the events listing, listing rendered client-side, or events on a sub-path / JSON endpoint.

**Queue-only sources with ≥ 10 pending**: קניוני עזריאלי (chain) 40 + מרכז פעילויות 18 (trust 75), מה קורה aggregator 39 (55), קצת תרבות 35 (55), Ticketsi 32 (55), קניון רמות ירושלים 24 (80, but items lack city), קופת בראבו אשקלון 24 (60), מועצה מקומית אבן יהודה 14 (85), דיזנגוף סנטר 12 (75).

---

## 5. Review queue — composition and the duplicate incident

### 5a. Re-evaluation under the current policy
`reprocess-review-queue.js --apply` (goes through `POST /api/incoming/:id/approve` — venue resolution, provenance, fingerprint, Places-shape mapping — never a shortcut). Cumulative result of the two runs (previous session + this close-out): 629 items approved from the queue in 30d; this close-out run approved 15 and rejected 8 (5 past-dated, 3 adult audience); a second dry run afterwards found 0 actionable items (1 newly-scanned item arrived meanwhile — the cron keeps feeding the queue, which is intended).

### 5b. Duplicate incident (found in close-out verification, fixed at the root)
End-to-end verification of the approved items found **44 fingerprint groups / 57 extra activity rows**, all created by the bulk approval, all within one source per group. Two root causes:
1. **Twin queue rows across scans** (25 groups): cron + relay + scan-now hit the same page minutes apart; `scan-source` deduplicated only against *approved activities*, not against rows already *waiting in the queue*.
2. **Same event twice in one scan** (18 groups): a page lists the event twice (two dates' listings, or two sections) and nothing deduped within the scan.
Fixes shipped: (a) `scan-source` keeps a per-scan fingerprint set and checks pending `incoming_activities` by fingerprint before queuing (deployed); (b) `/api/incoming/:id/approve` now has an `event_fingerprint` guard next to the `google_place_id` guard → 409 + marked duplicate + provenance recorded (verified live on a real twin); (c) `reprocess-review-queue.js` pre-checks fingerprints against activities and within its own batch. Cleanup: `dedupe-fingerprint-activities.js --apply` archived the 57 losers (reversible, no deletes), moved 57 provenance rows to the keepers, copied 6 images, re-pointed 57 queue rows to the keepers as rejected-duplicate. Post-cleanup verification: 0 non-archived fingerprint collisions.

### 5c. The remaining 707 open items, classified by reason (`classify-review-queue.js`)
Primary reason = first matching blocker; one per item. Classification uses only fields the rows actually carry.

| Primary reason | Count | % | Automatable? | Needs human? | Notes |
|---|---|---|---|---|---|
| update_to_existing_activity | 212 | 30.0 | partially | when name/date/venue change | scanner matched an existing activity with a diff; most diffs are `start_time/description/one_time_date` (kiryat gat matnasim 71, היכל התרבות אשקלון 39, עיריית יבנה 22, חיפה 16) |
| missing_address_or_location | 181 | 25.6 | partially | often | no city 95 / no location_name 86; dominated by ticketing aggregators (קצת תרבות 35, Ticketsi 32) and ספריות חוויות רחובות 23, רמת השרון 16 |
| ambiguous_event | 137 | 19.4 | no | yes | audience not stated on the page (101) or unknown (23); מה קורה 18, חוויות רחובות 12, דיזנגוף 8 |
| incomplete_required_metadata | 73 | 10.3 | partially | sometimes | category missing 59, date missing 13 (עזריאלי chain 17, מוזיאון ארץ ישראל 9, עיריית עכו 8) |
| untrusted_source_policy_hold | 70 | 9.9 | yes (trust promotion after quality review) | yes, by policy | עזריאלי 21+18 (trust 75), מה קורה 17 (55), תיאטרון ילדים אשקלון 7, בראבו 5 |
| genuinely_requires_human_judgment | 20 | 2.8 | no | yes | city missing on an otherwise complete item (קניון רמות ירושלים 19) |
| adult_or_irrelevant | 7 | 1.0 | yes | no | עיריית חיפה — will be auto-rejected on the next reprocess run |
| event_too_far_ahead | 5 | 0.7 | yes (re-check when inside 180d) | no | dates 2027-03..06 |
| other | 2 | 0.3 | – | – | עיריית בת ים 1, עיריית יבנה 1 — inspect manually |
| duplicate | 0 | 0 | – | – | after the fingerprint guard, none remain |
| expired_event | 0 | 0 | – | – | rejected by the re-evaluation |

Non-blocking weaknesses (an item may carry several): missing_price 540 (76%), missing_image 395 (56%), unresolved_venue 368 (52%), audience_not_extracted 234 (33%), missing_city 95 (13%).

**Unclassifiable with current data (reported, not guessed)**:
- `missing_coordinates`: incoming rows never carry lat/lng (always null) — coordinates are resolved by geocoding at approval time. To classify this we would need geocode-at-scan or a stored geocoding attempt result.
- `low_confidence_extraction`: `confidence_score` is 0 for every `match_type=new` row (it is only computed for update/duplicate matches). Would need per-field extraction confidence from the LLM or a second-pass consistency score.
- `blocked_source`: 0 — every open item belongs to an active, healthy source (paused sources stop feeding the queue).

Nothing was deleted or archived to shrink the queue.

---

## 6. Venues layer
58 canonical venues, alias matching (normalized alias + same normalized city, no cross-city fuzz). 167 live activities linked. **Unresolved venue clusters** (labels the scanner keeps seeing without a canonical venue, 30d detections): היכל התרבות קרית גת 44, ספרייה | רמת השרון 32, בית רחל וישראל פולק (קריית גת) 15, מוזיאום ארץ ישראל 14 + מוז״א 11, היכל התרבות יד-לבנים רעננה 13, בית אריאלה 12, דיזנגוף סנטר 12, מרכז קהילתי שדה בוקר (גבעתיים) 10, מרכז פלאים (גני תקווה) 10, טכנודע חדרה 9, המשכן למוסיקה רעננה 9, מרכז קהילתי שז״ר 9, היכל התרבות יבנה 8, מגדל שלום 7. Creating these ~15 venues (+aliases) is cheap and improves dedup, venue-aware matching and the app's WHERE data at once.

---

## 7. SOCIAL INGESTION GAP (high-priority follow-up)
Facebook/Instagram pages are not scrapable by plain fetch (FB serves a JS shell with no post text; IG refuses). No protections were bypassed. Affected today: **4 venues whose programming exists only on social** (גרנד קניון באר שבע, מרכז קהילתי רותם / מ.א. מנשה, קניון גירון אשקלון, ביג פאשן נצרת) plus מרכז רוטשטיין (static site, FB/IG programming) — registered as venues with 7 disabled `facebook`/`instagram` source rows (`unsupported_platform`) so the gap stays visible in admin and in the gap engine. Expected impact: local commercial centers and community centers — precisely the long-tail family the platform is weakest in. Legitimate options, in recommended order: (1) Meta Graph API with page-owner consent (official partnerships with the venues; Page Public Content Access needs app review); (2) venue-provided feeds — ask each venue for an ICS/RSS/JSON events feed or a Google Calendar (most matnasim already have one); (3) a consented browser-based collector operated by the venue itself. Recommended: start with (2) for the 5 venues (an email template + a `feed` strategy on `sources`), pursue (1) for chains.

---

## 8. INITIAL VERIFIED BATCH vs KNOWN DISCOVERY BACKLOG
- **Initial verified batch**: 74 manifest sources (fetch-tested: 200 + Hebrew text + event keywords) — malls/chains (Azrieli per-mall, Amot ×8, G-City, Renanim, Arena, HaYeruka KS, Ramot, Cinemall, Dizengoff), municipalities (Herzliya, Haifa, Modi'in, Tel Aviv, Givatayim, Ramat HaSharon, Petah Tikva, Holon, Rishon, Beer Sheva, Raanana, Kfar Saba, Shoham, Even Yehuda, Ganei Tikva, Nof HaGalil…), libraries (Beit Ariela, Havayot), community centers, museums, farms.
- **Discovery pass #2 (2026-09-13, gap-driven)**: 61 more sources (Judea/Samaria council, Jerusalem, North matnasim/libraries, South theaters); last candidates file: 20 URLs → 15 scrapable, 3 blocked, 2 js_only.
- **Known backlog (not yet searched or not yet scrapable)**: (a) regions: יו"ש והבנימין (Ariel, Efrat/Gush Etzion, Beitar Illit, Karnei Shomron, Kiryat Arba, Binyamin council), חיפה והקריות (Kiryat Bialik/Motzkin/Yam, Nesher, Kiryat Ata events), Arab towns of the North (Sakhnin, Shefa-Amr, Umm al-Fahm, Tamra) and the Negev (Rahat) — no source at all today; (b) families: libraries nationally (2 active), nature (0: KKL/parks.org.il blocked), organizers/recurring producers (0), theaters (2), neighborhood commercial centers (long tail), tourism bodies; (c) JS-only sites needing an adapter (Ofer chain, BIG chain, Israel Museum, Ramat Gan, Ashkelon, Nazareth); (d) WAF-blocked sites needing the relay (15). **SerpAPI free quota is exhausted** — discovery runs on manual web search + `discover-sources.js --urls=<file>` verification until the plan is upgraded (user decision).

---

## 9. Architectural limitations and technical debt (unchanged unless noted)
- Three runtimes (Node admin, Deno edge, Python discovery) with mirrored logic — kept in sync by mirror tests, not unified.
- Relay for WAF-blocked sources depends on the admin machine; needs a scheduled task or a small always-on relay.
- Recurring events have no season/valid-until; `last_verified_at` is not a freshness signal.
- 2,071 orphan `locations` rows (harmless; safe cleanup query documented in the plan).
- Ticketing aggregators publish shows without a city — requires venue resolution from the venue name (venue registry growth) before they can auto-publish.
- Scanner confidence is not computed for `new` items — no per-item extraction-quality signal.

---

## 10. PHASE 2 ENTRY POINT — measured gaps, ranked by expected coverage impact

Baseline for all Phase 2 checkpoints: `coverage-report-phase2-baseline.json` (never overwritten; each pass writes `coverage-report-phase2-checkpoint-<n>.json` and is diffed with `compare-coverage.js`).

| Rank | Gap (measured) | Why it ranks here | Next action |
|---|---|---|---|
| 1 | **23 zero-yield active sources**, incl. the biggest cities (Tel Aviv, Petah Tikva, Rishon, Holon, Beer Sheva, Ashdod ×2, Lod, Nahariya, Tiberias, Karmiel, Nof HaGalil, Shomron council) | already registered, HTTP 200, 0 events — a seed-URL/adapter fix per source unlocks whole cities without discovery | fetch each seed page, find the real listing URL / JSON endpoint / pagination, fix `seed_url`/strategy in the manifest, rescan, measure |
| 2 | **28 queue-only sources, 166+ pending on national aggregators/chains** (Azrieli 58, מה קורה 39, קצת תרבות 35, Ticketsi 32, רמות 24, בראבו 24) | items already extracted; conversion to live needs venue/city resolution + trust decisions, not new sources | resolve venue clusters (§6), add city via venue, quality-sample each source and raise trust to ≥ 80 where it holds; re-run reprocess |
| 3 | **יו"ש והבנימין: 1 source, 0 activities; חיפה והקריות: 8 sources, 15 activities** | the two high-severity geographic gaps in the gap engine | discovery pass (manual search + `--urls=` verify): Ariel, Efrat/Gush Etzion, Beitar Illit, Karnei Shomron, Binyamin council; Krayot municipalities/matnasim, Nesher, Haifa via relay |
| 4 | **Thin families nationally**: library 2, theater 2, nature 0, organizer 0; no community_center source in השרון/גוש דן, no library in North/Haifa/Sharon/Jerusalem | libraries and matnasim are the richest child-event publishers per source (37 live from 2 library sources) | discovery pass by family: municipal library networks (Sifriyot), matnas networks (החברה למתנ"סים), theaters for children, KKL/nature (non-blocked hosts) |
| 5 | **Review-queue automation**: 212 update items, 73 metadata-incomplete, 137 ambiguous-audience | 30% of the queue is diffs to existing activities; auto-applying additive diffs removes routine human work | auto-apply update diffs limited to additive/soft fields; re-extract with category hints; keep ambiguous for humans |
| 6 | **15 WAF-blocked + 12 JS-only sources** | big publishers (Jerusalem municipality, Israel Museum, Bloomfield, Ofer/BIG chains) | schedule `relay-scan.js` (Task Scheduler); JSON-endpoint adapters for the SPAs where a public JSON exists |
| 7 | **Social-only venues (5)** | long-tail local coverage | feed requests to venues (§7) |
| 8 | **Thin categories**: פעילות מים 4, בריכה 2, קולנוע לילדים 4, פעילות עירונית 0 | app taxonomy coverage | target country clubs/pools, cinematheques' kids programs, municipal "happenings" pages in pass 1/4 |
| 9 | Settlement-level playground discovery (scanner paused at 1100/1204) | deferred; bring back only if Phase 2 measurements show settlement gaps are high-impact | – |

Phase 2 loop per pass: state the measured gap → discover → verify → register → scan → measure yield → checkpoint snapshot → next gap. Optimize for **useful live activities**, not registered-source count.
