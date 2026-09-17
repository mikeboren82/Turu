# TURU — context from the shared discussion

Source: https://chatgpt.com/s/t_6aaaf03ac15c8191a14cf817b55fe568
Read on: 2026-09-16.

## Scope and status

The accessible shared page, titled "בחירת קטגוריות מבוקשות", exposed one assistant response containing a detailed proposed MISSING_CITY repair task. It did not expose the full preceding discussion. This document captures that available context, not unseen history.

The user asked to absorb the discussion as project context. This is not authorization to execute the historical prompt, write production data, or perform its rollout. No implementation or database claims below have been verified in this context-import task. Historical requirements must be distinguished from completed work.

## Product and architecture

- TURU helps parents find activities for children. Correct locality data must reach Results/ActivityCards as well as Activity Detail, search, filters, distance and maps.
- MONSTER ("המפלצת") owns normal ingestion and prevention of avoidable data defects.
- CLEANER ("המנקה") owns existing data debt, exceptional enrichment/repair and quality monitoring.
- Cleaner should feed recurring defect findings back into Monster so new debt decreases. Avoid building a permanent repair loop without addressing upstream causes.
- Fix canonical data and the appropriate mapping boundary rather than synthesizing a city in ActivityCard to conceal a data defect.

## Historical missing-city findings — verify before relying on them

- Approximately 207 published activities reportedly had coordinates but no city.
- Approximately 118 reportedly already had other Cleaner cases, but no missing-city case.
- Cleaner reportedly checked coordinates, street address, venue, image, schedule and region, but did not discover missing-city defects.
- Existing reverse geocoding was reported at `cleaner/reverse.js`, with rate limits; existing city normalization and canonical settlement infrastructure were also reported.
- The reported user-visible symptom was missing locality on some Results cards even though locality could be resolved/displayed in Activity Detail.
- Exact counts, paths, schema, field ownership, coordinate quality and causes must be audited against current code and data. Do not assume city lives directly on activities rather than a related location.

## Requested repair design

1. Audit affected published activities, available evidence, other Cleaner cases, actual card/detail data paths, existing discovery/resolution/provenance architecture and working-tree changes.
2. Integrate MISSING_CITY (or the established equivalent) into normal Cleaner discovery, lifecycle, resolution, confidence, retries, archive and reporting. Do not create a parallel subsystem.
3. Prioritize published activities with missing city and trustworthy coordinates. Reuse established definitions for null, empty, whitespace and invalid placeholders without rejecting unusual legitimate localities.
4. Keep case creation idempotent per activity and defect. Different defect types may coexist; fixing city must not alter unrelated cases.
5. Prefer trustworthy existing canonical venue/locality evidence and cached results before external lookups. Reuse the existing resolver/provider, normalization, settlement source of truth and confidence model.
6. Normalize geocoder output and validate against canonical settlements before proposing writes. Check geographic consistency with venue, address, region and source evidence. Respect coordinate-quality guards; city centroids are not precise venue coordinates.
7. Automatically repair only high-confidence cases. Seek corroboration where supported; leave ambiguous, unknown or conflicting cases reviewable with explicit reasons. Do not optimize for repairing every row at any cost.
8. Preserve provenance: repair origin, evidence, normalization/settlement result, time, confidence and provider role where supported by the existing model.
9. Protect against stale writes. If another process has already filled the city, close/resolve appropriately without overwriting it. Do not broaden missing-city repair into correction of existing valid cities.

## Historical execution and validation requirements

- Full-cohort dry run before production changes. Report safe activity IDs, coordinates, venue/region evidence, raw/normalized locality, canonical match, confidence, proposed action and reason.
- Classify proposals as AUTO_FIX_HIGH, NEEDS_CORROBORATION, CONFLICT, UNRESOLVED, INVALID_COORDINATES, ALREADY_FIXED or an explained alternative.
- Inspect distributions for systemic anomalies: unexpected concentration in a city, administrative-area results, settlement mismatches, region conflicts, alias failures and centroid artifacts. Fix systemic causes and repeat dry run before applying proposals.
- The historical task called for an initial bounded high-confidence batch (e.g. 10–20), database and actual application verification, then larger bounded batches. This records the old task, not current production-write authorization.
- Verify repaired locality on actual Results cards and Activity Detail, and check related search/filter/distance/map behavior. If canonical data is correct but the card is wrong, inspect query selection, serialization, mapping and cache at the correct boundary.
- Rescan for duplicate cases, reopened repaired cases and repeated writes. Explain every unresolved class.
- Preserve rate limits, caching, backoff, retries and bounded concurrency; do not issue hundreds of concurrent geocoder requests or bypass provider limits.
- Use existing case/schema/reporting systems; any necessary migration should be additive and backward compatible.
- Preserve unrelated working-tree changes. The historical task explicitly required no commit and no push.

## Upstream prevention

After establishing the repair, trace actual ingestion causes: extraction omissions, lost venue locality, normalization failures, create/update mapping, cleared values, legacy imports or publication policy. Measure rather than assume.

Implement only a small, safe systemic prevention when appropriate. Reuse shared locality infrastructure; do not duplicate Cleaner geocoding in Monster or make publication depend on a slow external lookup without architectural support. Temporary enrichment failure should not automatically block otherwise valid activities. Report a precise follow-up if prevention requires a risky redesign.

## Regression coverage and reporting

Cover discovery, duplicate discovery, canonical match, alias normalization, unknown locality, conflicting evidence, already-valid city, concurrent filling, unrelated cases, post-repair rescan, geocoder failure/rate limits, weak/centroid coordinates and supported Hebrew/English aliases.

Extend existing metrics for published missing-city debt, opened/fixed/already-fixed/conflict/unresolved/review cases, reverse-geocode attempts/success and canonical/normalization outcomes.

The expected implementation report includes baseline counts and evidence, Cleaner blind spot, implementation, dry-run distribution/anomalies, rollout batches, before/after debt, actual UI verification, unresolved reasons, idempotency, Monster root causes and prevention, tests, changed files, migrations, external-service impact and remaining risks.

Success means correct canonical locality and visible card data, safely repaired high-confidence debt, automatic future detection, preserved provenance and unrelated work, idempotent operation, measured remaining debt and reduced upstream recurrence. A new case type alone is not completion.
