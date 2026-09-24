// TRUSTED AGE EVIDENCE (2026-09-24) - the shared case table (_shared/ageEvidence.cases.json, also run by the Deno twin
// ageEvidence.test.ts) + twin parity + the Cleaner's use of the one parser.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const AE = require('../lib/ageEvidence');
const { childRelevanceEvidence } = require('../childRelevance');
const { assessAutoPublishSafety } = require('../lib/autoPublishSafety');
const { evaluatePublishPolicy } = require('../lib/publishPolicy');

const SHARED = path.join(__dirname, '../../../supabase/functions/_shared');
const table = JSON.parse(fs.readFileSync(path.join(SHARED, 'ageEvidence.cases.json'), 'utf8'));

test('parser: bound ages, adjacent tags, reversed RTL ranges; never bare menu wording, dates or times', () => {
  for (const [text, want] of table.parser) {
    const a = AE.agesIn(text);
    assert.deepEqual(a && [a.min_age, a.max_age, a.kind], want, JSON.stringify(text));
  }
});
test('trustedAges: intake / Cleaner event-local / title only - never model numbers, model description, legacy, model_inference, invalidated', () => {
  for (const k of table.trusted) { const t = AE.trustedAges(k.c); assert.deepEqual(t && [t.min_age, t.max_age, t.provenance], k.expect, k.id); }
});
test('intake: ageEvidenceFor reads title -> bound card -> detail content; model-only ages are recorded as provenance model', () => {
  for (const k of table.intake) {
    const r = AE.ageEvidenceFor(k.c, { cardText: k.cardText ?? null, detailText: k.detailText ?? null });
    assert.deepEqual(r && [r.provenance, r.scope, r.min_age, r.max_age, r.model_agrees], k.expect, k.id);
  }
});
test('relevance: an age proves child relevance only when the source states it; a raw 18+ stays adult', () => {
  for (const k of table.relevance) { const r = childRelevanceEvidence(k.c); assert.deepEqual([r.verdict, r.reason], k.expect, k.id); }
});
test('content safety uses the same trusted-age rule', () => {
  for (const k of table.safety) { const r = assessAutoPublishSafety(k.c, { name: 'עיריית חולון', url: 'https://www.holon.muni.il' }); assert.deepEqual([r.allow, r.code], k.expect, k.id); }
});

test('canonical policy: model-only 0-5 on a perfectly placed, trusted-source row is HELD; the source-stated age publishes', () => {
  const c = { name: 'מופע', description: 'מופע מוזיקלי', category: 'מוזיקה', entity_type: 'אירוע', schedule_type: 'one_time', one_time_date: '2026-10-10', city: 'חולון', location_name: 'היכל התרבות', audience: 'family', min_age: 0, max_age: 5, lat: 32.01, lng: 34.77 };
  const ctx = { source: { source_trust_score: 90, name: 'היכל התרבות חולון', seed_url: 'https://x' }, issues: ['מחיר'], today: '2026-09-24', minTrust: 80, maxDaysAhead: 180, row: { status: 'new', match_type: 'new' } };
  assert.deepEqual(evaluatePublishPolicy(c, ctx).reasons.map((x) => x.code), ['relevance_review']);
  const stated = { ...c, age_evidence: { provenance: 'event_local_explicit_age', evidence: 'לגילאי 0-5', scope: 'listing_card', min_age: 0, max_age: 5, model_agrees: true } };
  assert.equal(evaluatePublishPolicy(stated, ctx).decision, 'ELIGIBLE');
});

test('twin parity: the parser patterns and provenance sets are identical in _shared/ageEvidence.ts', () => {
  const ts = fs.readFileSync(path.join(SHARED, 'ageEvidence.ts'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '../lib/ageEvidence.js'), 'utf8');
  const rhs = (src, name) => { const m = new RegExp(`const ${name} = (.+);\\n`).exec(src); assert.ok(m, name); return m[1]; };
  for (const n of ['HEB', 'INFANT_WORDS', 'AGE_WORD_RE', 'RANGE_RE', 'NOT_AGE_BEFORE_RE', 'TODDLER_WORDING_RE', 'DEPARTMENT_BEFORE_RE', 'TRUSTED_AGE_PROVENANCE', 'TRUSTED_CLEANER_PROVENANCE']) assert.equal(rhs(js, n), rhs(ts, n), n);
});

test('one parser: the Cleaner enricher and the Deno detail parser use ageEvidence, no private age regex remains', () => {
  const enricher = fs.readFileSync(path.join(__dirname, '../cleaner/fieldEnricher.js'), 'utf8');
  assert.ok(enricher.includes("require('../lib/ageEvidence')") && !/AGE_WORD_RE|AGE_RANGE_RE|TODDLER_WORDING_RE/.test(enricher));
  const detail = fs.readFileSync(path.join(SHARED, 'detailEvidence.ts'), 'utf8');
  assert.ok(detail.includes("import { agesIn } from './ageEvidence.ts'") && !/const AGE_RE/.test(detail) && !/גיל הרך\|לפעוטות/.test(detail));
  const policyTwins = [fs.readFileSync(path.join(__dirname, '../childRelevance.js'), 'utf8'), fs.readFileSync(path.join(SHARED, 'extraction.ts'), 'utf8'), fs.readFileSync(path.join(__dirname, '../lib/autoPublishSafety.js'), 'utf8'), fs.readFileSync(path.join(SHARED, 'autoPublishSafety.ts'), 'utf8')];
  for (const src of policyTwins) assert.ok(/trustedAges\(/.test(src), 'every relevance / safety twin reads ages through trustedAges');
});
