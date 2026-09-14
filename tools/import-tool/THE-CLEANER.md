# THE CLEANER — design and Phase A audit (2026-09-13)

## Names (official system terminology)

- **The Cleaner / המנקה** — the automated Turu backend that resolves, enriches, repairs and closes
  incomplete or unusable activity records (this document; `cleaner.js` + `cleaner/*`).
- **The Monster / המפלצת** — the national discovery and ingestion platform (`scan-source`, the local
  relay, source discovery, the settlement scan).

Relationship: **THE MONSTER** discovers → scans → extracts → ingests → updates; **THE CLEANER**
resolves incomplete records → enriches → repairs → closes. They are separate systems that share the
canonical infrastructure listed below (venues/aliases, provenance, fingerprints, normalization, the
approve path, and the page-evidence helpers in `lib/pageExtract.js`). Production tables and services
keep their real names; the nicknames are documentation/conversation terms only.

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

**Address pipeline** (`cleaner/locationResolver.js`): evidence stages `existing` (venue aliases on location_name / organizer / activity name; the source's venue; prior activities of the same source with the same label; existing location rows - always run, cheap, where new canonical knowledge shows up) → `source_page` (JSON-LD Event/Place, Google-Maps links, Hebrew street text) → `detail_page` (the listing card that names the event → its detail link, shared `findEventCard`) → `venue_site` (official site / contact page, needs a venue) → `place_lookup` (Nominatim label+city with city agreement, needs label + city) → `place_lookup_inferred` (city inferred from the source's other activities, or a label that is a unique venue-type hit in Israel). Each result carries `{address, city, lat, lng, venue_id, method, confidence HIGH|MEDIUM|LOW, evidence}`. Only HIGH/MEDIUM publish; LOW is recorded, never written as a verified location. No fabrication. **No external place API is configured** (Google Places lives only in scan-settlement-gaps); every location archive records that as `external_limit`.

**Attempts are information gain, not identical retries** (`lifecycle.js`): `resolveLocation` returns `tried` (stages actually run), `skipped` (`[{stage, why}]` - configured but unavailable for this subject: no page_url, no city, no venue, no detail link) and `errors`. Each attempt runs `existing` plus up to two never-tried evidence stages (`--now` runs them all). A case archives only when `attempts >= cleaner_max_attempts` **and** every stage was tried or recorded unavailable; when nothing is left before the max, the retry re-checks `existing` only (`next_strategy: "existing (await new canonical evidence)"`). Every archive carries `resolution.explanation = { missing, methods_tried, methods_unavailable, evidence_found, why_insufficient, external_limit, reopen_when }` (visible on `/cleaner`). Target: **no unexplained limbo**, not zero open cases.

**Venue clusters** (`cleaner/venueClusters.js`, runs each cycle before per-case work): open location/venue cases grouped by normalized label (+city; a city-less group merges into its single same-label city group). Clusters of ≥ `cleaner_cluster_min_size` (3) are resolved once: an existing venue is enriched (`coordsForVenue`: linked-location median → address geocode → reverse geocode for the street, fill-null only); a missing venue is created through `venueLearning.createVenueWithAlias` (re-resolves the alias right before insert, alias upsert with onConflict) on **HIGH** evidence (JSON-LD geo / official site / map link) or **MEDIUM** evidence with ≥ 3 *independent* agreeing confirmations - independent = different sources AND different page hosts, ≤ 150 m apart, same city; fifty rows from one source are one confirmation, cluster size is not evidence. Members then go through their normal per-case path (stage `existing` hits) - never a mass write. Counters: `venueClustersResolved`, `resolvedViaCluster`, `resolvedViaVenue`, `externalLookupsAvoided`, `gain.venueRowsEnriched/venuesCreated`.

**City centroids**: the approve path stamps `locations.address_source='geocode:city_centroid'` + `address_confidence='LOW'` when only the city-only Nominatim fallback hit (`server.js geocodeLocation` returns `fallback:'city'`). Historical detection (`cleaner.js --centroid-audit[=apply]`, `cleaner/centroidAudit.js`) is provenance-first and multi-signal: within ~150 m of the city's own centroid AND no street address AND (no venue OR generic label) → `geocode:city_centroid_suspected`/LOW. Identical coordinates shared by many rows are *not* a signal. `discover.js` opens `unverified_location` for stamped rows; a HIGH/MEDIUM result may replace LOW coordinates (`applyAddressToActivity` `.or('lat.is.null,address_confidence.eq.LOW')`).

**Hand-back to the pipeline**: incoming rows are patched (`extracted_data` location fields, `validation_issues`), then the Cleaner runs the Node similarity mirror (`matching.js`, same thresholds) — a match ⇒ enrich the existing activity + provenance `seen` + `duplicate_of_existing_activity`; no match ⇒ the same policy as `reprocess-review-queue.js` decides publish (trusted, no gating issues, plausible date, relevant) through `POST /api/incoming/:id/approve` (fingerprint/place-id guards inside). Untrusted-source items stay in the queue **with a resolved location** and are reported as a policy hold, not as limbo.

**Images** (`cleaner/imageResolver.js`): source-event image → page og/JSON-LD/twitter image → listing card image → detail page → same-series activity image → venue site og image; validated by `imageProbe.js` (reachable, image content-type, ≥ 8 KB, ≥ 300×200, not logo/icon/placeholder, not duplicate); stored through `activity_images` with `image_kind`, `image_source_url/page_url`, `retrieved_at`, `needs_rights_review` by host rule; clears `placeholder_group` like the scanner does. **Classification is evidence-based and downgrades when ambiguous**: a candidate equal to the host's homepage og:image → `generic_fallback` (rejected unless `allowGeneric`); a URL already attached to another activity → `event_series` (names overlap ≥ 0.7) else `organizer_specific`; a card image shared by other cards on the listing page → `organizer_specific`. Audit of the first 12 attached images (`audit-cleaner-images.js`, 2026-09-14): 8 stayed `event_specific` with evidence, 2 → `organizer_specific` (one Kfar Saba library image on two unrelated events), 2 → `event_series` (two age groups of one Herzliya workshop). Images are reclassified, never deleted.

**Stale-write protection / stronger data wins** (`cleaner/apply.js`): every write on a live record is conditional in SQL - `address` only `.is('address', null)`, coordinates `.or('lat.is.null,address_confidence.eq.LOW')`, `venue_id` only when null, venue rows only when `lat`/`address` null; an incoming row is patched only while still `new/needs_review/failed`; a second image is never inserted. When the guard writes 0 rows the case resolves as `already_filled` (counted as "resolved without gain"), never overwriting an admin/Monster decision made between claim and write.

**Concurrency** (migration `0088_cleaner_leases.sql`): cases are claimed atomically through `cleaner_claim_cases(worker, limit, issue?, lease_seconds, case_ids?, ignore_backoff)` (`FOR UPDATE SKIP LOCKED`, sets `claimed_by/claimed_at/lease_until`); every retry/resolve/archive/reopen write releases the lease; a crashed worker's lease (default `cleaner_lease_seconds` 900) simply expires and the case is claimable again; long batches extend leases every 10 cases. `cleaner_runs` carries `worker` + `heartbeat_at`; a second full run refuses to start while another has a heartbeat < 5 min old (`--force` overrides; `--case` runs are lease-safe and may overlap); runs that never finished are marked `abandoned`. Weighted fairness: ~60 % of a batch by strict priority, ~40 % round-robin across issues with due cases (`--no-fair` for strict order).

**Lifecycle**: attempts with backoff per case; expired one-time events archived first (`activity_expired_before_resolution`); exhaustion (see above) ⇒ archive with reason + explanation; `reopenWhereEvidenceChanged` re-queues archived cases whose evidence changed (a venue/alias now resolves the label or organizer; a linked venue gained an address); reopening never creates a second activity (dedup runs again). Proven end-to-end on an isolated test record (`cleaner-e2e-reopen.js`, 2026-09-14 - see status below).

**Metrics**: `cleaner_runs.counters` (incl. `gain{addressesAdded, streetAddressesAdded, coordsAdded, coordsImproved, venuesLinked, venueRowsEnriched, venuesCreated, imagesAdded, brokenImagesReplaced, schedulesAdded, regionsAdded, metadataFieldsAdded, incomingPromoted, existingEnriched, duplicatesMerged}`, `resolvedNoGain`, venue effects, `newDebtProcessed`) + `report-cleaner.js` (backlog by issue / bucket / reason, awaiting-retry by next strategy, **information gain**, **source debt** with dominant issue + likely root cause `source_limitation | extraction_weakness | adapter_weakness | venue_resolution_weakness | missing_detail_traversal | bad_upstream_data | unknown`, **historical vs new debt** by source / family / issue / ingestion path with cases-per-100-subjects, centroid counts) + admin page `/cleaner` (same blocks; archived cases show their explanation). A resolved case that changed no canonical data (`resolved_externally`, `already_filled`) is reported separately from real repairs.

**Shared with THE MONSTER** (`lib/pageExtract.js`): JSON-LD, map links, address text, meta/page images, event card + detail link, bounded detail-link discovery (`findEventDetailLinks`) are one implementation for the relay and the Cleaner; the Deno twin of the JSON-LD subset is `supabase/functions/_shared/jsonld.ts` (scan-source pre-fills address / geo / date from a name-matched Event, fill-null only). Upstream fixes deployed 2026-09-14 (scan-source v39): the extraction prompt asks for `address` (explicit street + number only, never guessed); `sanitizeCandidate` keeps it; the auto-approve location insert stores `address` (candidate, else the canonical venue's address) with `address_source='monster:extracted'|'monster:venue'`; existing rows are matched by name **within the same city** and their null address filled; `computeFieldDiff` surfaces an address seen by a later scan; the venue resolver returns `address`. Node approve path (`requireVerifiedLocation`): same city filter + address fill + centroid stamp. Detail traversal: `relay-scan.js --detail-pages=N` / `sources.adapter_config.detail_traversal.{max_pages, allow_hosts}` relays event detail pages as pages of their own (their `page_url` becomes the candidate's page). **Incremental step only** - the architectural target is adapter-controlled bounded traversal inside scan-source reading the same `adapter_config`, not a CLI flag; budgets are unchanged when the config is absent.

## Operating it

```
cd tools/import-tool
node cleaner.js                      # one cycle: discover + reopen + venue clusters + process cleaner_batch_size claimed cases
node cleaner.js --max=100            # bounded batch (the backfill runs as batch → report → inspect → next batch)
node cleaner.js --loop=30 --max=250  # continuous: every 30 min (operational mode; scheduling is an ops decision)
node cleaner.js --issue=missing_image --max=20 --dry-run
node cleaner.js --case=<id> --now    # one case, ignoring its backoff, all remaining stages (controlled runs)
node cleaner.js --centroid-audit     # multi-signal city-centroid audit (=apply stamps LOW provenance)
node report-cleaner.js               # backlog / gain / source debt / historical vs new debt / awaiting retry
node cleaner-e2e-reopen.js           # isolated archive → evidence → reopen → resolve → dedup proof (self-cleaning)
node audit-cleaner-images.js [--apply]
```
- Runs on the admin machine (page fetches need a local IP like the relay; publishing needs the admin server on :4321). Several workers are safe (lease claiming, 0088); a second `--loop` refuses to overlap a live run unless `--force`.
- Settings (`automation_settings`, not yet in the admin form): `cleaner_enabled`, `cleaner_max_attempts` (3), `cleaner_backoff_hours` ([6,24,72]), `cleaner_batch_size` (40), `cleaner_cluster_min_size` (3), `cleaner_lease_seconds` (900).
- Scheduling is a machine-level decision (Task Scheduler entry for `node cleaner.js --loop=30`, alongside `relay-scan.js`) - not registered by the implementation.
- Nominatim is throttled to 1 request/1.1 s per process; a missing-location case costs ~10-25 s (page fetches + geocodes), address strings ~1.5 s, images ~5-10 s.

## Status at first backfill (2026-09-13 evening)

Backlog discovered: 2,527 issues — missing_location 296 (blocking, incoming), missing_required_metadata 292, incomplete_address 642 (live, coords without street), missing_image 443, missing_venue 408, missing_region 403, missing_schedule 43. Unexplained backlog: 0 (every case carries `opened_reason`). Stuck beyond retry window: 0.
Measured on the first batches: address strings 20/20 filled (reverse geocode, MEDIUM, provenance stored); missing_location ≈ 27% resolved per first attempt (8 of 60 merged into existing activities by the ingestion matcher, 7 located but held by the trust policy, 1 flagged as a possible update; the rest scheduled for attempt 2 with the venue-site stage, attempt 3 with place lookup, then archive); images 9 of 15 attached after listing-card discovery (all `event_specific`, provenance + rights flag by host). Venues: all 74 lacked coordinates — the Cleaner now derives them from Turu's own linked verified locations (HIGH) or the venue's address/name and writes them back, so later cases resolve from stage 1.
`report-cleaner.js` is the source of truth for the current numbers.

## Status at the continuation pass (2026-09-14)

Executed as bounded batches (baseline → batch → report → inspect → next), never as an unattended loop: batch 1 (12, clusters off), batch 2 (56, clusters on), two concurrent-worker tests (2 × 12, images), batch 3 (150, clusters on), batch 4 (120 exhausted `missing_location` cases with backoff ignored). Findings fixed mid-pass: `missing_venue` stopped at the first HIGH address without a venue (`needVenue`); discover raced between two workers (now an idempotent upsert); aggregator JSON-LD packs 22 cities into one address (single-place guard, `jsonld_multi_venue`, scan-source v40); non-place labels (organizers, "ברחבי העיר") archive `venue_not_found` immediately with the reason; unresolved clusters are not re-investigated while all members are already attempted.

| Metric | Before (baseline 09:00) | After (12:00) |
|---|---|---|
| Open cases | 2,261 | 1,852 |
| Resolved (total / with gain) | 447 / 293 | 831 / 336 |
| Archived (explained) | 0 | 139 = 119 `missing_address_unresolved` (every stage tried or recorded unavailable, external limit noted, reopen_when set), 19 `activity_expired_before_resolution`, 1 `ambiguous_location` (touring show) |
| Unexplained open / unexplained archived / stuck | 0 / – / 0 | 0 / 0 / 0 |
| Live non-playground activities without address | 175 (624 at Phase A) | 143 |
| Canonical venues enriched by the cluster step | – | 9 (all now carry address + coordinates), 1 created on HIGH evidence (ספריית רעות), 16 clusters declined with reasons (single-source MEDIUM evidence) |
| Suspected city-centroid locations | unknown | 51 stamped LOW → 59 `unverified_location` cases (not yet processed) |
| New rows ingested after the scan-source v39 deploy | – | 40, of which 37 with a street address, 0 Cleaner cases |

Concurrency: two simultaneous workers (`--worker=A/B`, then C/D) claimed disjoint cases both times (overlap 0); leases released on every terminal path; a killed run is reported `abandoned`. Reopen: `cleaner-e2e-reopen.js` on an isolated record - archive at attempt 3 with explanation → test venue+alias → `--reopen-only` reopened it (`reopened_count` 1, row back to `needs_review`) → resolved `existing_venue`/HIGH → published through `/approve` → exactly one activity, `activity_sources` `created`, location address with `monster:extracted` provenance → cleaned up. Images: 12 audited, 4 downgraded. Remaining blockers: ~120 archived incoming rows with no label and no city (aggregators) can only reopen when a venue/label appears; "תיאטרון הקרון" ×50 needs a human-added canonical venue (Jerusalem) - the Cleaner refused to create it on single-source evidence; Givatayim/Herzliya return 403 to the edge (relay-only); no Event JSON-LD source could be scanned live today (Ticketsi hits its budget before the first page).

## Acceptance criteria (brief §31) — where each is satisfied
1 revisit rejected/blocked missing-address items — `discover.js` (missing_location on every open/failed incoming row; rejected rows with a reopenable `archive_reason` via `reopen`). 2 multiple source types — `locationResolver.js` stages. 3 normal pipeline — `apply.js` → `POST /api/incoming/:id/approve`. 4 enrich, never duplicate — `matching.js` (`bestMatch`) + `enrichExistingFromCandidate`. 5 images — `imageResolver.js` + `imageProbe.js`. 6 image provenance — `activity_images.image_kind/image_page_url/retrieved_at/image_source_*`. 7 no weaker-over-stronger — fill-null merges in `apply.js`, LOW never written. 8 retry/backoff — `lifecycle.js` (`stagesForAttempt`/`remainingStages`, `nextAttemptAt`), tested. 9 terminal archives with reasons — `archiveCase` + `archive_reason` on cases/incoming/activities, tested. 10 reopen — `reopenWhereEvidenceChanged`, tested. 11 repeatable — `--loop`, `cleaner_runs`. 12 measurable — `report-cleaner.js`, `/cleaner`. 13 backlog processed — running (see status). 14 no unexplained state — `opened_reason` on every case, `unexplainedBacklog` metric. 15 shared core — cityNaming/venueNaming/eventFingerprint/matching mirror, `activity_sources`, thresholds from `automation_settings`, the same approve path.
