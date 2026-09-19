# CONTINUOUS MONSTER — Phase A: current automation map + proposed architecture (2026-09-19)

Base: MAIN `5014295` (stabilization program `a510914` integrated; 0100 applied; **0099 NOT applied and stays blocked**). Work happens in the dedicated worktree `C:\Users\mbore\turu-continuous-monster` (branch `continuous-monster`) so MAIN's uncommitted UI work is never touched.

## A. What exists today (audit of repository + live environment)

| Capability | What exists | Scheduled? | Manual? | Notes / discrepancies |
|---|---|---|---|---|
| Source registry | `public.sources` (204 rows: 133 active non-social, 46 social, 76 `auto_paused`), `source-manifest.json` = registry-as-data, `seed-venues-and-sources.js` upsert | — | registration is manual (manifest + seed) | 93 healthy / 37 failing / 3 backed_off among the active; 12 with detail traversal, 1 sitemap |
| Active source scanning | edge fn `scan-source` (extraction → JSON-LD → detail traversal → identity/dedup → approval gate → provenance → health), `_scan_due_sources_cron()` picks ≤ 20 due non-relay sources by `priority desc, next_scan_at` | **YES — pg_cron `scan-due-sources` every 15 min** (`scanning_enabled` setting) | admin "scan now" (`/api/sources/:id/scan-now`, RPC `scan_source_now`) | frequencies: 72 h ×93, 168 h ×30, 120 h ×9, 24 h ×1 → ~20–27 scans/day observed (656 scans / 30 d, 403 ok, 207 error); per-scan budgets: 60 s AI, 105 s detail, ≤ 20 AI calls, ≤ 8 discovered pages, ≤ 50 activities |
| Relay for WAF-blocked sources | `relay-scan.js` (local IP fetch → `relay_scan_source` RPC) | **NO** | yes | 10 active `local_relay` sources, **all last scanned 09-13/14** (Holon, Tel Aviv, Lod, Carmiel, Haifa libraries…) — stale because nothing runs the relay |
| Source health / backoff | `_shared/sourceHealth.ts` state machine (healthy → failing → backed_off → attention_required → auto_paused), exponential `next_scan_at`, never pauses priority ≥ 8 or transient kinds | inside every scan | — | 36 failing sources are mostly `access_403_waf` → relay candidates; nothing re-probes the 76 paused sources |
| Expiration | `_cleanup_expired_activities_cron()` (one-time events whose dates all passed → `archived/expired`) | **YES — pg_cron daily 03:00** | `cleanup_expired_activities(dry_run)` | only one-time events expire; recurring/fixed-hours never do |
| Missing-from-source | scan-source increments `consecutive_missing_scans`, at `missing_scan_threshold` (3) creates a review row (`extracted_data.consecutive_missing_scans`) | inside scans | human decides | 242 live source-fed activities already at ≥ 3 missing scans → review-queue debt |
| Recurring-activity refresh / venue refresh | none (venues: 106, only 31 with coordinates; Cleaner clusters enrich them) | — | — | MISSING |
| Review queue | `incoming_activities` (`new` 565, `needs_review` 394 new + 258 updates + 22 dup), admin UI, `reprocess-review-queue.js` (policy re-evaluation, dry-run default) | — | manual | 3,885 candidates found in 7 d (09-13 bulk), 2,262 reviewed; queue is the landfill risk |
| Cleaner | `cleaner.js` bounded batch (discover → reopen → clusters → ≤ 40 claimed cases), leases, run guard, `report-cleaner.js` | **YES — Windows task "TuRu Cleaner pilot" every 20 min from MAIN** (local laptop) | `--issue/--case/--dry-run` | PILOT, not durable; first post-integration run (19:40 local): 40 inspected, 16 resolved, 8 archived, 0 errors, 0 write_denied, 0 reopened, no city_not_canonical / Palestinian mutation, backlog 1,233 |
| Source discovery | `discover-sources.js` (SerpAPI queries → fetch-verify → classify → candidates JSON → human approval → manifest → seed) | **NO** | yes | SerpAPI quota exhausted (2026-09-13); no free path exists |
| Coverage / gaps | `report-coverage.js` (region × family × category, yield, productivity, detail yield, gaps list), `audit-source-coverage.js` (sitemap vs catalogue) | **NO** | yes | last run 09-17 (before the 0098 region remap: shows "0 active sources" for North/Valleys/Shfela/South) |
| Settlement scan (Google Places) | `scan-settlement-gaps` + pg_cron 03:00 | cron row active but `settlement_scan_enabled=false` | — | RETIRED by decision; harmless |
| Social | registry rows, `NOT_CONFIGURED` | — | — | blocked on a Meta app; out of scope |
| "Run the Monster" orchestration | none; `run-monster-cohort.js` (validation), `_continuous-enrich.sh` (frozen one-off loop) | — | — | MISSING |
| Service-area policy | `cleaner/cityResolver.js`: foreign country (jo/eg/lb/sy) → `outside_israel` archive; `ps` + no CBS settlement ≤ 2 km → `palestinian_locality` → **human judgment** (37 cases) | inside Cleaner | — | no prevention at ingestion; policy now decided (§C) |

Documentation vs code: THE-MONSTER.md says the relay "runs on the admin machine (not scheduled)" — true; THE-CLEANER.md says the pilot is unattended — true but local; the coverage report file predates the region remap (numbers wrong until rerun). No other discrepancies found.

**Safe to automate now:** relay scans (local), Cleaner batches (already), coverage report (read-only), cadence tuning (bounded settings writes), paused-source re-probe (read-only + reporting), service-area prevention (deterministic, offline).
**Still human:** registering/activating a discovered source (trust decision), review-queue decisions, ambiguous service-area cases, changing RLS (0099), any change to scan budgets that affects AI cost.

## B. Proposed continuous architecture (extend, don't replace)

```
DURABLE (Supabase, already there)                     LOCAL ORCHESTRATOR (monster.js, pilot on the admin machine)
pg_cron scan-due-sources */15 → scan-source           hourly `node monster.js cycle` (bounded, overlap-locked):
pg_cron cleanup-expired daily                           relay        : relay-scan.js for due local_relay sources (max N)
                                                        cleaner      : cleaner.js --max=40 (or the existing pilot task, not both)
                                                        coverage     : report-coverage.js (weekly) → gaps → discovery targets
                                                        discovery    : bounded OSM-based venue/source candidates (weekly, ≤ 20, inactive rows, human activates)
                                                        cadence      : tune-source-cadence.js (weekly, dry-run → apply, bounded)
                                                        reprobe      : probe auto_paused / failing-403 sources from the local IP (monthly, report + relay proposal)
                                                        status       : monster-status.json + one-line summary every cycle (heartbeat)
```
Job model, cadences, prioritization, service-area prevention, observability and the pilot→durable migration path are specified in THE-MONSTER.md §10 (written in Phase B) and in the final report.


---

# FINAL PRE-ACTIVATION REPORT (Phase C complete, 2026-09-19) — the production schedule is NOT activated

Worktree `C:\Users\mbore\turu-continuous-monster`, branch `continuous-monster`, base MAIN `5014295`. MAIN was never touched. Nothing was pushed. Migration 0099 was NOT applied. The historical cohort was NOT mutated. The indoor-play coverage pass was NOT started.

## A. Automation audit — what runs today (verified against the live project)
See section A above. Summary: scanning is already continuous (pg_cron `scan-due-sources` every 15 min → ≤ 20 due sources → `scan-source`; ~28 scans / 24 h; 133 active non-social sources: 93 healthy / 40 failing / 76 auto_paused); expiry is daily (pg_cron). Everything else was manual: relay scans for 10 WAF-blocked sources (stale since 09-13/14), the Cleaner (local Windows task "TuRu Cleaner pilot", every 20 min), source discovery (SerpAPI, exhausted), coverage reporting (last JSON 09-17, pre-0098 remap), re-probing paused sources (never). No orchestration, no heartbeat, no service-area rule beyond the Cleaner's foreign-country archive.

## B. Documentation vs code discrepancies found
| Doc | Says | Code / live | Fixed? |
|---|---|---|---|
| THE-MONSTER.md §7 | relay "runs on the admin machine (not scheduled)" | true — and had not run since 09-13/14 | §10 now defines the relay job (6-hourly, max 6) |
| THE-CLEANER.md | pilot runs every 20 min via Windows task | true; the task was disabled/re-enabled during the stabilization program and is running (first post-integration run 19:40 local: 40 inspected, 16 resolved, 8 archived, 0 errors, 0 write_denied) | noted; the Monster cycle must not double-schedule it |
| stabilization report | `scan-settlement-gaps` cron row "retired" | cron row still present, gated by `settlement_scan_enabled=false` | documented as retired-but-present; no change (needs owner DDL) |
| THE-MONSTER.md §9 | 0100 "pending" | 0100 applied 2026-09-19 | wording left; §10 states current state |
| coverage report | `coverage-report-2026-09-17.json` used by `monster.js status` | generated before the 0098 category remap → gap list partly stale | the weekly coverage job regenerates it; not rerun now (read-only, would be the first cycle's output) |
| cityResolver | `ps` + no CBS settlement ≤ 4 km → `outside_israel` archive candidate | that heuristic is superseded by `lib/serviceArea.js` (geographic PA reference); `ps` without a PA-locality match is now AMBIGUOUS, never an archive | Cleaner branch updated |

## C. Service-area policy (product rule) — how it is implemented
- **Rule**: a location is out of scope only when its coordinates fall inside a Palestinian-Authority-administered locality (reference: 115 localities — Nominatim `countrycodes=ps` place-class records + curated centre coordinates for the ones Nominatim does not resolve; radius city 4 km / town 2.5 km / village, camp 1.5 km) and no CBS settlement is within 4 km. Never inferred from names, language, sources, audience or population. Israeli Arab localities are CBS settlements → always IN_SCOPE (asserted by tests: Umm al-Fahm, Rahat, Nazareth, Tayibe, Kafr Qasim, Shefa-Amr, Abu Ghosh).
- **Grey zone stays grey**: PA locality with a CBS settlement 1–4 km away → AMBIGUOUS (Hebron centre vs Kiryat Arba; Birzeit vs Beit El; Al-Zawiya vs Elkana); reverse geocode `ps` without any PA-locality match → AMBIGUOUS. Ambiguous is never excluded and never auto-mutated.
- **Where it runs**: Node `lib/serviceArea.js` (Cleaner, approve path, audit, discovery) and Deno `_shared/serviceArea.ts` (scan-source), same rule order, twin tests.
- **Prevention at the earliest safe point**: in scan-source the check happens inside `autoApproveNewActivity` right after coordinates are verified — before an activity or location row is written (a location created a moment earlier is deleted). The candidate lands in `incoming_activities` as `rejected` / `archive_reason=outside_service_area` with the verdict in `extracted_data.service_area`; the scan log counts it (`listing_metrics.outside_service_area`); the next scan of the same source skips a candidate with the same name that was already rejected as outside (`skipped_outside_service_area`) — no re-extraction, no AI call. The Node approve path refuses with 422 `OUTSIDE_SERVICE_AREA`; the Cleaner hand-back rejects; the Cleaner's Palestinian-locality branch archives only CONFIRMED rows (verified write; `write_denied` recorded when RLS refuses). `report-coverage.js` counts excluded rows separately and never as a gap.
- **What it does NOT do**: no row is deleted; no source is blocked because of its language; no Cleaner or scan path decides on a name.

## D. The 37 deferred rows — deterministic rediscovery + DRY-RUN classification (§19 mutation gate)
Rediscovery: `cleaner_cases` with `issue=city_not_canonical` whose resolution note starts with `PALESTINIAN` → 37 cases → 37 published activities, all with coordinates. Classification: offline (PA reference + CBS centroids) plus cached reverse-geocode evidence (Nominatim, `logs/reverse-cache.json`; 0 live calls). Report: `service-area-audit-2026-09-19.json` (ids, stored city, coordinates, verdict, confidence, evidence, proposed mutation, rollback).

| Class | Count | Proposed mutation |
|---|---|---|
| A_CONFIRMED_OUTSIDE_SERVICE_AREA | 19 | archive activity (status=archived, archive_reason=outside_service_area) + Cleaner case archived with the same reason — ONLY after approval |
| B_IN_SCOPE_ISRAEL | 4 | keep published; close the Cleaner case as in scope (no activity write). All 4 are IN_SCOPE by default (no PA match, CBS settlement 2.2–3.6 km, reverse=ps) — confidence MEDIUM |
| C_AMBIGUOUS_LOCATION | 14 | no mutation; case stays requires_human_judgment |
| D_DATA_ERROR | 0 | no mutation; coordinates need repair first |

| Class | Activity id | Stored city | Name | Coordinates | Evidence |
|---|---|---|---|---|---|
| A | `ee5c0fcf-59b8-48ca-b20a-5d6e4d682141` | المصدر | גן שעשועים – شارع رقم 2, المصدر | 31.4152307,34.3682327 | inside Al-Musaddar (village, 0.77 km from its centre), no CBS settlement within 4 km |
| A | `995d04be-a6a5-4c98-97a0-8db6adf9410b` | البريج | גן שעשועים – صلاح الدين, البريج | 31.4356184,34.3836534 | inside Al-Maghazi (town, 1.46 km from its centre), no CBS settlement within 4 km |
| A | `6e7e695b-5419-4cc7-a530-24590164ff69` | البريج | גן שעשועים – Al-Borag, البريج | 31.4437112,34.4103985 | inside Al-Bureij (town, 0.71 km from its centre), no CBS settlement within 4 km |
| A | `75a7b52d-34a8-4954-aa5c-4120e8ba63a6` | غزة | גן שעשועים – Sharia Aoun Al-Shawa, غزة | 31.4991084,34.4314784 | inside Gaza City (city, 2.95 km from its centre), no CBS settlement within 4 km |
| A | `b0c68152-71fd-42a9-a3c2-13f339501c09` | الجديدة | גן שעשועים – شارع شهداء البطش, الجديدة | 31.5061312,34.4768969 | inside Gaza City (city, 1.93 km from its centre), no CBS settlement within 4 km |
| A | `96f06abf-4834-4380-b34f-980a96627337` | غزة | גן שעשועים – شارع اليرموك, غزة | 31.5157006,34.4544332 | inside Gaza City (city, 0.47 km from its centre), no CBS settlement within 4 km |
| A | `bfe429fd-2371-4f15-9327-21c4c0f4bda5` | غزة | גן שעשועים – شارع القنال, غزة | 31.5179743,34.4560908 | inside Gaza City (city, 0.60 km from its centre), no CBS settlement within 4 km |
| A | `7b6be34b-2079-40ec-8322-1c8aacb2a09b` | غزة | United Nations Park | 31.5233409,34.4384848 | inside Gaza City (city, 2.20 km from its centre), no CBS settlement within 4 km |
| A | `f2fb8a8a-86e8-4b93-9412-31853144981f` | غزة | גן שעשועים – شارع كمال ناصر, غزة | 31.5229363,34.4718474 | inside Jabalia (city, 1.22 km from its centre), no CBS settlement within 4 km |
| A | `5b3f1d67-8a13-4fad-9976-6a7f47658b9b` | غزة | גן שעשועים – شارع عمرو بن العاص, غزة | 31.5240766,34.4521655 | inside Gaza City (city, 1.37 km from its centre), no CBS settlement within 4 km |
| A | `63b59bfa-7955-4de7-b93a-e84befa02353` | جباليا | גן שעשועים – شارع الصفطاوي, جباليا | 31.53445,34.4742189 | inside Jabalia (city, 1.10 km from its centre), no CBS settlement within 4 km |
| A | `e68bbbdd-c051-447e-b74c-401b06c9c3fa` | غزة | גן שעשועים – شارع عز الدين القسام, غزة | 31.5400946,34.4619458 | inside Jabalia (city, 2.41 km from its centre), no CBS settlement within 4 km |
| A | `c2569e7c-7a30-49ed-aebc-67f32965bc64` | جباليا | גן שעשועים – شارع البحر, جباليا | 31.5402048,34.4805968 | inside Jabalia (city, 1.36 km from its centre), no CBS settlement within 4 km |
| A | `47065b0c-dcbc-4fb5-a337-d82f9dc9246c` | بيت لاهيا | גן שעשועים – Al Masmeya, بيت لاهيا | 31.5415751,34.4999632 | inside Beit Lahia (city, 2.00 km from its centre), no CBS settlement within 4 km |
| A | `b70b4514-6c4d-42ef-bea1-6d8f55bd29dd` | بيت ساحور | גן שעשועים – شارع عش غراب, بيت ساحور | 31.6991968,35.2381171 | inside Beit Sahour (town, 0.86 km from its centre), no CBS settlement within 4 km |
| A | `1b6da6a1-c71a-47e1-bc1f-b81f5ee7417c` | رام الله | גן שעשועים – Al Mustakbal, رام الله | 31.9132392,35.178625 | inside Ramallah (city, 2.15 km from its centre), no CBS settlement within 4 km |
| A | `94556a6c-7a2c-43ec-a3bb-b70fd77072ed` | رام الله | גן שעשועים – شارع الطيرة, رام الله | 31.9167256,35.1847933 | inside Ramallah (city, 2.22 km from its centre), no CBS settlement within 4 km |
| A | `36b13d0c-c6bb-452a-a2b6-01e01ab81445` | مركة | For Football | 32.394772,35.2360469 | inside Marka (village, 0.03 km from its centre), no CBS settlement within 4 km |
| A | `cf495945-650c-4599-9b56-b281a34f67b5` | بيت عور التحتى | גן שעשועים – Bait Owr Altehta, بيت عور التحتى | 31.8937605,35.0781189 | inside Beit Ur al-Tahta (village, 0.69 km from its centre), no CBS settlement within 4 km |
| B | `5f28f5c2-3832-4db9-ba28-0187894b493f` | תפוח מערב | גן שעשועים – תפוח מערב | 32.0988595,35.2320548 | no Palestinian-administered locality matches these coordinates |
| B | `88dc68f3-bb55-46f4-925d-699d21459274` | علي غنيم | גן שעשועים – علي غنيم | 31.6787329,35.1007468 | no Palestinian-administered locality matches these coordinates |
| B | `2439ff91-03cb-4fae-8779-69cea14d6e63` | סנה יעקב | גן שעשועים – ציר גלעד, סנה יעקב | 32.1908531,35.1825676 | no Palestinian-administered locality matches these coordinates |
| B | `ab177a72-f34b-46b6-b9ee-6de43ad10bfe` | Khirbet Ma'in | גן שעשועים – comet center, Khirbet Ma'in | 31.383221,35.1350776 | no Palestinian-administered locality matches these coordinates |
| C | `5e1e8e46-3548-4ea9-aa3f-9a86bde21d70` | מועצה אזורית מגילות ים המלח | HADEEKAT ALBAT | 31.421053,35.2366954 | reverse geocode says ps, no CBS settlement within 4 km, no PA locality match - unresolved |
| C | `457fcb20-f1e5-4e24-967f-00cdb5d15f4c` | خربة الكرمل | ملعب ابو الحج | 31.4262544,35.1261865 | PA locality Khirbet al-Karmil (0.70 km) and CBS settlement אביגיל 2.96 km away - two claims on one point, a person decides |
| C | `81551f4c-df5c-4bfe-8d4a-a6c0f98fd6cc` | رام الله | גן שעשועים – شارع جبرا إبراهيم, رام الله | 31.9068507,35.1910516 | PA locality Ramallah (1.01 km) and CBS settlement פסגות 3.32 km away - two claims on one point, a person decides |
| C | `25953125-b6cf-4a86-9f96-02ddcb7849bf` | رام الله | גן שעשועים – Esack Michael, رام الله | 31.908092,35.2053889 | PA locality Al-Bireh (1.01 km) and CBS settlement פסגות 2.12 km away - two claims on one point, a person decides |
| C | `e51f0f3b-afcb-44b4-8c9c-83a70400aa14` | رام الله | Birzeit Housing Association Playground | 31.9166163,35.1744962 | PA locality Ramallah (2.69 km) and CBS settlement דולב 3.87 km away - two claims on one point, a person decides |
| C | `8389cdb3-7607-4c60-be3e-e11c7c162252` | بيرزيت | גן שעשועים – بير زيت, بيرزيت | 31.9660931,35.1911345 | PA locality Birzeit (0.78 km) and CBS settlement בית אל 3.98 km away - two claims on one point, a person decides |
| C | `e71a9dd6-5800-47cb-adea-7bf5a67c6a65` | سلفيت | Shalal Land | 32.0826353,35.1475727 | reverse geocode says ps, no CBS settlement within 4 km, no PA locality match - unresolved |
| C | `37ee0326-bfe0-4ad6-a8a9-b8b70ce76286` | عزبة الطبيب | Liberation Garden | 32.1809439,35.033577 | PA locality Azzun (2.44 km) and CBS settlement אלפי מנשה 2.05 km away - two claims on one point, a person decides |
| C | `6f6d1a1d-aa09-4b3c-891d-c9a44b9c07c2` | مخيم عسكر (الحديد) | גן שעשועים – عسكر الجديد, مخيم عسكر (الحديد) | 32.2197714,35.2970889 | PA locality Askar camp (0.08 km) and CBS settlement אלון מורה 3.25 km away - two claims on one point, a person decides |
| C | `0f4cbb99-1a64-4c04-990f-2642575a8085` | مخيم جنين | Borken football playground | 32.4522981,35.258312 | reverse geocode says ps, no CBS settlement within 4 km, no PA locality match - unresolved |
| C | `1c484a51-a8fb-4944-9797-c5aa580a9421` | العيزرية | גן שעשועים – Aleskan, العيزرية | 31.7765647,35.2659925 | PA locality Al-Eizariya (0.71 km) and CBS settlement מעלה אדומים 3.14 km away - two claims on one point, a person decides |
| C | `69f89b73-66b5-43b1-8ea8-01b0aa926703` | مخيم عقبة جبر | גן שעשועים – مخيم عقبة جبر, مخيم عقبة جبر | 31.8445759,35.4392294 | PA locality Aqabat Jabr camp (0.62 km) and CBS settlement ורד יריחו 2.09 km away - two claims on one point, a person decides |
| C | `682e025c-44af-47d3-8f3d-ec6a47e958a0` | الزاوية | גן שעשועים – al zawia, الزاوية | 32.0910937,35.0309876 | PA locality Al-Zawiya (0.95 km) and CBS settlement אלקנה 2.46 km away - two claims on one point, a person decides |
| C | `8304488b-067f-4cc3-afc1-1eeecbb1bac7` | מועצה אזורית מגילות ים המלח | גן שעשועים – מועצה אזורית מגילות ים המלח | 31.6763527,35.4369107 | reverse geocode says ps, no CBS settlement within 4 km, no PA locality match - unresolved |

**Whole-catalogue scan** (`--all`, 5,682 published rows with coordinates → `service-area-audit-2026-09-19-all.json`): A 22 (the 19 above + 3 OSM-imported rows with no city inside Gaza/Jabalia/Deir al-Balah: `51854157-edbf-407e-8031-97d559151874`, `cee0d44e-d584-4831-ba7f-2aaaf515130c`, `9d1e6bd6-790d-47a4-b000-0042daa7e024` — reported, not part of the 37-row gate), C 137 (14 cohort + 123 others, almost all Israeli border neighbourhoods: Jerusalem × Anata / Bethlehem / Beit Sahour / Abu Dis / Al-Eizariya 52, Ma'ale Adumim × Anata 13, Kiryat Arba / Hebron 10, Ariel, Elkana, Kedumim, Efrat, Karnei Shomron — AMBIGUOUS means untouched), B 5,523, D 0. Not one Israeli Arab locality appears in A or C.

**Reliability limits (STOP condition "unreliable evidence" respected by not mutating)**: the PA reference has 115 localities (not exhaustive) — "no PA match" is weak evidence, so the 4 B rows are in scope by default, not by proof; a big Israeli city has one CBS point, so the classifier now treats a record that names a CBS settlement within 8 km as AMBIGUOUS instead of OUTSIDE (`cityHint`, both twins, tested) — this changed no verdict in the catalogue (0 rows) but protects future candidates in Jerusalem's eastern neighbourhoods.

**Rollback for any approved archive**: `update activities set status='published', archive_reason=null, archived_at=null where id = any(<ids>) and archive_reason='outside_service_area'` — the rows are never deleted; the audit JSON is the id list. **No mutation was performed.** A production mutation needs the owner's explicit approval per class (recommended: A only; C stays open as `requires_human_judgment`; B keeps published; D none found).

## E. Job model (what / where / cadence / max work / why) — THE-MONSTER.md §10 table
Durable (Supabase pg_cron): scanning every 15 min ≤ 20 sources; expiry daily 03:00. Local pilot (`monster.js cycle`, hourly): relay every 6 h ≤ 6; Cleaner hourly ≤ 40; coverage weekly (read-only); discovery weekly ≤ 20 INACTIVE registrations; cadence weekly ≤ 40 frequency changes within a scans/day budget; re-probe monthly ≤ 30 (proposal only); heartbeat every cycle. Each cadence carries its evidence in `lib/monsterJobs.js` (lead-time distribution p25/50/75 = 5/14/31 d, relay backlog, Cleaner throughput).

## F. Source prioritization + cadence policy (evidence)
`lib/sourceCadence.js` classifies sources (events / venue / social) and proposes frequencies from 30-day yield. Dry run on the live registry (`source-cadence-2026-09-19-dryrun.json`): 133 sources, 113 proposed changes; expected scans/day today 38.1. Without a budget the policy would raise it to 93.5 (cost); with the default budget of 60 scans/day the least productive daily sources are demoted first → classes events:24 h ×5, 48 h ×88, 72 h ×26; venue 72 h ×3, 168 h ×7, 336 h ×4. **AI-cost implication**: ~44 AI calls per 28 scans today (~1.6 per scan) → at 60 scans/day ≈ 95 AI calls/day (≈ +55 %); the budget is a flag (`--budget`), default 60, and applying is a separate weekly bounded job that has NOT run.

## G. Bounded discovery (no crawling)
`discover-sources-osm.js`: Overpass queries per (region bbox, family) for OSM venue records with a website, inside the service area, host-deduplicated against `sources` and `venues`, fetch-verified (Hebrew text, child/event keywords, block/unreachable detection), region = nearest CBS settlement (the query box is the 5th–95th percentile of the region's centroids, so one mislabelled settlement cannot widen it to half the country), registered INACTIVE (`disabled_reason=discovery_candidate…`, trust 50) — a person activates. Dry runs (region השרון, families community_center/library/museum, max 10): the first run with a min/max region box pulled 60–110 OSM elements from half the country (Haifa, Jerusalem, Ariel were labelled "השרון" by the query); with the percentile box and region-by-nearest-settlement the final run sees 14 elements → 1 known host, 3 without website, 2 non-Hebrew, 1 blocked, 4 scrapable → 4 would register (Ra'anana library, Rimonim community centre, Beit Moreshet Herzliya, Kiryat Tivon library — the last regioned חיפה והקריות by its nearest settlement), 0 outside service area, 2 ambiguous (kept, flagged). Nothing registered (`discovery-candidates-osm-2026-09-19.json`). Coverage-driven targeting: the weekly coverage JSON's gap list (regions with 0 active sources: הצפון והגליל, עמק יזרעאל והעמקים) is what the operator should pass as `--regions` first.

## H. Re-probe (paused / 403 sources)
`reprobe-sources.js --max=12` (report only): of 12 probed, 9 answer from the local IP with Hebrew content (Kfar Saba library + city, Herzliya community centres, Petah Tikva events, Ashdod, Givatayim, Lev HaSharon, Kiryat Motzkin, iTravelJerusalem), 1 answers without content, 2 unreachable. Proposal (not applied): strategy `local_relay` + reactivate for the 9 → they would enter the relay job. Applying is `--apply`, gated on approval (it adds ~9 relay sources → relay max per cycle may need 8).

## I. Idempotency, isolation, containment
- Scans: `scan-source` identity/dedup + per-source `next_scan_at`; relay uses the same RPC; a repeated cycle re-scans nothing that is not due.
- Cleaner: leases + run guard + `verifiedUpdate`; outside-service-area rejections are remembered per source and never reopened.
- Cadence: value-guarded updates (`eq('scan_frequency_hours', current)`), bounded per run, never below 24 h.
- Discovery / re-probe: dedupe against the registry; INACTIVE rows only; proposals only.
- Orchestrator: file lock (stale 3 h), per-job child process with 45-min timeout, per-job state (`lastStatus`, `lastTail`), cycle continues after a failure; `--dry-run` mutates nothing (test: recording client sees zero writes).
- Kill switches: `monster.js pause` (`automation_settings.monster_enabled=false`), `scanning_enabled=false`, `cleaner_enabled=false`; Task Scheduler `schtasks /Delete /TN "TuRu Monster" /F`.

## J. Human-review budget + observability
`lib/reviewBudget.js` buckets every queue row by its actual reason (auto_approved, duplicate, outside_service_area, rejected_not_for_children, unresolved_location, missing_from_source, update_for_review, cleaner_resolvable_location / metadata, held_untrusted_source, low_confidence_extraction, requires_human_judgment) and emits signals (`review_debt_growing`, `review_queue_large`, `queue_mostly_cleaner_resolvable`). Live now: review open 1,236 (human-only 978); Cleaner open 1,222 (7-day +4,756 / −2,504, increasing — most of the inflow is the stabilization program's reopen pass, which the hourly Cleaner job is sized to drain at ~1,000 cases/day). `monster.js status` writes `monster-status.json` and one summary line per cycle (scans, AI calls, candidates, published, outside blocked, Cleaner results, backlog trend, failing sources, coverage gaps).

## K. Deployment model — PILOT vs PRODUCTION, exact activation
- **Durable today**: pg_cron scanning + expiry (unchanged).
- **Pilot (proposed, not activated)**: Windows Task Scheduler on the admin laptop, hourly:
  `schtasks /Create /TN "TuRu Monster" /SC MINUTE /MO 60 /TR "cmd.exe /c C:\Users\mbore\turu-continuous-monster\tools\import-tool\monster.cmd" /F`
  and on the same day disable the "TuRu Cleaner pilot" task (the Monster cycle runs the Cleaner job), or keep the Cleaner task and run the Monster with the cleaner job excluded — one of the two, never both.
  Max work per hour: relay ≤ 6 (every 6 h), Cleaner ≤ 40 cases, weekly: coverage (read-only), discovery ≤ 20 inactive rows, cadence ≤ 40 changes; monthly: re-probe ≤ 30 proposals. Expected daily volume after activation: scans unchanged (38/day) until the cadence job is approved; Cleaner ≤ 960 cases/day; relay ≤ 24 source scans/day; AI calls ≈ today's 44/day until cadence changes.
- **Rollback**: `schtasks /Delete /TN "TuRu Monster" /F`, or `node monster.js pause`. Cadence rollback: `source-cadence-<date>-applied.json` lists `current` per source.
- **Production**: the laptop is a single point of failure. Path: (1) same `monster.cmd` on an always-on host with an Israeli IP; (2) then move the Cleaner's fetch stages to an edge function; (3) pg_cron stays the scheduler of record. Requires a host decision (cost) → STOP condition, not done.
- **scan-source deploy**: the service-area prevention in `scan-source/index.ts` is written and type-checked but NOT deployed (deploying changes production ingestion → needs approval; command `npx supabase functions deploy scan-source`).

## L. Tests
- Node (`tools/import-tool`): 126 tests pass (`node --test tests/*.test.js`), including `tests/serviceArea.test.js` (geographic rule, Israeli Arab localities in scope, ambiguity, DATA_ERROR) and `tests/continuousMonster.test.js` (bounded jobs, cadence selection, lock staleness, scheduler command, cadence policy + budget, review buckets, dry-run zero writes).
- Deno (`supabase/functions/_shared`): 168 pass, 1 fail — the one failure is the pre-existing escape-room relevance test (HEAD baseline, unrelated). `deno check scan-source/index.ts`: no type errors.

## M. Git — files touched on `continuous-monster` (committed, NOT pushed)
Modified: `supabase/functions/scan-source/index.ts`, `tools/import-tool/{cleaner.js, cleaner/apply.js, server.js, relay-scan.js, report-coverage.js, THE-MONSTER.md, THE-CLEANER.md}`.
New: `supabase/functions/_shared/{serviceArea.ts, serviceArea.test.ts, paLocalities.json}`, `tools/import-tool/{CONTINUOUS-MONSTER.md, monster.js, monster.cmd, audit-service-area.js, build-pa-localities.js, discover-sources-osm.js, reprobe-sources.js, tune-source-cadence.js, lib/{serviceArea.js, monsterJobs.js, sourceCadence.js, reviewBudget.js, sourceDiscovery.js}, reference/pa-localities.json, tests/{serviceArea.test.js, continuousMonster.test.js}}` and the dry-run reports `service-area-audit-2026-09-19.json`, `source-cadence-2026-09-19-dryrun.json`, `discovery-candidates-osm-2026-09-19.json`, `reprobe-sources-2026-09-19.json`. Not committed: `monster-status.json`, `logs/*`. MAIN's uncommitted UI work is untouched.

## N. Blockers, STOP conditions hit, approvals requested
1. **Migration 0099** remains blocked (not applied, not weakened). Consequence: the Cleaner cannot update NULL-owner activities → any approved archive of class A rows may end as `write_denied` and be recorded as such; the owner would run the archive as admin.
2. **Activate the pilot schedule?** — the `schtasks` command above (and disable the Cleaner pilot task the same day). Not executed.
3. **Deploy `scan-source`** with the service-area prevention? Not deployed.
4. **Archive the class A rows** of the 37-row cohort (ids in section D)? Not mutated. Class C stays `requires_human_judgment`.
5. **Apply the cadence plan** (`tune-source-cadence.js --apply --max=40 --budget=60`)? Adds ≈ 55 % AI calls/day. Not applied.
6. **Apply the re-probe proposals** (9 sources → relay + reactivate)? Not applied.
7. **Register discovered sources** (weekly ≤ 20 INACTIVE rows) — part of activation; the first dry run is in `discovery-candidates-osm-2026-09-19.json`.
8. **Production host** for durable execution — cost decision, not made.
9. Push of `continuous-monster` — not done (needs approval).
