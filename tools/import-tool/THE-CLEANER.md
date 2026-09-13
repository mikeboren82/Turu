# THE CLEANER — design and Phase A audit (2026-09-13)

The Cleaner is the second automated backend: it takes every incomplete, blocked, rejected or
partially-usable activity record and drives it to a terminal state — **PUBLISHED/USABLE** or
**ARCHIVED with a machine-readable reason**. The Monster (scan-source + relay + discovery) finds and
ingests; the Cleaner resolves, completes, repairs and closes. They share: venues/aliases,
`activity_sources` provenance, event fingerprints + confidence thresholds, city/venue normalization,
the source registry, validation (`sanitize`/gating issues), and the approve path in `server.js`.

## Phase A — audit of what exists

| Capability | Verdict | Where / what |
|---|---|---|
| Where incomplete activities live | DONE | `activities` (status `approved`) with `locations` lacking `address` (624 of 757 live non-playground rows), no image (443), no venue (389), no schedule (43); playgrounds: 4,513 without image (placeholder policy), 90 without address |
| Where rejected activities live | DONE | `incoming_activities.status='rejected'` (555 rows; 91% confirmed duplicates, 14 adult); `activities.status='rejected'` (7 legacy rows) |
| Missing-address failures | PARTIALLY AVAILABLE | They are **not** stored as rejections: an item without city/location_name stays `new`/`needs_review` forever (213 no-city / 199 no-location rows in the 882 open items) — the exact limbo this system closes. Auto-approve in the edge silently falls back to the queue when geocoding fails |
| Missing-image representation | DONE | `activity_images` absent + `activities.placeholder_group` (5 groups); `photo_skipped` |
| Publish requirements | DONE | `requireVerifiedLocation` (server.js) = `location_name` + coordinates (Nominatim, **with a city-centroid fallback** = weak "verified"); commitment activities archived; image/price/date optional. Edge `autoApproveEligible` adds trust ≥ 80, zero gating issues, plausible date |
| Validation | DONE | `sanitizeCandidate` issues (שם/סוג ישות/קטגוריה/מחיר-soft/תאריך/עיר), `gatingIssues`, `assessChildRelevance`, `isCommitmentActivity`, `looksLikeStaleRepost` |
| Geocoding / place tools | PARTIALLY AVAILABLE | Nominatim only (Node `geocodeLocation` throttled 1.1s, Deno untrottled, `enrich-playground-addresses.js` reverse+forward); Google Places (New) only inside `scan-settlement-gaps` (key in Supabase secrets, not local). No cache. No JSON-LD parsing anywhere |
| Image fields | DONE | `activity_images(url,status,image_source_url,image_source_type ORIGINAL/EXTERNAL/PROVIDER/UNKNOWN,needs_rights_review)`; no image kind (event vs venue), no real validation (HTML attrs only), SerpAPI optional and exhausted |
| Provenance | DONE | `activity_sources(activity_id,source_id,page_url,incoming_activity_id,relation created/seen/updated)`, `activities.source_id/source_url/last_seen_at` |
| Archive state | PARTIALLY AVAILABLE | `activities.status='archived'` exists (202 rows) but **no reason/when column** — four causes (commitment, expired cron, missing-from-source, unrecoverable address) are indistinguishable. Incoming: `rejected` (free text) / `archived_expired` |
| Retry counters / failure reasons | MISSING | none on `incoming_activities`; `sources.consecutive_failures` is per source, not per item |
| Review-case model | PARTIALLY AVAILABLE | `settlement_scan_review_cases` is structurally close but keyed on `google_place_id` — not reusable as-is; `incoming_activities` is one row per detection, no rollup |
| Scheduler | DONE | pg_cron (`scan-due-sources` */15, expired cleanup 03:00, settlement 03:00); local relay runs on the admin machine (not scheduled) |
| Dedup logic | DONE | Deno `computeConfidence`/`findSimilarActivities`/fingerprint; Node has fingerprint mirror + approve-time guards (google_place_id, fingerprint) but **no similarity search without AI in the approve path** |

**NEEDS CORRECTION (found by the audit, fixed as part of the Cleaner):**
1. Archive writers record no reason → add `activities.archive_reason/archived_at` and set it in every writer (commitment, expired cron, resolve-missing, cleaner).
2. `/resolve-missing` with `keep` writes `rejected` with a null reason → reason `kept_by_admin`.
3. `archive.js` restore-to-approved bypasses the location/commitment gate → re-check on restore.
4. `geocodeLocation` city-centroid fallback counts as verified → the Cleaner never accepts a city-only geocode as a resolved address (LOW confidence, not publishable).
5. No image validation → `imageProbe` (content-type, bytes, real dimensions) used by the Cleaner; scanner images keep their path.

## Design (reuse-first)

**Queue model** — migration `0083_cleaner.sql` (all additive):
- `cleaner_cases(subject_kind activity|incoming, subject_id, issue, priority, status open|resolved|archived, attempts, methods_tried[], last_attempt_at, next_attempt_at, last_error, resolution jsonb, archive_reason, event_date, source_id, opened_reason, reopened_count, timestamps)`, unique per (subject, issue).
- `cleaner_runs(started_at, finished_at, mode, counters jsonb)`.
- `activities.archive_reason/archived_at`, `incoming_activities.archive_reason`, `locations.address_source/address_confidence/address_resolved_at`, `activity_images.image_kind/image_page_url/retrieved_at`.
- settings: `cleaner_enabled`, `cleaner_max_attempts` (3), `cleaner_backoff_hours` ([6,24,72]), `cleaner_batch_size` (40), `cleaner_places_daily_budget` (100).

**Issues** (priority order): `missing_location` (blocking, incoming), `unverified_location` (city-only geocode), `incomplete_address` (coords but no street), `missing_venue`, `missing_image`, `broken_image`, `missing_schedule`, `missing_region`, `missing_required_metadata`, `low_quality_description`.

**Address pipeline** (`cleaner/locationResolver.js`): Stage 1 existing data (venue aliases on location_name / organizer / activity name; prior activities of the same source with the same location label; venue of the source) → Stage 2 source page (JSON-LD Event/Place, address text, Google-Maps links, og) → Stage 3 venue/organizer site (contact page) → Stage 4 place lookup (Nominatim name+city with city agreement; optional Google Places text search via the `resolve-place` edge function when a key is configured). Each result carries `{address, city, lat, lng, venue_id, method, confidence HIGH|MEDIUM|LOW, evidence}`. Only HIGH/MEDIUM publish; LOW is recorded, never written as a verified location. No fabrication: no result → attempt consumed, backoff, then archive `missing_address_unresolved` / `ambiguous_location`.

**Hand-back to the pipeline**: incoming rows are patched (`extracted_data` location fields, `validation_issues`), then the Cleaner runs the Node similarity mirror (`matching.js`, same thresholds) — a match ⇒ enrich the existing activity + provenance `seen` + `duplicate_of_existing_activity`; no match ⇒ the same policy as `reprocess-review-queue.js` decides publish (trusted, no gating issues, plausible date, relevant) through `POST /api/incoming/:id/approve` (fingerprint/place-id guards inside). Untrusted-source items stay in the queue **with a resolved location** and are reported as a policy hold, not as limbo.

**Images** (`cleaner/imageResolver.js`): source-event image → page og/JSON-LD/twitter image → same-series activity image → venue site og image; validated by `imageProbe.js` (reachable, image content-type, ≥ 8 KB, ≥ 300×200, not logo/icon/placeholder, not duplicate); stored through `activity_images` with `image_kind`, `image_source_url/page_url`, `retrieved_at`, `needs_rights_review` by host rule; clears `placeholder_group` like the scanner does.

**Lifecycle**: attempts with backoff per case; expired one-time events archived first (`activity_expired_before_resolution`); max attempts ⇒ archive with reason; `cleaner reopen` re-queues archived cases whose evidence changed (new venue/alias resolves the label, source page changed, same fingerprint reappears); reopening never creates a second activity (dedup runs again).

**Metrics**: `cleaner_runs.counters` + `report-cleaner.js` (backlog by issue/reason/source family, stuck-beyond-window, success rates) + minimal admin page `/cleaner`.

## Operating it

```
cd tools/import-tool
node cleaner.js                      # one cycle: discover + reopen + process cleaner_batch_size due cases
node cleaner.js --loop=30 --max=250  # continuous: every 30 min (this is how the backfill runs)
node cleaner.js --issue=missing_image --max=20 --dry-run
node report-cleaner.js               # backlog / reasons / success by issue and family / stuck cases
```
- Runs on the admin machine (page fetches need a local IP like the relay; publishing needs the admin server on :4321). **One Cleaner process at a time** - due cases are not locked.
- Settings (admin → automation): `cleaner_enabled`, `cleaner_max_attempts` (3), `cleaner_backoff_hours` ([6,24,72]), `cleaner_batch_size` (40).
- Scheduling is a machine-level decision (Task Scheduler entry for `node cleaner.js --loop=30`, alongside `relay-scan.js`) - not registered by the implementation.
- Nominatim is throttled to 1 request/1.1 s per process; a missing-location case costs ~10-25 s (page fetches + geocodes), address strings ~1.5 s, images ~5-10 s.

## Status at first backfill (2026-09-13 evening)

Backlog discovered: 2,527 issues — missing_location 296 (blocking, incoming), missing_required_metadata 292, incomplete_address 642 (live, coords without street), missing_image 443, missing_venue 408, missing_region 403, missing_schedule 43. Unexplained backlog: 0 (every case carries `opened_reason`). Stuck beyond retry window: 0.
Measured on the first batches: address strings 20/20 filled (reverse geocode, MEDIUM, provenance stored); missing_location ≈ 27% resolved per first attempt (8 of 60 merged into existing activities by the ingestion matcher, 7 located but held by the trust policy, 1 flagged as a possible update; the rest scheduled for attempt 2 with the venue-site stage, attempt 3 with place lookup, then archive); images 9 of 15 attached after listing-card discovery (all `event_specific`, provenance + rights flag by host). Venues: all 74 lacked coordinates — the Cleaner now derives them from Turu's own linked verified locations (HIGH) or the venue's address/name and writes them back, so later cases resolve from stage 1.
The backfill loop keeps running; `report-cleaner.js` is the source of truth for the current numbers.

## Acceptance criteria (brief §31) — where each is satisfied
1 revisit rejected/blocked missing-address items — `discover.js` (missing_location on every open/failed incoming row; rejected rows with a reopenable `archive_reason` via `reopen`). 2 multiple source types — `locationResolver.js` stages. 3 normal pipeline — `apply.js` → `POST /api/incoming/:id/approve`. 4 enrich, never duplicate — `matching.js` (`bestMatch`) + `enrichExistingFromCandidate`. 5 images — `imageResolver.js` + `imageProbe.js`. 6 image provenance — `activity_images.image_kind/image_page_url/retrieved_at/image_source_*`. 7 no weaker-over-stronger — fill-null merges in `apply.js`, LOW never written. 8 retry/backoff — `lifecycle.js` (`STAGES_BY_ATTEMPT`, `nextAttemptAt`), tested. 9 terminal archives with reasons — `archiveCase` + `archive_reason` on cases/incoming/activities, tested. 10 reopen — `reopenWhereEvidenceChanged`, tested. 11 repeatable — `--loop`, `cleaner_runs`. 12 measurable — `report-cleaner.js`, `/cleaner`. 13 backlog processed — running (see status). 14 no unexplained state — `opened_reason` on every case, `unexplainedBacklog` metric. 15 shared core — cityNaming/venueNaming/eventFingerprint/matching mirror, `activity_sources`, thresholds from `automation_settings`, the same approve path.
