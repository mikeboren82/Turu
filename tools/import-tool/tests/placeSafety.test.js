// Place identity safety (2026-09-24, verify_location pilot #5): compound place labels ("גן החיות ואקווריום ישראל") never
// lend one component's point to the sub-place the title names; exact same-name places in one settlement are at least a
// possible identity (review), never a silent new place and never a name-only duplicate. Shared tables with the Deno twin.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { compoundPlace, samePlaceName, sameAddress } = require('../lib/placeSafety');
const { computeConfidence, getConfidenceThresholds } = require('../cleaner/matching');
const { classifyResolution } = require('../lib/locationEvidence');
const { evaluatePublishPolicy } = require('../lib/publishPolicy');
const { planRow } = require('../cleaner/verifyLocation');

const table = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'supabase', 'functions', '_shared', 'placeSafety.cases.json'), 'utf8'));
test('shared tables: compound labels, same-name places, same addresses', () => {
  for (const k of table.compound) { const r = compoundPlace(k.label, k.title); assert.deepEqual([r.compound, r.titleComponent], k.expect, k.id); }
  for (const k of table.names) assert.equal(samePlaceName(k.a, k.b, k.city || null), k.expect, k.id);
  for (const k of table.addresses) assert.equal(sameAddress(k.a, k.b), k.expect, k.id);
});

const th = getConfidenceThresholds({});
// the live approved record 42b4758b and the pilot #5 row 3268eb45 as the matcher sees them
const AQUARIUM = { id: '42b4758b', name: 'אקווריום ישראל', entity_type: 'מקום_קבוע', schedule_type: 'fixed_hours', source_url: 'https://www.karamel.co.il/', location_name: 'אקווריום ישראל', address: 'אהרון שולוב 1', city: 'ירושלים', lat: 31.744884, lng: 35.1658507, venue_id: null, event_fingerprint: null, recurring_days: [], occurrences: [] };
const cand = (over = {}) => ({ name: 'אקווריום ישראל', city: 'ירושלים', entity_type: 'מקום_קבוע', schedule_type: 'fixed_hours', location_name: 'גן החיות ואקווריום ישראל', pageUrl: 'https://www.jerusalemzoo.org.il/', lat: 31.7461139, lng: 35.1766343, venue_id: null, recurring_days: [], ...over });

test('AQUARIUM REGRESSION: same name + same city + the zoo point -> possible identity (review), not new, not duplicate', () => {
  const c = computeConfidence(cand(), AQUARIUM, th);
  assert.equal(c.breakdown.place_name_identity, 1);
  assert.ok(c.score >= th.needsReview && c.score < th.duplicate, String(c.score));
});
test('AQUARIUM REGRESSION: the compound venue is never a verified location for the aquarium; its own evidence is', () => {
  const s = { name: 'אקווריום ישראל', location_name: 'גן החיות ואקווריום ישראל', city: 'ירושלים' };
  const zoo = { method: 'existing_venue', venue_id: '6b785f3c', lat: 31.7461139, lng: 35.1766343, city: 'ירושלים', confidence: 'HIGH', location_name: 'גן החיות ואקווריום ישראל', evidence: { venue: 'גן החיות ואקווריום ישראל', coords: 'linked_locations(1)' } };
  assert.deepEqual(classifyResolution(zoo, s), { class: 'VERIFY_MORE', rule: 'compound_place_label' });
  assert.equal(classifyResolution({ ...zoo, method: 'place_lookup', evidence: { type: 'zoo' } }, s).class, 'VERIFY_MORE');
  assert.equal(classifyResolution({ ...zoo, location_name: 'אקווריום ישראל', evidence: { venue: 'אקווריום ישראל', coords: 'venue' } }, s).class, 'HIGH', "the aquarium's own canonical venue");
  assert.equal(classifyResolution({ method: 'detail_page', lat: 31.7449, lng: 35.1659, city: 'ירושלים', confidence: 'HIGH', evidence: { map_link: 'https://waze.com/ul?ll=31.7449,35.1659' } }, s).class, 'HIGH', 'a component-specific map pin on the item page');
  assert.equal(classifyResolution(zoo, { ...s, name: 'חנוכה בגן החיות ואקווריום ישראל' }).class, 'HIGH', 'an event for the whole complex');
});
test('AQUARIUM REGRESSION: the canonical policy holds it and verify_location never resolves it (no zoo point is written)', () => {
  const ed = { name: 'אקווריום ישראל', description: 'אקווריום לילדים ולכל המשפחה', category: 'פינת חי', entity_type: 'מקום_קבוע', schedule_type: 'fixed_hours', city: 'ירושלים', location_name: 'גן החיות ואקווריום ישראל', audience: 'family' };
  const src = { is_trusted: false, source_trust_score: 85, name: 'גן החיות התנ"כי ירושלים', seed_url: 'https://www.jerusalemzoo.org.il/' };
  const pol = evaluatePublishPolicy(ed, { source: src, issues: [], today: '2026-09-24', minTrust: 80, maxDaysAhead: 180, row: { status: 'new', match_type: 'new', deferred_until: null } });
  assert.deepEqual(pol.reasons.map((r) => [r.code, r.detail]), [['location_compound_label', { component: 'אקווריום ישראל', label: 'גן החיות ואקווריום ישראל' }]]);
  assert.equal(pol.humanApprovable, true);
  const p = planRow({ id: '3268eb45', source_id: 's', match_type: 'new', status: 'new', validation_issues: [], deferred_until: null, extracted_data: ed }, { source: src, settings: { minTrust: 80, maxDaysAhead: 180 }, today: '2026-09-24', settlementOf: null });
  assert.deepEqual([p.kind, p.bucket, p.reasons], [null, 'other_blockers', ['location_compound_label']]);
});
test('BRANCH SAFETY: same name + same city never auto-merges on the name; same address or same venue does', () => {
  const branch = { ...AQUARIUM, name: 'ספריית בית אריאלה', location_name: 'ספריית בית אריאלה', address: 'שאול המלך 25', lat: 32.0766, lng: 34.7862 };
  const other = computeConfidence({ name: 'ספריית בית אריאלה', city: 'ירושלים', entity_type: 'מקום_קבוע', schedule_type: 'fixed_hours', address: 'דרך יפו 97', lat: 31.789, lng: 35.201, venue_id: null, recurring_days: [] }, branch, th);
  assert.ok(other.score >= th.needsReview && other.score < th.duplicate, 'different address: review, not duplicate');
  assert.ok(computeConfidence({ name: 'ספריית בית אריאלה', city: 'ירושלים', entity_type: 'מקום_קבוע', schedule_type: 'fixed_hours', address: 'שאול המלך 25', venue_id: null, recurring_days: [] }, branch, th).score >= th.duplicate, 'same address: strong');
  assert.ok(computeConfidence({ name: 'ספריית בית אריאלה', city: 'ירושלים', entity_type: 'מקום_קבוע', schedule_type: 'fixed_hours', venue_id: 'v1', recurring_days: [] }, { ...branch, venue_id: 'v1' }, th).score >= th.duplicate, 'same canonical venue: strong');
  const generic = computeConfidence({ name: 'ספרייה עירונית', city: 'ירושלים', entity_type: 'מקום_קבוע', schedule_type: 'fixed_hours', lat: 31.79, lng: 35.2, venue_id: null, recurring_days: [] }, { ...branch, name: 'ספרייה עירונית' }, th);
  assert.equal(generic.breakdown.place_name_identity, undefined, 'a generic name gets no floor');
  const elsewhere = computeConfidence(cand({ city: 'אילת' }), AQUARIUM, th);
  assert.equal(elsewhere.breakdown.place_name_identity, undefined, 'another city: no identity');
});
test('events are untouched by the place floor (dated events keep their own identity rules)', () => {
  const ev = { ...AQUARIUM, entity_type: 'אירוע', schedule_type: 'one_time', one_time_date: '2026-10-01', occurrences: [{ date: '2026-10-01', start_time: '10:00' }] };
  const c = computeConfidence({ ...cand(), entity_type: 'אירוע', schedule_type: 'one_time', one_time_date: '2026-11-01' }, ev, th);
  assert.equal(c.breakdown.place_name_identity, undefined);
});
