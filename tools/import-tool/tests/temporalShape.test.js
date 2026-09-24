// Canonical policy safety (2026-09-24): a programme / run / series collapsed to ONE date is HELD for a person, never
// published automatically - f3bdec33 (a 31.08-30.09 programme stored as a one-time event on 30.09). Shared table with
// the Deno twin (_shared/temporalShape.cases.json) + the no-bypass paths (row evaluator, verify_location, approval modes).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { assessTemporalShape, cardDateSpan, withCardEvidence } = require('../lib/temporalShape');
const { evaluateIncomingRow, approvalBlockers } = require('../lib/incomingEligibility');
const { planRow, outcomeFromHandBack } = require('../cleaner/verifyLocation');

const table = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'supabase', 'functions', '_shared', 'temporalShape.cases.json'), 'utf8'));

test('shared table: the item\'s own printed date span (never a neighbour card\'s)', () => {
  for (const k of table.card) {
    const s = cardDateSpan(k.text, k.title, k.date);
    assert.deepEqual(s ? [s.start, s.end, s.days] : null, k.expect, k.id);
  }
});
test('shared table: collapsed single-occurrence shapes vs legitimate ones', () => {
  for (const k of table.assess) {
    const a = assessTemporalShape(k.c);
    assert.deepEqual([a.collapsed, a.signals], k.expect, k.id);
  }
});

// ---- f3bdec33 as stored: Cleaner-resolved location (HIGH), clean otherwise, the range only in the listing snapshot ----
const SNAPSHOT = 'אירועים חבורת הזמר הנהריינים מיום ראשון, 01.03.2026, 20:00 עד יום ראשון, 27.12.2026 20:00 בבית יד לבנים לפרטים נוספים פעילות מרכז משלים חודש ספטמבר 2026 מיום שני, 31.08.2026 עד יום רביעי, 30.09.2026 מרכז משלים למשפחה לפרטים נוספים';
const f3 = (over = {}) => ({
  id: 'f3bdec33-6f53-4e9c-b86d-ee74572b3537', source_id: 'src-nahariya', page_url: 'https://www.nahariya.muni.il/events/', match_type: 'new', status: 'new',
  validation_issues: ['מחיר'], deferred_until: null, existing_activity_id: null, raw_source_snapshot: SNAPSHOT,
  extracted_data: { name: 'פעילות מרכז משלים חודש ספטמבר 2026', description: 'פעילויות משפחתיות בניהול מרכז משלים למשפחה בחודש ספטמבר.', category: 'פעילות קהילתית', entity_type: 'אירוע', schedule_type: 'one_time', one_time_date: '2026-09-30', city: 'נהריה', location_name: 'מרכז משלים למשפחה', audience: 'family', family_fit: ['מתאים לילד ולהורה'], lat: 32.9974, lng: 35.1021, cleaner_location: { method: 'detail_page', confidence: 'HIGH', verification: { class: 'HIGH', rule: 'first_party_page_geo' }, evidence: { map_link: 'https://waze.com/ul?ll=32.9974,35.1021' } }, ...over },
});
const SOURCE = { id: 'src-nahariya', name: 'עיריית נהריה', seed_url: 'https://www.nahariya.muni.il/events/', is_trusted: false, source_trust_score: 85 };
function fakeClient(row) {
  const t = { incoming_activities: [row], sources: [SOURCE], activities: [], automation_settings: [] };
  return { from(table) {
    const f = [];
    const b = { select() { return b; }, eq(k, v) { f.push((r) => r[k] === v); return b; }, neq(k, v) { f.push((r) => r[k] !== v); return b; }, in(k, v) { f.push((r) => v.includes(r[k])); return b; }, limit() { return b; },
      maybeSingle() { const r = (t[table] || []).filter((x) => f.every((p) => p(x))); return Promise.resolve({ data: r[0] || null, error: null }); },
      then(res) { return Promise.resolve({ data: (t[table] || []).filter((x) => f.every((p) => p(x))), error: null }).then(res); } };
    return b;
  } };
}

test('f3bdec33 REGRESSION: the canonical row evaluator HOLDS it (temporal_shape_ambiguous) although its location is verified', async () => {
  const ev = await evaluateIncomingRow(fakeClient(f3()), f3().id, { today: '2026-09-24', serviceAreaIndex: null });
  assert.equal(ev.decision, 'HELD');
  const r = ev.reasons.find((x) => x.code === 'temporal_shape_ambiguous');
  assert.ok(r, JSON.stringify(ev.reasons));
  assert.deepEqual(r.detail.signals, ['date_span', 'period_language']);
  assert.deepEqual([r.detail.span.start, r.detail.span.end], ['2026-08-31', '2026-09-30']);
  assert.equal(ev.reasons.some((x) => /^location_/.test(x.code)), false, 'location is not what holds it');
});

test('card evidence alone (no period words) still holds - the stored listing text is read for rows without intake evidence', async () => {
  const row = f3({ name: 'מרכז משלים - פעילות משפחות', description: 'פעילויות משפחתיות בניהול מרכז משלים למשפחה.' });
  row.raw_source_snapshot = SNAPSHOT.replace('פעילות מרכז משלים חודש ספטמבר 2026', 'מרכז משלים - פעילות משפחות');
  const ev = await evaluateIncomingRow(fakeClient(row), row.id, { today: '2026-09-24', serviceAreaIndex: null });
  assert.deepEqual(ev.reasons.find((x) => x.code === 'temporal_shape_ambiguous')?.detail.signals, ['date_span']);
  assert.equal(withCardEvidence({ schedule_type: 'recurring', name: 'x' }, SNAPSHOT).temporal_evidence, undefined, 'non one-time rows are untouched');
});

test('HELD, not rejected: a reviewer may approve, automation may not', async () => {
  const ev = await evaluateIncomingRow(fakeClient(f3()), f3().id, { today: '2026-09-24', serviceAreaIndex: null });
  assert.equal(ev.humanApprovable, true);
  const r = ev.reasons.find((x) => x.code === 'temporal_shape_ambiguous');
  assert.deepEqual([r.severity, r.humanOverridable], ['hold', true]);
  assert.equal(approvalBlockers(ev, 'human').some((x) => x.code === 'temporal_shape_ambiguous'), false, 'the human decision is the approval');
  assert.equal(approvalBlockers(ev, 'auto').some((x) => x.code === 'temporal_shape_ambiguous'), true, 'automation is blocked');
});

test('verify_location cannot bypass it: never planned for resolution/hand-back, and a held hand-back is not a publication', () => {
  const ctx = { source: SOURCE, settings: { minTrust: 80, maxDaysAhead: 180 }, today: '2026-09-24', settlementOf: null };
  const withCoords = planRow(f3(), ctx);
  assert.deepEqual([withCoords.kind, withCoords.bucket], [null, 'resolved_policy_held']);
  assert.ok(withCoords.reasons.includes('temporal_shape_ambiguous'));
  const row = f3(); delete row.extracted_data.lat; delete row.extracted_data.lng; delete row.extracted_data.cleaner_location;
  const noCoords = planRow(row, ctx);
  assert.deepEqual([noCoords.kind, noCoords.bucket], [null, 'other_blockers']);
  assert.equal(outcomeFromHandBack({ outcome: 'awaiting_policy', reasons: ['temporal_shape_ambiguous'] }), 'RESOLVED_BUT_NOT_AUTO_PUBLISHABLE');
});

test('intake computes the same card evidence from the page text before the canonical policy runs', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'supabase', 'functions', 'scan-source', 'index.ts'), 'utf8');
  const at = src.indexOf('const candidate = p.candidate; const issues = p.issues;');
  const gate = src.indexOf('autoApproveEligible(candidate, gatingIssues(issues), source, gate)');
  const ev = src.indexOf('candidate.temporal_evidence = { card_span: cs }');
  assert.ok(at > 0 && ev > at && ev < gate, 'card evidence is attached in pass 2, before auto-approval');
});

test('Cleaner field enricher: a range in the evidence is never collapsed into a "single date"', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'cleaner', 'fieldEnricher.js'), 'utf8');
  assert.match(src, /if \(ds2\.length === 1 && all\.length > 1\) unresolved\['תאריך'\]/);
});
