# THE MONSTER (המפלצת) — Turu's national discovery & ingestion platform

Document of record for the platform that discovers, scans, extracts, normalizes, deduplicates and ingests children's activities across Israel. Sibling system: **THE CLEANER** (`THE-CLEANER.md`) — post-ingestion exceptional repair. Same canonical infrastructure, separate responsibilities; no table or service is renamed for the nicknames.

Status: wave 1 (2026-09-14) implemented — listing→detail enrichment as a first-class bounded capability, stable EVENT identity, per-performance OCCURRENCES, URL roles on provenance. Plan of record: `~/.claude/plans/the-monster-consolidation-lovely-meadow.md`.

## 1. Architecture (what runs today)

```
sources (registry: strategy generic_html | api_json | local_relay; adapter_config)
   │  pg_cron scan-due-sources */15 → _dispatch_source_scan → edge fn scan-source   (local_relay: relay-scan.js → RPC relay_scan_source)
   ▼
scan-source/index.ts
   fetch seed (+ ≤8 discovered listing pages)  →  text hash vs source_page_snapshots (unchanged ⇒ skip)
   ├─ detail-link discovery (_shared/detailLinks.ts): card anchors (text + aria-label/title), "פרטים נוספים", event-shaped hrefs,
   │   adapter link_selector / url_pattern; listing-shaped URLs, nav, alternate-language sections never count
   ├─ detail PREFETCH (concurrent with the AI call; un-enriched links first; ≤ max_pages(≤12)/page, ≤24/scan, 105 s, 8 s each)
   ├─ AI extraction (Haiku 4.5, temperature 0, ≤4 × 18k windows, 60 s budget)
   ├─ pass 1: sanitize → JSON-LD prefill → associate ONE detail link per candidate (≥0.7 name words; a link claimed by two
   │   different names is a shared page → nobody gets it) → detail EVIDENCE (_shared/detailEvidence.ts, deterministic, no AI):
   │   occurrences (Hebrew textual dates, own time / provider id / purchase link), price tiers, street address, ages, og:image,
   │   event-level registration action → fill-null merge; page must NAME the candidate; failure never discards the listing candidate
   │   → listing twins (same event, several dates on one page) folded into one candidate with occurrences
   ├─ pass 2: venue (curated aliases) → event_fingerprint (legacy occurrence key) → event_key (EVENT identity)
   │   → exact fingerprint pre-check (+ enrichment-only diff) → event match ladder E1/E2 (eventIdentity.ts)
   │   → pending-queue checks (fingerprint / event_key) → similarity (computeConfidence) → new | update | duplicate
   │   → auto-approve (trusted source, no gating issue, verified location) or incoming_activities row
   └─ provenance activity_sources with url_role listing / detail; missing-from-source counters; source health; detail_metrics
```

Admin (Node, `server.js`): `/api/incoming/:id/approve` (saveNewActivity — N occurrence rows, event_key, official_url only from an explicit registration action; applyIncomingUpdate — occurrence insert-missing, verified recurring→one_time conversion, address replacement of derived addresses), `/api/sources` (adapter_config editable), `/sources` detail-yield badge, `/incoming` occurrences + price evidence.

Coverage: `report-coverage.js` (region × family × category, per-source yield/productivity, **detailYield** per source, `detail_zero_yield` gap).

## 2. Identity model (binding)

| Layer | Key | Where | Rules |
|---|---|---|---|
| VENUE / PLACE | `venues.id` via `venue_aliases` (exact normalized alias + city) ; `google_place_id` (unique on activities) | `_shared/venues.ts` | never a fuzzy auto-link; place identity ≠ event identity |
| EVENT | `activities.event_key` + `event_key_kind` — `ext:<source>:<provider id>` > `url:<verified detail URL>` > `pk:<source>:<key>` > `tvs:<exact normalized title>\|v:<venue>\|s:<source>` | `_shared/eventIdentity.ts`, Node twin `lib/eventIdentity.js` | stable across occurrences; `tvs` is a conservative fallback (non-generic titles only, exact title, never outranks the others); a shared listing URL is never identity |
| OCCURRENCE | `activity_schedules` row (`activity_id`, `one_time_date`, `start_time` [+ `external_id`, `booking_url`]) — unique per (activity, date, time) | migration 0091 | each performance keeps its own time; never deleted by the Monster; expiry only after the LAST date |
| SOURCE | `activity_sources` (`activity_id`, `page_url`, `relation`, `url_role` listing/detail/booking/other) | 0078 + 0091 | one event, many sources; legacy rows have `url_role` NULL (unknown, never identity) |

`activities.event_fingerprint` = LEGACY first-occurrence fingerprint (name|venue-or-city|date-or-days|HH:MM), kept for the exact pre-checks and never rotated. **It is not the multi-occurrence event identity — do not build on it.**

Event match ladder (`findEventMatch`): E1 same `event_key` (a `url` key also needs title overlap ≥0.5 or same venue, and the same source; a stronger key on either side that disagrees ⇒ different event); E2 (rows created before detail traversal) exact title + same venue + same source + same time + ≥2 explicit performances from a detail page. Never matches an event whose dates are all past.

URL roles: listing URL (discovery) → `source_url` / `activity_sources.url_role='listing'`; event detail URL → `activity_sources.url_role='detail'` (and the `url:` event key when verified); per-performance purchase links → `activity_schedules.booking_url`; `official_url` (registration) only from an explicit event-level booking/registration action — never the detail page.

## 3. Legacy systems — lifecycle

| System | State | Notes |
|---|---|---|
| Settlement gap scanner `scan-settlement-gaps` + `settlement_scan_*` + `/settlement-review` | **RETIRED** | 1204/1204 settlements done, self-disabled (cron row harmless). Knowledge kept: `public.settlements` (1,316 + centroids), `settlement_aliases`, 3-zone place-matching thresholds, `houseNumberMatchScore`, per-SKU cost model, 282 review cases (263 resolved by the Cleaner). |
| `tools/playground-discovery/*` (Python) | **FROZEN** | superseded by the edge fn; artifacts = historical audit data (5.7k place-id review CSVs, raw discovery JSONL). |
| OSM import / audit / twin reconcile | **FROZEN** | one-shot; `reconcile-playground-twins.js` stays a Cleaner tool. |
| SerpAPI discovery (`discover-sources.js`, `approve-candidates.js`, `seed-venues-and-sources.js`, `source-manifest.json`) | **ACTIVE** (manual) | the Monster's discovery strategy; manifest = registry-as-data (now carries `adapter_config`). |
| Admin `/import` manual discovery | **ACTIVE / UNTOUCHED** | |
| THE CLEANER | **ACTIVE** (Windows task every 20 min) | separate system; shares `lib/pageExtract.js`, venues, provenance, matching mirrors. |
| Coverage / queue tooling | **ACTIVE** | `report-coverage.js` now reports detail yield. |
| `dedupe-fingerprint-activities.js` | ACTIVE (occurrence-level twins) | `merge-occurrence-duplicates.js` handles same-event-different-date groups (HIGH only). |
| Naming/city migrations, `_continuous-enrich.sh` | **FROZEN** | |

## 4. Decision matrix (wave 1)

| Capability | Monster before | Legacy | Action taken |
|---|---|---|---|
| Listing→detail traversal | configured on 4 sources, 0 fields filled | relay `--detail-pages`, Cleaner `pageExtract` | GENERALIZED: aria-label/card anchors, quality gates, prefetch, relay detail pages as evidence |
| Stable event identity / occurrences | none (fingerprint = occurrence) | none | ADDED (`event_key`, N schedule rows, occurrence diff, verified conversion) |
| Price tiers | single amount | none | ADDED (evidence in `extracted_data.price_evidence`, canonical child price) |
| URL roles | not modeled | — | ADDED (`activity_sources.url_role`, `activity_schedules.booking_url`) |
| Detail provenance | edge only | — | Node parity |
| Detail yield observability | written, unread | settlement pagination metrics | `report-coverage.js detailYield`, `/sources` badge |
| Enrichment on exact re-detection | discarded (duplicate) | — | enrichment-only update diff |
| Settlement normalization (`settlements` + aliases) | `normalizeCityName` only | settlement scanner | **wave 2** |
| Budget intelligence (per-SKU cost, pre-flight abort) | none | settlement scanner | **wave 2** |
| Exact Place-ID protection | unique index + guard | fresh pre-check | keep |
| Place distance matching | proximity signal | `placesDiscovery.ts` | keep specialized (place ≠ event) |

## 5. Operating the detail capability

- Enable per source: `sources.adapter_config.detail_traversal = { max_pages (≤12), allow_hosts[], link_selector?, url_pattern? }` (admin `/sources` form, manifest + `seed-venues-and-sources.js --apply`).
- Bounds: ≤ max_pages per listing page, ≤ 24 per scan, 105 s, 8 s per page, depth 1, one fetch per URL per scan, un-enriched links first.
- Relay (`relay-scan.js`): detail pages travel with their listing page as `{kind:'detail', parent_url, html}` and are evidence only.
- Measure: `node report-coverage.js` → `detailYield` (links / attempted / fetched / failed / shared / title-mismatch / filled by field); `source_scan_logs.detail_metrics` per scan.
- Historical consolidation: `node merge-occurrence-duplicates.js [--verify-online] [--apply]` — HIGH only; MEDIUM is never merged.

## 6. Wave 2 backlog (ranked)

1. Settlement normalization: `public.settlements` + `settlement_aliases` as the canonical city resolver inside `normalizeCityName` / venue matching (border-leak guard).
2. Budget accounting for Anthropic / SerpAPI calls (per-scan cost, pre-flight ceilings) — port of the settlement scanner's per-SKU model.
3. Unique partial index on `activities.event_key` (approved rows) once the historical groups are consolidated.
4. Occurrence display polish in the app (card shows "+N מועדים"; detail screen lists upcoming performances) and user-submitted multi-date events.
5. Extraction recall on dense listings (32-card pages return 15–21 events per call): smaller windows or per-card extraction.
6. `detail_metrics` dashboard in the admin.

## 7. Wave 1 results (2026-09-14)

**Ra'anana regression ("גולי והגיטרה ששרה לגיל 2-4", source `a0eb9ad9…`, activity `6f254902…`)** — production, bounded scans via the admin scan-now:
- Listing card link associated (`card_text`, score 1); detail page fetched; page names the candidate.
- 8 performances (4 dates × 16:30 / 17:30), each with its own `start_time`, provider id (`?id=31436…`) and purchase link on the occurrence row; the listing-side `recurring Monday` misread converted to `one_time` and the `פעילות` (class) label corrected to `אירוע` — both only because the page lists ≥2 explicit performances.
- Price 45 (child) with tiers `{ילד 45, כרטיס 45, מבוגר 0}` kept as evidence; the event is not "free".
- Address `הפלמ"ח 2 א` replaced the Cleaner's reverse-geocoded `חפץ חיים` (derived → official page, HIGH), through the human-approved update.
- Provenance: listing `ילדים_ומשפחה` (`url_role='listing'`), detail page (`url_role='detail'`), the original `page_83` listing kept; `official_url` stayed NULL (no event-level registration action; purchase links are per performance).
- Identity: `event_key = url:…/גולי_והגיטרה_ששרה_לגיל_2-4` (kind `detail_url`); `event_fingerprint` unchanged (legacy recurring key, never rotated). First detection matched the legacy row via the occurrence-series fallback (exact title + venue + source + time + ≥2 performances); the rescan after approval matched by event key with an empty enrichment diff → duplicate, 0 new events, 0 new occurrence rows, 8 rows intact.

**Detail yield (30 d, `report-coverage.js detailYield`)**: Ra'anana 7 scans / 103 pages / 211 fields (ages 44, price 45, address 28, occurrences 31, dates 25, schedule-type 25, entity-type 8, image 5); Carmiel 16 fields (price 5, occurrences 5, image 5; 6 of 13 fetches timed out); Givatayim (403 to the edge → relay, 8 pages primed as evidence) 14 fields (image 7, registration_url 7 — real external booking links, e.g. coing.co); Ashdod 2 fields (5 of 9 fetches failed); Yavne 0 fields → `detail_zero_yield` gap (its links are navigation; needs `link_selector`/`url_pattern` or a better seed page).

**Defects found and fixed during verification**: (1) a shared listing URL + a coinciding date made unrelated events "updates" (urlIdentity now requires name agreement); (2) exact-fingerprint re-detections discarded detail evidence (enrichment-only update diff added); (3) the detail time budget was consumed by the AI call (concurrent prefetch, un-enriched links first); (4) extraction non-determinism (temperature 0); (5) RTL reversed age ranges ("לגילאי 4 -2"); (6) an "adults" label contradicted by an explicit child age was rejected (now review); (7) a ticketed performance series labeled "פעילות" was archived by the commitment policy before its page could prove otherwise.

**Historical consolidation**: `merge-occurrence-duplicates.js` dry run (with `--verify-online=19`): 19 candidate groups, **0 HIGH, 19 MEDIUM, 0 DISTINCT, 0 INSUFFICIENT — nothing merged** (legacy rows carry no detail provenance to verify against; several groups are exact same-date twins that belong to `dedupe-fingerprint-activities.js`). Reports: `merge-occurrences-dryrun-2026-09-14.json`, `merge-occurrences-dryrun-verified-2026-09-14.json`.

Tests: 101 Deno + 49 Node (fixtures `_shared/fixtures/raanana-*.html`). Migration 0091 applied. scan-source deployed (six increments, final = this tree). Admin server restarted on the new `server.js`.

## 8. Wave 2 (2026-09-17) — quality, discovery gaps, URL roles, social input family

**Dense-listing recall is measured, not assumed.** `_shared/listingCards.ts` enumerates a listing's repeated DOM cards deterministically (bottom-up from ≤ 600 anchors — CPU-bounded for the edge), and every scan stores the funnel in `source_scan_logs.listing_metrics` (migration 0095): `cards_detected → ai_returned → past_filtered → cards_matched / cards_unaccounted → recovery_calls / recovered → rejected_{no_name,commitment,adult} / twins_folded / capped / skipped_{in_scan_duplicate,pending_in_queue} / identity_backfilled / updates_superseded` (+ `recovery_skipped` / `recovery_error`, `sitemap`). Diagnosis with the production modules (`diagnose-listing-recall.ts`): Ra'anana 25 cards → 25 extracted at temperature 0 — the old "32 → 22–25" was uncounted post-AI routing, not AI loss; the real bottleneck is latency (one dense call ≈ 83 s, ≈ 570 output tokens per event). ONE bounded recovery call runs only when 1–12 *event-like* cards are unaccounted; an adult-heavy programme (Carmiel / Ashkelon halls: 64 of 122 unaccounted) is measured, never re-extracted.

**Update association and update noise** (`_shared/matching.ts`, Node mirror `cleaner/matching.js`): URL identity needs a shared *distinctive* title word (genre words — "תיאטרון סיפור", "הצגת ילדים" — are never identity) and never holds when place **and** dates contradict; `computeFieldDiff` ignores `17:00:00` vs `17:00`, a reworded model summary (word overlap ≥ 0.5) and a contained / plene-spelled / gershayim-variant place label; an identity-only diff is a silent fill-null `event_key` backfill, never a review item; a rescan **supersedes** the pending update row of the same (activity, source) instead of stacking one. One-time queue repair `repair-update-queue.js`: 615 pending update rows → 229 real (177 no-gain + 167 superseded closed as `duplicate`, 42 mis-associated detached → 30 new / 12 expired).

**Detail reliability is classified**: `detail_metrics.failed_by{kind}`, `ms_ok_max`, `ms_fail_max`, `failed_sample[]`. Carmiel's "6 timeouts" = 2 × `gone_404` + 4 × `timeout_network` at ≈ 5 s while successful fetches take ≤ 554 ms, and the same pages answer a local IP in < 1.5 s ⇒ an **edge access class** (geo / WAF), fixed by relaying that source (`strategy='local_relay'`), never by a longer global timeout. The Kiryat Gat community-centre source was 403-to-edge on every scan and moved to relay.

**Sitemap discovery** (`_shared/sitemap.ts`, `adapter_config.sitemap = {url, section, max_per_scan}`): the publisher's own index replaces what a script-loaded listing hides — cochav-hanofesh.com/parks shows 9 parks in its HTML, its sitemap lists 54. Bounded and incremental (never-scanned pages first). `audit-source-coverage.js --sitemap=… --section=parks` measures source entities vs canonical coverage (20/54 = 37 % before the source existed).

**URL roles reach the product** (migration 0097): `activities.detail_url` = the verified event page (provenance is admin-only under RLS, so the app could not see roles). Action ladder, never guessed: `official_url` > `detail_url` > `source_url`; the app's ticket button used to open the *listing*. A detail page is still never written into `official_url`. Detail traversal was on 5 of 124 active HTML sources (⇒ 506 of 510 upcoming events had no action URL); a 7-source cohort was added. `audit-ticket-urls.js` dry-classifies the action backlog (KEEP_DIRECT / INDIRECT_BEST / UPGRADE / WRONG_EVENT / BROKEN / BLOCKED / EXPIRED).

**Final pre-insert PLACE dedup**: `lib/placeIdentity.js` inside `saveNewActivity` (covers manual `/import` and queue approval; 409 `DUPLICATE_PLACE`) — ≤ 80 m + same name without locality words + same recurring schedule; never dated events, never playgrounds.

**One Node locality layer**: `lib/canonicalSettlement.js` (settlements + `settlement_aliases` + merged-authority aliases + CBS English; administrative areas are never cities; plausibility by locality *kind* because `settlements.population` is empty). `requireVerifiedLocation` fills a missing city from the venue / the address tail (no geocoder) and its city-only geocode fallback accepts only a PLACE-class result. Migration 0098 brought the 9-region split to `venues` and `sources`.

## 9. Unified stabilization program (2026-09-19) — Monster side

- **Entity-type-aware approval gate** (`_shared/extraction.ts` `missingTemporalEvidence` / `repairEntityTypeFromSchedule` / `TEMPORAL_ISSUE_LABEL`, wired into `scan-source` `sanitizeCandidate` + `autoApproveEligible`; deployed 2026-09-19): a one-time event needs a date, a recurring event needs weekdays (`ימי פעילות` gating issue), a plain "אירוע" with a repeating schedule is repaired to `אירוע_קבוע` (the prompt's own definition); an "אירוע" with a fixed-hours / missing schedule cannot auto-approve. Evergreen places and OSM / Google playgrounds are untouched. First production cohort after the deploy: 33 of 105 candidates were held by the new issue instead of approving without weekdays.
- **Validation cohort tooling**: `run-monster-cohort.js --phase=scan` triggers the REAL path (`scan_source_now` RPC → pg_net → edge function) on a bounded source list and reads the funnel from `source_scan_logs`; `--phase=measure --since=T0` counts the Cleaner cases of the NEW canonical subjects (activities created + `incoming` `match_type='new'` found in the window by cohort sources) and classifies each AVOIDABLE (the Cleaner resolves it now from evidence the Monster already had) vs HONEST_UNRESOLVABLE. Results and the comparison with the historical 35.4 / 39.1 per 100 are in `UNIFIED-STABILIZATION-REPORT-2026-09-19.md`.
- **Identity-less candidates never stack in the queue**: a candidate with neither fingerprint (no city / no date) nor event key (generic title) re-detected on a changed listing page used to create a new `incoming` row on every rescan (17 of 42 "new" rows of the 2026-09-19 idempotency rescan were open twins). Same source + same extracted name already open ⇒ `skipped_pending_in_queue`. Scoped to the source and to identity-less candidates only.
- **Corroborated category hint** (`_shared/categoryHints.ts`, lockstep with the Cleaner's `NAME_CATEGORY` / `FAMILY_SUPPORTS`): a missing category that the Cleaner would derive later from the same name + source family is filled at ingestion (MEDIUM, `extracted_data.category_source = 'hint:…'`) — 6 of the 14 AVOIDABLE cohort cases were exactly this.
- Reference data the Monster relies on: `public.settlements` centroids are now authoritative (CBS 2024) for the 193 repaired rows — see THE-CLEANER.md.

## 10. CONTINUOUS MONSTER — operating model (2026-09-19; bounded PILOT active since Phase D, see below)

**Principle.** The Monster is a maintained data system, not a periodic scrape: every data type has its own freshness need and every job is bounded, idempotent, isolated and observable. Nothing here replaces the pipeline above — it schedules and observes it. Design + audit: `CONTINUOUS-MONSTER.md`.

### Job types, where they run, cadence (with the reason)
| Job | Runs | Cadence | Max work / run | Why this cadence |
|---|---|---|---|---|
| Active source scanning | **Supabase pg_cron** `scan-due-sources` → `_scan_due_sources_cron()` → edge fn `scan-source` | every 15 min | 20 due sources per tick (priority desc, next_scan_at asc) | dated events: median lead time 14 d (p25 5 d) — a productive calendar must be revisited every 1–2 days; 20 per tick prevents a thundering herd |
| Per-source frequency | `sources.scan_frequency_hours`, proposed by `tune-source-cadence.js` (`lib/sourceCadence.js`) | weekly **dry run** in the pilot (writes the plan only; `--apply --max=40` is a separate approval) | 0 in the pilot | evidence-based on 30-day yield: events 24 h when ≥ 1 new/updated per scan and ≥ 10 in 30 d, 48 h when productive, 72 h when quiet; venues 168 h / 336 h; unmeasured 72 h; bounds 24–336 h. A page hash that changes on every load is *not* a live calendar. The least productive daily sources are demoted until the expected scans/day fit the budget |
| Expiration | pg_cron `cleanup-expired-activities-daily` | 03:00 daily | all | one-time events leave Results the morning after their last date |
| Relay (WAF-blocked sources) | local `relay-scan.js --max=6` | every 6 h | 6 sources | 10 relay sources with 72–168 h frequencies need ~2 relays per cycle; 6 absorbs a backlog after downtime |
| Places photos (2026-09-26, **gated OFF** until rollout) | local **Python** `tools/playground-discovery/enrich_images.py --apply --limit=50 --max-concurrency=2 --requests-per-second=2 --daily-max-calls=300` (runs only when `automation_settings.places_photos_enabled` is exactly `true`) | hourly, **before the Cleaner** | 50 due activities, ≤ 2 Places calls/s, 300 Places calls/UTC day | new Places activities (queue approval, coverage plans) arrive imageless; see *Places photos job* below |
| Cleaner follow-up | local `cleaner.js --max=40` | hourly | 40 cases (leases + run guard) | resolvable debt follows ingestion asynchronously; ~1,000 cases/day capacity |
| Coverage | local `report-coverage.js --json-only` | weekly | read-only | gaps move slowly; the JSON feeds discovery targets |
| Source discovery | local `discover-sources-osm.js --max=20 --register` | weekly | 20 candidates | OpenStreetMap venue records with a website (free, ODbL, provenance = OSM id) inside the service area → fetch-verified (Hebrew, child/event keywords) → deduplicated against sources/venues → registered **INACTIVE**; a person activates. Region = nearest CBS settlement's region |
| Re-probe | local `reprobe-sources.js --max=30` | monthly | 30 sources | paused / 403-blocked sources re-probed from the local IP; reachable ones proposed as relay (`--apply` is explicit) |
| Heartbeat | local `monster.js status` at the end of every cycle | hourly | — | `monster-status.json` + one-line summary |

### Orchestrator (`monster.js`)
`node monster.js cycle` runs the due local jobs sequentially (state + heartbeat in `automation_settings.monster_state`; `monster_enabled` pauses local jobs; pg_cron scanning pauses with `scanning_enabled=false`, the Cleaner with `cleaner_enabled=false`). Overlap: `logs/monster.lock` (stale after 3 h) + each job's own guard (Cleaner run guard + leases, relay per-source `next_scan_at`). Failure containment: each job is a child process with a 45-min timeout; a failure is recorded in `monster_state[job].lastStatus/lastTail` and the cycle continues with the next job. `--dry-run` selects and prints, mutates nothing. `--job=<id>` runs one job. `install-task` prints the Task Scheduler command and never executes it.

### Places photos job (`places_photos`, 2026-09-26)
The only Python job (`runtime: 'python'` in `lib/monsterJobs.js`: `py -3` on Windows, `python3` elsewhere, `TURU_PYTHON` overrides; cwd `tools/playground-discovery`; UTF-8 stdio; 15-min timeout; a launcher that cannot start fails the job, never the cycle). Node jobs are launched exactly as before.
- **Cohort (server-side)**: `status = approved`, `google_place_id` set, no `activity_images` row of any status, `created_at` older than 10 min (the scan-settlement-gaps inline insert wins), ordered `created_at, id`; `--limit` takes the first due rows of that order (keyset paging past ledger-parked rows). Archived / pending / rejected rows never qualify.
- **Ledger** `automation_settings.places_photo_checks` (no migration) holds only non-success outcomes per activity: `no_photo` → re-check after **30 days**; `invalid` (400 / 404) → **90 days**; `error` → 6 h · 2^(n−1) capped at 7 days, parked 30 days after 6 failures. An entry for another `google_place_id` never suppresses the current one; a success removes the entry (`activity_images` is the source of truth); entries whose activity left the cohort are pruned. The same key carries the UTC-day Places call count for `--daily-max-calls`.
- **Failures**: timeouts / transport / protocol errors / 5xx retried in-run (3 tries, ~1 s, 2 s backoff + jitter); a malformed 200 once; 429 honours `Retry-After`, and a persistent 429 trips the circuit breaker (exit 3, remaining rows untouched); 401 / 403 abort the job (exit 2) without recording any row.
- **Insert contract** (unchanged): `image_source_type = PROVIDER`, `url = <SUPABASE_URL>/functions/v1/place-photo/<google_place_id>`, `image_source_url` = the activity's Maps listing, `needs_rights_review = false`, `uploaded_by` = bot. Never a Google CDN URL, photo resource name or image bytes. The row is re-read right before the insert (`raced` when an image appeared or it left `approved`).
- **Cleaner**: never touched. The Cleaner runs after it in the same cycle and its discover stale sweep closes the satisfied `missing_image` case as `resolved_externally`; playgrounds (exempt from `missing_image`) are covered because the job selects on the image, not on cases.
- **Scope**: the Places Details field mask is `photos` only — official-source enrichment (websiteUri etc.) is a separate job.
- **By hand**: `py enrich_images.py --list-only` (the exact cohort, 0 Places calls, 0 writes), `--dry-run`, `--apply --activity-id <uuid> --limit 1`; `--created-after <ISO>` narrows further. **Enable** after review: `automation_settings.places_photos_enabled = true`.

### Source prioritization
The dispatcher orders by `priority desc, next_scan_at asc`; the cadence job turns 30-day yield into frequency (live calendars daily, quiet event sources 72 h, venue directories weekly / fortnightly); health backoff (`_shared/sourceHealth.ts`) governs failing sources; a source is never abandoned for one empty scan (fewer than 3 scans → default; auto-pause only after 10 hard failures, never for priority ≥ 8).

### Service area (product rule 2026-09-19)
Palestinian-Authority-administered localities are out of scope — a **geographic** rule on coordinates (`lib/serviceArea.js`, Deno twin `_shared/serviceArea.ts`; reference `reference/pa-localities.json` = OSM/Nominatim place records + curated fallbacks; CBS settlement centroids). Never inferred from language, name, source, audience or population: Israeli Arab localities are CBS settlements and always in scope. Rule order: CBS ≤ 1 km → IN_SCOPE; PA locality within its radius (city 4 / town 2.5 / village, camp 1.5 km) and a CBS settlement ≤ 4 km → AMBIGUOUS (Hebron / Kiryat Arba), otherwise OUTSIDE_SERVICE_AREA; CBS ≤ 2 km → IN_SCOPE; default IN_SCOPE. Node adds reverse-geocode refinements (foreign country → OUTSIDE_FOREIGN; Gaza → OUTSIDE; `ps` without a CBS settlement ≤ 4 km → AMBIGUOUS; a resolved CBS locality → IN_SCOPE). Ambiguous is never excluded. **Safety (both twins)**: when the record itself names a CBS settlement whose centre is within 8 km (`cityHint` — Jerusalem's neighbourhoods next to Anata / Abu Dis are 5–8 km from the city's single CBS point), an OUTSIDE verdict becomes AMBIGUOUS: an Israeli locality is never auto-excluded because its centroid is far. The reference is not exhaustive (115 localities), so "no PA match" is weak evidence: an unmatched point with reverse `ps` and a CBS settlement 2–4 km away is IN_SCOPE by default (4 such rows in the historical cohort, kept published, confidence MEDIUM). Prevention points: scan-source `autoApproveNewActivity` (earliest point with verified coordinates → incoming `rejected`, `archive_reason=outside_service_area`, `listing_metrics.outside_service_area`) plus a per-source memory that never re-queues a name already rejected as outside (`skipped_outside_service_area`); the Node approve path (`server.js` → 422 `OUTSIDE_SERVICE_AREA`); the Cleaner hand-back; the Cleaner's Palestinian-locality branch (confirmed → activity archived `outside_service_area`, ambiguous → `requires_human_judgment`). Coverage reports count excluded rows separately, never as a gap.

### Observability / heartbeat
`node monster.js status` → `monster-status.json`: running flags, last local cycle, last scan; 24 h scans (ok / partial / failed), AI calls, candidates (new / updates / duplicates avoided), published, outside-service-area blocked, Cleaner runs (resolved / archived / write_denied / errors); backlog (open Cleaner cases with 7-day trend; review queue with inflow / outflow and the human-only share, bucketed by reason via `lib/reviewBudget.js`, signals `review_debt_growing` / `review_queue_large` / `queue_mostly_cleaner_resolvable`); sources (active / healthy / failing / paused / relay / due, repeatedly failing list); top coverage gaps.

### Operating it
- **Pause**: `node monster.js pause` (local jobs); scans: `automation_settings.scanning_enabled=false`; Cleaner: `cleaner_enabled=false`. **Resume**: `node monster.js resume` / the settings back to `true`.
- **One bounded cycle by hand**: `node monster.js cycle` (or `--job=relay` etc.); `--dry-run` first.
- **Diagnose a failed cycle**: `logs/monster.log`, `monster_state[job].lastTail`, `monster-status.json`, `source_scan_logs` (status / failure_kind / listing_metrics per scan), `cleaner_runs.notes`.
- **Still human**: activating a discovered source, review-queue decisions, ambiguous service-area cases, RLS (0099 blocked), scan budgets / AI cost, applying relay proposals, and the production activation itself (Phase D).

### Code line (2026-09-24)
The pilot executes **MAIN's commit or nothing**: `lib/codeLine.js` probes the checkout each cycle, records commit / branch / dirty count in `monster_state._code_line`, and `monster.js cycle` refuses (`stale_code_line`) when HEAD is not MAIN's current commit. The scheduler task must point at the MAIN tree (`C:UsersmboreKidsApp	oolsimport-toolmonster.cmd`); no parallel fork of Cleaner rules is kept. **Executed 2026-09-24**: MAIN = `4864147` (P1 + pilot line + guard), scan-source v76 deployed from it (P1 reconfirmation and the service-area gate both in the bundle), task re-pointed to the MAIN tree. The old `fa8fe63` worktree predates the guard and would run old rules if invoked by hand; it is inert only because nothing schedules it. Unification record + migration steps: `CONTINUOUS-MONSTER.md` ("CODE-LINE UNIFICATION").

### Pilot status (Phase D, 2026-09-19)
Active: Task Scheduler "TuRu Monster" (hourly, user mbore, `tools/import-tool/monster.cmd` in the `turu-continuous-monster` worktree); the legacy "TuRu Cleaner pilot" task is DISABLED — one Cleaner scheduling path only. scan-source with the service-area prevention is deployed. The cadence plan and the re-probe proposals are NOT applied. Phase D report: `CONTINUOUS-MONSTER.md`.

### Pilot vs production
The local orchestrator on the admin laptop is a **PILOT** (same class as the "TuRu Cleaner pilot" task): a laptop is a single point of failure, not a durable execution tier for national ingestion. Durable today: pg_cron scanning + expiry. Migration path: (1) run `monster.cmd` on a small always-on host with an Israeli IP (relay needs it); (2) once relay is off the laptop, port the Cleaner's fetch stages to an edge function; (3) keep pg_cron as the scheduler of record. Nothing is activated without approval.

### Social input family (Meta capability audit 2026-09-17, Graph API v26.0, Platform Terms 2026-02-03)
Social is a **source family**, not a second platform: an account is a row in `sources` (`source_kind` facebook / instagram already existed) and a post enters the same extraction → sanitize → venue → identity → dedup → provenance → review path with its permalink as `page_url`.
- **States are never collapsed** — `adapter_config.social = { platform, handle, profile_url, state: DISCOVERED | VERIFIED, verified_via, access: { status: NOT_CONFIGURED | ACCESSIBLE | BLOCKED, method, failure_class: PERMISSION | TOKEN | APP_REVIEW | RATE_LIMIT | ACCOUNT_TYPE | PLATFORM_RESTRICTION | DELETED_CONTENT | PRIVATE_ACCOUNT | BLOCKED | UNKNOWN }, consent: { status }, productive }`. `report-coverage.js → social` reports HAS_WEBSITE / HAS_FACEBOOK / HAS_INSTAGRAM / SOCIAL_ONLY_RELEVANT_PUBLISHERS / DISCOVERED / VERIFIED / ACCESSIBLE / CONSENTED / BLOCKED / NOT_CONFIGURED / PRODUCTIVE.
- **Discovery** (`discover-social.js`, `lib/socialLinks.js`): known publisher → its OFFICIAL website → social links. VERIFIED = linked from the official site **and** the handle carries the publisher's own name; a lone account without it is only DISCOVERED (a mall's site links its parent company). Never opens instagram.com / facebook.com.
- **What Meta allows** (authoritative docs only): no Instagram account search; Basic Display is gone (2024-12-04); scraping is prohibited without Meta's written permission (Automated Data Collection Terms); Facebook Events are Marketing-Partner-only; oEmbed is display-only and may not be a data source; extracted facts remain Platform Data (deletion duties); re-displaying Instagram media is restricted (Developer Policies 6.2) ⇒ store facts + permalink, never re-host images. Legitimate paths, all needing prerequisites Turu does not hold yet (no Meta app / token): **consented connection** (best), **Page Public Content Access** (App Review + business verification), **Instagram Business Discovery** by exact username (needs Turu's own professional account; several fields unconfirmed until tested). Hence `access.status = NOT_CONFIGURED`, not "blocked" and not "scan failed".
- **Content semantics** (`_shared/socialContent.ts`, access-agnostic): `classifySocialItem` → ACTIVITY_CANDIDATE / UPDATE / CANCELLATION / EXPIRED / IRRELEVANT / AMBIGUOUS; relative dates resolve against the **post's publication time in Israel**, never scan time; an update / cancellation needs exactly one strongly associated canonical event (same verified publisher + distinctive title words); a venue is implied only by a VERIFIED publisher relation.
