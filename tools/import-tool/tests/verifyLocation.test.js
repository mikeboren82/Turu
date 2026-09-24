// Cleaner verify_location Phase 2 (2026-09-24): evidence ladder, wrong-shape exclusions, street-as-venue protection,
// canonical hand-back, outcome / retry lifecycle.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { labelKind, verifyLocationShape, classifyResolution, storedLocationHolds } = require('../lib/locationEvidence');
const { planRow, processVerifyLocation, outcomeFromHandBack, policySignature } = require('../cleaner/verifyLocation');
const { nextAttemptAt, remainingStages, LOCATION_ISSUES, BLOCKING_FOR_INCOMING, ARCHIVE_REASON_BY_ISSUE } = require('../cleaner/lifecycle');
const { resolveLocation } = require('../cleaner/locationResolver');
const { evaluateIncomingRow } = require('../lib/incomingEligibility');

// ---- in-memory PostgREST-shaped fake (same shape as tests/publishExecution.test.js) ----
function fakeDb(init) {
  const t = structuredClone(init); let seq = 0;
  const from = (table) => {
    const q = { op: 'select', patch: null, f: [] };
    const ok1 = (r, [k, v, kind]) => kind === 'eq' ? r[k] === v : kind === 'neq' ? r[k] !== v : kind === 'in' ? v.includes(r[k]) : kind === 'is' ? (r[k] ?? null) === v : kind === 'lt' ? String(r[k]) < String(v) : kind === 'ilike' ? String(r[k] || '').toLowerCase() === String(v).toLowerCase() : true;
    const rows = () => (t[table] ||= []).filter((r) => q.f.every((f) => ok1(r, f)));
    const run = () => {
      if (q.op === 'insert' || q.op === 'upsert') { const list = (Array.isArray(q.patch) ? q.patch : [q.patch]).map((p) => ({ id: `${table}-${++seq}`, ...p })); (t[table] ||= []).push(...list); return { data: list.map((r) => ({ ...r })), error: null }; }
      if (q.op === 'update') { const hit = rows(); for (const r of hit) Object.assign(r, structuredClone(q.patch)); return { data: hit.map((r) => ({ ...r })), error: null }; }
      return { data: rows().map((r) => ({ ...r })), error: null };
    };
    const b = {
      select() { return b; }, insert(p) { q.op = 'insert'; q.patch = p; return b; }, upsert(p) { q.op = 'upsert'; q.patch = p; return b; }, update(p) { q.op = 'update'; q.patch = p; return b; },
      eq(k, v) { q.f.push([k, v, 'eq']); return b; }, neq(k, v) { q.f.push([k, v, 'neq']); return b; }, in(k, v) { q.f.push([k, v, 'in']); return b; }, is(k, v) { q.f.push([k, v, 'is']); return b; }, lt(k, v) { q.f.push([k, v, 'lt']); return b; }, ilike(k, v) { q.f.push([k, v, 'ilike']); return b; },
      or() { return b; }, not() { return b; }, gte() { return b; }, lte() { return b; }, gt() { return b; }, order() { return b; }, range() { return b; }, limit() { return b; }, match() { return b; }, contains() { return b; }, filter() { return b; },
      single() { const r = run(); return Promise.resolve({ data: r.data ? r.data[0] ?? null : null, error: r.error }); },
      maybeSingle() { const r = run(); return Promise.resolve({ data: r.data ? r.data[0] ?? null : null, error: r.error }); },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return b;
  };
  return { client: { from, rpc: async () => ({ data: null, error: null }) }, t };
}
const ahead = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
const TODAY = new Date().toISOString().slice(0, 10);
const SETTINGS = { minTrust: 80, maxDaysAhead: 180, thresholds: { duplicate: 0.9, needsReview: 0.6, proximityKm: 0.15 }, maxAttempts: 3, backoffHours: [6, 24, 72] };
const cand = (over = {}) => ({ name: 'סדנת יצירה לילדים', description: 'סדנת יצירה לילדים בגילאי 4-8', category: 'יצירה', entity_type: 'אירוע', schedule_type: 'one_time', one_time_date: ahead(10), city: 'חולון', location_name: 'מתנ"ס נווה ארזים', audience: 'children', image_urls: ['https://x/i.jpg'], registration_url: 'https://x/r', ...over });
const row = (over = {}, rowOver = {}) => ({ id: 'inc-1', source_id: 'src-1', page_url: 'https://x/events', match_type: 'new', status: 'new', validation_issues: ['מחיר'], deferred_until: null, updated_at: new Date().toISOString(), extracted_data: cand(over), ...rowOver });
const TRUSTED = { id: 'src-1', name: 'עיריית חולון - לוח אירועים', seed_url: 'https://www.holon.muni.il/events', is_trusted: false, source_trust_score: 85, activities_approved_total: 0 };
const ctxFor = (source) => ({ source, settings: SETTINGS, today: TODAY, settlementOf: null });

test('DISCOVERY: opened only when location is the final blocker; a trust-blocked row is not opened yet', () => {
  assert.deepEqual([planRow(row(), ctxFor(TRUSTED)).kind, planRow(row(), ctxFor(TRUSTED)).bucket], ['resolve', 'verify_location_eligible']);
  const untrusted = planRow(row(), ctxFor({ ...TRUSTED, source_trust_score: 60 }));
  assert.deepEqual([untrusted.kind, untrusted.bucket], [null, 'trust_blocked_and_location_blocked']);
  assert.equal(planRow(row({}, { validation_issues: ['עיר'] }), ctxFor(TRUSTED)).bucket, 'other_blockers');
  assert.equal(planRow(row({ one_time_date: ahead(400) }), ctxFor(TRUSTED)).bucket, 'other_blockers', 'beyond the publishable window');
  assert.equal(planRow(row({ offering_access_type: 'private_group' }), ctxFor(TRUSTED)).bucket, 'other_blockers', 'access');
  // retail / אחר never reaches location resolution - content safety is a hold before location
  const mcd = planRow(row({ name: 'מקדונלדס', description: 'רשת מקדונלד׳ס המציעה תפריט לכל המשפחה', category: 'אחר', entity_type: 'מקום_קבוע', schedule_type: 'fixed_hours', one_time_date: null, audience: 'family' }), ctxFor({ ...TRUSTED, is_trusted: true, source_trust_score: 100, name: 'קניון כפר סבא הירוקה' }));
  assert.deepEqual([mcd.kind, mcd.reasons], [null, ['content_safety']]);
  // a city that is not a settlement is excluded
  const shape = verifyLocationShape(cand({ city: 'מועצה אזורית מטה יהודה' }), { settlementOf: (c) => (c === 'חולון' ? { city: 'חולון' } : null) });
  assert.deepEqual(shape, { ok: false, exclusion: 'city_not_settlement' });
});

test('WRONG SHAPE: title, container (Azrieli pattern), generic label, street, admin area, the city itself', () => {
  assert.equal(labelKind(cand({ name: 'גן החיות התנכי', location_name: 'גן החיות התנ"כי' })).kind, 'TITLE');
  assert.equal(labelKind(cand({ name: 'קניון עזריאלי אילון', location_name: 'קניון עזריאלי אילון', entity_type: 'מקום_קבוע' })).kind, 'CONTAINER');
  assert.equal(labelKind(cand({ location_name: 'ספרייה' })).kind, 'GENERIC');
  assert.equal(labelKind(cand({ location_name: 'ספרייה', address: 'הרצל 5' })).kind, 'VENUE', 'a generic label WITH an address is usable');
  assert.equal(labelKind(cand({ location_name: 'רחוב הרצל' })).kind, 'STREET');
  assert.equal(labelKind(cand({ location_name: 'הרצל 12' })).kind, 'STREET');
  assert.equal(labelKind(cand({ location_name: 'תיאטרון בית 9', city: 'חיפה' })).kind, 'VENUE', 'a venue named with a number is not a street (dry-run false positive)');
  assert.equal(labelKind(cand({ location_name: 'מועצה אזורית מטה יהודה' })).kind, 'ADMIN_AREA');
  assert.equal(labelKind(cand({ location_name: 'חולון' })).kind, 'SETTLEMENT');
  assert.equal(labelKind(cand({ location_name: 'בית אריאלה', address: 'שאול המלך 25', city: 'תל אביב יפו' })).kind, 'VENUE');
  for (const lbl of ['ספרייה', 'רחוב הרצל', 'חולון']) assert.equal(verifyLocationShape(cand({ location_name: lbl })).ok, false, lbl);
});

test('STREET-AS-VENUE ("מרחב הנקה קהילתי" shape): a street gives coordinates, never the venue identity - the evaluator HOLDS it', async () => {
  const c = cand({ name: 'מרחב הנקה קהילתי', entity_type: 'מקום_קבוע', schedule_type: 'fixed_hours', one_time_date: null, category: 'פעילות קהילתית', city: 'נהריה', location_name: 'העצמאות', address: 'העצמאות', lat: 33.0124, lng: 35.1017, cleaner_location: { method: 'source_page', confidence: 'MEDIUM', evidence: { map_query: 'העצמאות', geocode: 'העצמאות, גבעת כצנלסון, נהריה' } } });
  assert.equal(labelKind(c).kind, 'STREET');
  assert.deepEqual(storedLocationHolds(c).map((h) => h.code).sort(), ['location_evidence_insufficient', 'location_label_not_venue']);
  const db = fakeDb({ incoming_activities: [row({}, { extracted_data: c })], sources: [TRUSTED], activities: [], automation_settings: [] });
  const ev = await evaluateIncomingRow(db.client, 'inc-1', { today: TODAY, serviceAreaIndex: null });
  assert.equal(ev.decision, 'HELD'); assert.ok(ev.reasons.some((r) => r.code === 'location_label_not_venue'));
  // and the resolver's own place lookup landing on a road is not venue evidence
  assert.equal(classifyResolution({ method: 'place_lookup', confidence: 'MEDIUM', lat: 1, lng: 2, city: 'נהריה', evidence: { type: 'residential' } }, { city: 'נהריה' }).class, 'VERIFY_MORE');
});

test('EVIDENCE LADDER: canonical venue HIGH; street address + city MEDIUM; wrong city CONFLICT; label-only / inferred VERIFY_MORE; LOW rejected', () => {
  const S = { city: 'תל אביב יפו' };
  assert.equal(classifyResolution({ method: 'existing_source_venue', confidence: 'HIGH', lat: 32.07, lng: 34.78, city: 'תל אביב יפו', venue_id: 'v1', evidence: { coords: 'venue' } }, S).class, 'HIGH');
  assert.equal(classifyResolution({ method: 'existing_venue', confidence: 'MEDIUM', lat: 32.07, lng: 34.78, city: 'תל אביב יפו', venue_id: 'v1', evidence: { coords: 'none', geocode: 'x' } }, S).class, 'HIGH');
  assert.equal(classifyResolution({ method: 'existing_venue', confidence: 'MEDIUM', lat: 1, lng: 2, venue_id: 'v1', evidence: { coords: 'venue_name_geocoded' } }, S).class, 'MEDIUM');
  assert.equal(classifyResolution({ method: 'source_page', confidence: 'MEDIUM', lat: 1, lng: 2, city: 'תל אביב יפו', address: 'שאול המלך 25', evidence: { address_text: 'שאול המלך 25' } }, S).class, 'MEDIUM');
  assert.equal(classifyResolution({ method: 'place_lookup', confidence: 'MEDIUM', lat: 1, lng: 2, city: 'תל אביב יפו', evidence: { type: 'theatre' } }, S).class, 'MEDIUM');
  assert.equal(classifyResolution({ method: 'source_page', confidence: 'MEDIUM', lat: 1, lng: 2, city: 'חולון', address: 'הרצל 5' }, S).class, 'CONFLICT', 'another canonical city');
  assert.equal(classifyResolution({ method: 'place_lookup', ambiguous: true, confidence: 'LOW', lat: null, lng: null }, S).class, 'CONFLICT');
  assert.equal(classifyResolution({ method: 'place_lookup_inferred', confidence: 'MEDIUM', lat: 1, lng: 2, evidence: { unique_label: true } }, S).class, 'VERIFY_MORE');
  assert.equal(classifyResolution({ method: 'existing_venue', confidence: 'HIGH', lat: 1, lng: 2, venue_id: 'v1', evidence: { city_inferred: { city: 'x' } } }, S).class, 'VERIFY_MORE');
  assert.equal(classifyResolution({ method: 'source_page', confidence: 'LOW', lat: 1, lng: 2 }, S).class, 'VERIFY_MORE');
  assert.equal(classifyResolution(null, S).class, 'NO_EVIDENCE');
  // "שביל האלות": a label-only unique geocode with a geocoder-supplied council "city" is not publishable evidence
  const shvil = cand({ name: 'שביל האלות בפארק בריטניה', city: 'מועצה אזורית מטה יהודה', location_name: 'פארק בריטניה', lat: 31.69, lng: 34.93, cleaner_location: { method: 'place_lookup_inferred', confidence: 'MEDIUM', evidence: { type: 'park', unique_label: true } } });
  assert.deepEqual(storedLocationHolds(shvil).map((h) => h.code), ['location_evidence_insufficient']);
});

test('LOW-confidence (city-centroid) existing locations are never reused as verified evidence', async () => {
  const db = fakeDb({ venues: [], venue_aliases: [], activities: [], locations: [{ id: 'loc-c', name: 'מתנ"ס נווה ארזים', city: 'חולון', lat: 32.01, lng: 34.77, address: null, address_confidence: 'LOW', venue_id: null }] });
  const { result } = await resolveLocation(db.client, { name: 'x', location_name: 'מתנ"ס נווה ארזים', city: 'חולון', source_id: 'src-1' }, { stages: ['existing'] });
  assert.equal(result, null);
  const ok = fakeDb({ venues: [], venue_aliases: [], activities: [], locations: [{ id: 'loc-v', name: 'מתנ"ס נווה ארזים', city: 'חולון', lat: 32.01, lng: 34.77, address: 'הרצל 5', address_confidence: 'HIGH', venue_id: null }] });
  const r2 = await resolveLocation(ok.client, { name: 'x', location_name: 'מתנ"ס נווה ארזים', city: 'חולון', source_id: 'src-1' }, { stages: ['existing'] });
  assert.deepEqual([r2.result.method, classifyResolution(r2.result, { city: 'חולון' }).class], ['existing_location', 'HIGH']);
});

// ---- the case handler ----
function helpers(overrides = {}) {
  const calls = { markFail: [], resolve: [], archive: [], handBack: [] };
  const h = {
    DRY: false, maxEvidenceStages: 2,
    stagesForAttempt: () => ['existing', 'source_page'],
    markFail: async (_c, _k, o) => { calls.markFail.push(o); return { outcome: 'retry' }; },
    resolveOrDry: async (_c, _k, r) => { calls.resolve.push(r); return { outcome: 'resolved', ...r }; },
    archiveOrDry: async (_c, _k, o) => { calls.archive.push(o); return { outcome: 'archived', reason: o.reason }; },
    handBackIncoming: async (_c, r) => { calls.handBack.push(r); return { outcome: 'published', activity_id: 'act-1', publish: 'PUBLISHED' }; },
    resolveLocation: async () => ({ result: null, tried: ['existing'], skipped: [], errors: [] }),
    ...overrides,
  };
  return { h, calls };
}
const caseOf = (over = {}) => ({ id: 'case-1', issue: 'verify_location', subject_kind: 'incoming', subject_id: 'inc-1', attempts: 0, methods_tried: [], ...over });

test('HANDLER: HIGH evidence -> verified write of coordinates + evidence (label untouched) -> canonical hand-back -> RESOLVED_AND_PUBLISHED', async () => {
  const db = fakeDb({ incoming_activities: [row()], sources: [TRUSTED] });
  const { h, calls } = helpers({ resolveLocation: async () => ({ result: { method: 'existing_source_venue', confidence: 'HIGH', lat: 32.01, lng: 34.77, city: 'חולון', address: 'הרצל 5', venue_id: 'v1', location_name: 'שם אחר מהגאוקודר', evidence: { coords: 'venue' } }, tried: ['existing'], skipped: [], errors: [] }) });
  const r = await processVerifyLocation(db.client, caseOf(), db.t.incoming_activities[0], { settings: SETTINGS, today: TODAY, counters: { gain: {} }, cache: new Map() }, h);
  assert.equal(r.outcome, 'RESOLVED_AND_PUBLISHED'); assert.equal(calls.resolve[0].outcome, 'RESOLVED_AND_PUBLISHED');
  const ed = db.t.incoming_activities[0].extracted_data;
  assert.deepEqual([ed.lat, ed.lng, ed.location_name, ed.venue_id, ed.address], [32.01, 34.77, 'מתנ"ס נווה ארזים', 'v1', 'הרצל 5']);
  for (const k of ['lat', 'lng', 'address', 'city', 'venue_id', 'method', 'confidence', 'evidence', 'resolved_at', 'attempt']) assert.ok(k in ed.cleaner_location, k);
  assert.deepEqual([ed.cleaner_location.attempt, ed.cleaner_location.verification.class], [1, 'HIGH']);
  assert.equal(calls.handBack.length, 1, 'the canonical hand-back decides publication');
});

test('HANDLER outcomes: policy-held hand-back is RESOLVED_BUT_NOT_AUTO_PUBLISHABLE (no retry); temporary failures retry; conflict archives non-blocking; nothing -> NO_EVIDENCE retry', async () => {
  const hit = { result: { method: 'existing_source_venue', confidence: 'HIGH', lat: 32.01, lng: 34.77, city: 'חולון', venue_id: 'v1', evidence: { coords: 'venue' } }, tried: ['existing'], skipped: [], errors: [] };
  let db = fakeDb({ incoming_activities: [row()], sources: [TRUSTED] });
  let { h, calls } = helpers({ resolveLocation: async () => hit, handBackIncoming: async () => ({ outcome: 'awaiting_policy', reasons: ['untrusted_source'], publish: 'POLICY_HELD' }) });
  await processVerifyLocation(db.client, caseOf(), db.t.incoming_activities[0], { settings: SETTINGS, today: TODAY, counters: { gain: {} } }, h);
  assert.deepEqual([calls.resolve[0].outcome, calls.resolve[0].policy_signature, calls.markFail.length], ['RESOLVED_BUT_NOT_AUTO_PUBLISHABLE', 'untrusted_source', 0]);
  assert.equal(db.t.incoming_activities[0].status, 'new', 'the row stays pending with its canonical reason');
  db = fakeDb({ incoming_activities: [row()], sources: [TRUSTED] });
  ({ h, calls } = helpers({ resolveLocation: async () => hit, handBackIncoming: async () => ({ outcome: 'error', publish: 'TEMPORARY_INFRA_FAILURE', error: 'fetch failed' }) }));
  await processVerifyLocation(db.client, caseOf(), db.t.incoming_activities[0], { settings: SETTINGS, today: TODAY, counters: { gain: {} } }, h);
  assert.equal(calls.markFail.length, 1, 'temporary publication failure retries');
  db = fakeDb({ incoming_activities: [row()], sources: [TRUSTED] });
  ({ h, calls } = helpers({ resolveLocation: async () => ({ result: { method: 'source_page', confidence: 'MEDIUM', lat: 31.8, lng: 34.6, city: 'אשדוד', address: 'הרצל 5' }, tried: ['source_page'], skipped: [], errors: [] }) }));
  await processVerifyLocation(db.client, caseOf(), db.t.incoming_activities[0], { settings: SETTINGS, today: TODAY, counters: { gain: {} } }, h);
  assert.deepEqual([calls.archive[0].reason, /CONFLICT_REQUIRES_HUMAN/.test(calls.archive[0].note), db.t.incoming_activities[0].extracted_data.lat], ['requires_human_judgment', true, undefined]);
  assert.ok(!BLOCKING_FOR_INCOMING.has('verify_location'), 'a verify_location archive never rejects the row');
  db = fakeDb({ incoming_activities: [row()], sources: [TRUSTED] });
  ({ h, calls } = helpers());
  await processVerifyLocation(db.client, caseOf(), db.t.incoming_activities[0], { settings: SETTINGS, today: TODAY, counters: { gain: {} } }, h);
  assert.match(calls.markFail[0].error, /^NO_EVIDENCE/);
  ({ h, calls } = helpers({ resolveLocation: async () => ({ result: null, tried: ['source_page'], skipped: [], errors: ['source_page: page fetch failed'] }) }));
  await processVerifyLocation(db.client, caseOf(), db.t.incoming_activities[0], { settings: SETTINGS, today: TODAY, counters: { gain: {} } }, h);
  assert.match(calls.markFail[0].error, /^TEMPORARY_FAILURE/);
  assert.equal(outcomeFromHandBack({ outcome: 'error', publish: 'LOCATION_INVALID' }), 'PUBLISH_EXECUTION_FAILED');
});

test('RETRY / LOOP SAFETY: backoff 6 h / 24 h / 72 h; each attempt runs new stages; archived after max attempts; resolved rows never re-resolve; one reopen', () => {
  const t0 = new Date('2026-09-24T00:00:00Z');
  assert.deepEqual([1, 2, 3].map((n) => (Date.parse(nextAttemptAt(n, [6, 24, 72], t0)) - t0) / 3600000), [6, 24, 72]);
  assert.ok(LOCATION_ISSUES.has('verify_location'));
  assert.deepEqual(remainingStages({ issue: 'verify_location', methods_tried: ['existing', 'source_page', 'detail_page'], resolution: { unavailable: [] } }), ['venue_site', 'place_lookup', 'place_lookup_inferred']);
  assert.equal(ARCHIVE_REASON_BY_ISSUE.verify_location, 'missing_address_unresolved');
  // a resolved row carries coordinates: it can only be a hand-back candidate, never another resolution
  const resolved = row({ lat: 32.01, lng: 34.77, venue_id: 'v1', cleaner_location: { method: 'existing_source_venue', confidence: 'HIGH', evidence: { coords: 'venue' }, verification: { class: 'HIGH', rule: 'canonical_venue' } } });
  assert.equal(planRow(resolved, ctxFor(TRUSTED)).kind, 'handback');
  assert.equal(planRow(resolved, ctxFor({ ...TRUSTED, source_trust_score: 60 })).bucket, 'resolved_trust_blocked');
  assert.equal(policySignature(['b', 'a', 'a']), 'a,b');
  const lifecycle = fs.readFileSync(path.join(__dirname, '../cleaner/lifecycle.js'), 'utf8');
  assert.ok(/if \(c\.issue === 'verify_location' && \(c\.reopened_count \|\| 0\) >= 1\) continue;/.test(lifecycle), 'one reopen at most');
});

test('RE-EVALUATION WITHOUT ANOTHER GEOCODE: an already-resolved row whose source becomes trusted is handed back, the resolver is not called', async () => {
  const resolved = row({ lat: 32.01, lng: 34.77, venue_id: 'v1', cleaner_location: { method: 'existing_source_venue', confidence: 'HIGH', evidence: { coords: 'venue' } } });
  let db = fakeDb({ incoming_activities: [resolved], sources: [{ ...TRUSTED, source_trust_score: 60 }] });
  let resolverCalls = 0;
  let { h, calls } = helpers({ resolveLocation: async () => { resolverCalls++; return { result: null, tried: [], skipped: [], errors: [] }; } });
  await processVerifyLocation(db.client, caseOf(), db.t.incoming_activities[0], { settings: SETTINGS, today: TODAY, counters: { gain: {} } }, h);
  assert.deepEqual([calls.resolve[0].outcome, calls.handBack.length], ['SUPERSEDED_BY_POLICY', 0], 'policy-held resolved row stays pending, untouched');
  db = fakeDb({ incoming_activities: [resolved], sources: [TRUSTED] });
  ({ h, calls } = helpers({ resolveLocation: async () => { resolverCalls++; return { result: null, tried: [], skipped: [], errors: [] }; } }));
  await processVerifyLocation(db.client, caseOf(), db.t.incoming_activities[0], { settings: SETTINGS, today: TODAY, counters: { gain: {} } }, h);
  assert.deepEqual([calls.resolve[0].outcome, calls.handBack.length, resolverCalls], ['RESOLVED_AND_PUBLISHED', 1, 0]);
});

test('END TO END: a resolved row publishes through the real hand-back + publishIncoming, in-process, no admin server', async () => {
  const { handBackIncoming } = require('../cleaner/apply');
  const resolved = row({ lat: 32.01, lng: 34.77, address: 'הרצל 5', cleaner_location: { method: 'existing_location', confidence: 'HIGH', evidence: { location_id: 'loc-1' }, verification: { class: 'HIGH', rule: 'existing_verified_location' } } });
  const db = fakeDb({ incoming_activities: [resolved], sources: [TRUSTED], activities: [], locations: [], activity_schedules: [], activity_images: [], activity_sources: [], venues: [], venue_aliases: [], automation_settings: [], settlements: [], settlement_aliases: [] });
  const { h, calls } = helpers({ handBackIncoming });
  await processVerifyLocation(db.client, caseOf(), db.t.incoming_activities[0], { settings: SETTINGS, today: TODAY, counters: { gain: {} }, cache: new Map(), userId: 'bot' }, h);
  assert.equal(calls.resolve[0].outcome, 'RESOLVED_AND_PUBLISHED', JSON.stringify(calls.resolve[0]).slice(0, 400));
  assert.deepEqual([db.t.activities.length, db.t.incoming_activities[0].status], [1, 'approved']);
});

// pilot 2026-09-24: "רחבי העיר" was geocoded to the city hall and auto-published there. A label that spreads the activity
// over several (or undisclosed) places has no single place to resolve - excluded from verify_location, held when it has coords.
test('multi-location labels are never resolved to one point', () => {
  for (const label of ['רחבי העיר', 'במספר מוקדים', 'בכמה מקומות בעיר', 'שכונות ברחבי העיר', 'פארקים ברחבי העיר', 'מספר מיקומים ברחבי יפו','שכונות ברחבי העיר (פרטים מדויקים במודעה)', 'מרכזי קהילה ברחבי ראשון לציון']) {
    const row = { name: 'חול המועד סוכות בגינות הקהילתיות', location_name: label, city: 'חיפה' };
    assert.equal(labelKind(row).kind, 'MULTI', label);
    assert.equal(verifyLocationShape(row).exclusion, 'label_multi', label);
    assert.ok(storedLocationHolds({ ...row, lat: 32.81, lng: 34.99 }).some((h) => h.code === 'location_label_not_venue'), label);
  }
  for (const label of ['רחבת העירייה', 'מרכז קהילתי רחביה', 'תיאטרון בית 9', 'ספריית בית אריאלה']) assert.notEqual(labelKind({ name: 'x', location_name: label, city: 'חיפה' }).kind, 'MULTI', label);
});

// pilot 2026-09-24: haifa.muni.il prints the city hall's address ("חסן שוקרי 14") in every page's footer, and the free-text
// address sweep made it the venue of four different Haifa events. Evidence reads CONTENT text (no site chrome) and an
// address counts only when it is printed near the event's place label or title.
test('page address evidence: site-chrome addresses are ignored and an address must be bound to the event', () => {
  const { contentText, extractAddressTexts } = require('../lib/pageExtract');
  const { addressBound } = require('../cleaner/locationResolver');
  const filler = 'פרטים נוספים על האירוע והרשמה באתר העירייה. '.repeat(12);
  const html = `<html><body><header>עיריית חיפה</header><main><h1>הפנינג ירוק במפרץ</h1><p>המפגש בפארק נחל הקישון, פעילות לכל המשפחה.</p><p>${filler}</p></main><footer>עיריית חיפה, רחוב חסן שוקרי 14, חיפה. טלפון 106</footer></body></html>`;
  const text = contentText(html);
  assert.ok(!text.includes('חסן שוקרי'), 'the footer is not content');
  assert.equal(extractAddressTexts(text, { city: 'חיפה' }).length, 0);
  const s = { name: 'הפנינג ירוק במפרץ', location_name: 'פארק נחל הקישון', city: 'חיפה' };
  const bound = `<html><body><main><h1>שעת סיפור</h1><p>במרכז הקהילתי נווה דוד, רחוב השקמה 12, חיפה</p><p>${filler}</p></main></body></html>`;
  const t2 = contentText(bound).replace(/\s+/g, ' ');
  const [a] = extractAddressTexts(contentText(bound), { city: 'חיפה' });
  assert.ok(a && addressBound(t2, a.at, { name: 'שעת סיפור', location_name: 'מרכז הקהילתי נווה דוד' }), 'an address beside its label is bound');
  const far = `<html><body><main><p>פארק נחל הקישון</p><p>${filler}</p><p>משרדי החברה: רחוב הנמל 5, חיפה</p></main></body></html>`;
  const t3 = contentText(far).replace(/\s+/g, ' ');
  const [b] = extractAddressTexts(contentText(far), { city: 'חיפה' });
  assert.ok(b && !addressBound(t3, b.at, s), 'an address far from the label / title is not this event\'s place');
});

// pilot re-run 2026-09-24: the same "site owner's place becomes the venue" class through the two other page paths -
// an Organization JSON-LD node (a municipality's own markup = city hall) and map links in site chrome / on a listing
// with several events. None of these may produce evidence (all return before any network call).
test('page evidence: site-owner organisation markup, chrome map links and multi-target listings are not event places', async () => {
  const { evidenceFromPage } = require('../cleaner/locationResolver');
  const s = { name: 'הפנינג ירוק במפרץ', location_name: 'פארק נחל הקישון', city: 'חיפה' };
  const org = `<html><head><script type="application/ld+json">{"@context":"https://schema.org","@type":"GovernmentOrganization","name":"עיריית חיפה","address":{"@type":"PostalAddress","streetAddress":"חסן שוקרי 14","addressLocality":"חיפה"},"geo":{"@type":"GeoCoordinates","latitude":32.812627,"longitude":34.9992145}}</script></head><body><main><h1>הפנינג ירוק במפרץ</h1></main></body></html>`;
  assert.equal(await evidenceFromPage(org, 'https://x/e/1', s, false, 'detail_page'), null, 'the publisher organisation is not the event place');
  const footerMap = `<html><body><main><h1>הפנינג ירוק במפרץ</h1><p>פעילות לכל המשפחה</p></main><footer><a href="https://waze.com/ul?ll=32.812627,34.9992145&navigate=yes">הגעה לעירייה</a></footer></body></html>`;
  assert.equal(await evidenceFromPage(footerMap, 'https://x/e/1', s, false, 'detail_page'), null, 'a footer map link is the site\'s');
  const listing = `<html><body><main><div>אירוע א <a href="https://waze.com/ul?ll=32.80,34.98">מפה</a></div><div>אירוע ב <a href="https://waze.com/ul?ll=32.79,35.01">מפה</a></div></main></body></html>`;
  assert.equal(await evidenceFromPage(listing, 'https://x/list', s, false, 'source_page'), null, 'several map targets: none is this event\'s');
  const loneOther = `<html><head><script type="application/ld+json">{"@context":"https://schema.org","@type":"Event","name":"ערב ג'אז","location":{"@type":"Place","name":"אודיטוריום","geo":{"latitude":32.8,"longitude":34.99}}}</script></head><body></body></html>`;
  assert.equal(await evidenceFromPage(loneOther, 'https://x/list', s, false, 'source_page'), null, 'a lone unrelated Event on a listing is another event');
});

// pilot re-run 2026-09-24 pre-apply review: three same-show hand-backs carried a performance the activity lacked
// (another hour the same day / an earlier date / the next weekly date). A duplicate rejection would have dropped it -
// such a row is an UPDATE for review; only a performance the activity already has is a duplicate.
test('hand-back: a new performance of a known show is an update, never a duplicate rejection', () => {
  const { missingOccurrences } = require('../cleaner/apply');
  const src = fs.readFileSync(path.join(__dirname, '..', 'cleaner', 'apply.js'), 'utf8');
  assert.match(src, /score >= settings\.thresholds\.duplicate && !newOccurrence\.length/, 'the duplicate branch is guarded');
  const act = (occ) => ({ occurrences: occ.map(([date, start_time]) => ({ date, start_time })) });
  assert.deepEqual(missingOccurrences({ one_time_date: '2026-09-28', start_time: '11:30' }, act([['2026-09-28', '10:00:00']])), [{ date: '2026-09-28', start_time: '11:30' }], 'another hour the same day');
  assert.equal(missingOccurrences({ one_time_date: '2026-09-29', start_time: '17:00' }, act([['2026-12-11', '11:00:00']])).length, 1, 'an earlier date');
  assert.equal(missingOccurrences({ one_time_date: '2026-09-29', start_time: '19:00' }, act([['2026-09-24', '19:00:00']])).length, 1, 'the next weekly date');
  assert.deepEqual(missingOccurrences({ one_time_date: '2026-09-28', start_time: '10:00' }, act([['2026-09-28', '10:00:00']])), [], 'the same performance IS a duplicate');
  assert.deepEqual(missingOccurrences({ one_time_date: '2026-09-28' }, act([['2026-09-28', '10:00:00']])), [], 'no hour given: the date suffices');
  assert.deepEqual(missingOccurrences({ schedule_type: 'recurring', recurring_days: ['שני'] }, act([])), [], 'undated rows keep the existing rule');
  assert.deepEqual(missingOccurrences({ one_time_date: '2026-09-29', start_time: '17:00' }, { one_time_date: '2026-09-29', start_time: '17:00:00' }), [], 'legacy activity shape without occurrences');
});
