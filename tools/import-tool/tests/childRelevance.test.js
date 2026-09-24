// Child relevance - EVIDENCE HIERARCHY (2026-09-24, verify_location pilot #4: "שלום בית", an adult subscription-season
// comedy, was publish-eligible because the model said audience=family). Shared table with the Deno twin
// (_shared/childRelevance.cases.json) + twin parity + the no-bypass paths (row evaluator, approval modes, verify_location).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const rel = require('../childRelevance');
const { evaluatePublishPolicy } = require('../lib/publishPolicy');
const { approvalBlockers } = require('../lib/incomingEligibility');
const { planRow } = require('../cleaner/verifyLocation');

const SHARED = path.join(__dirname, '..', '..', '..', 'supabase', 'functions', '_shared');
const table = JSON.parse(fs.readFileSync(path.join(SHARED, 'childRelevance.cases.json'), 'utf8'));

test('shared table: the evidence hierarchy decides every case the same way in both runtimes', () => {
  for (const k of table.cases) {
    const r = rel.childRelevanceEvidence(k.c);
    assert.deepEqual([r.verdict, r.reason], k.expect, k.id);
    assert.equal(rel.assessChildRelevance(k.c), k.expect[0], k.id);
  }
});

test('twin parity: marker lists and context patterns are identical to extraction.ts', () => {
  const src = fs.readFileSync(path.join(SHARED, 'extraction.ts'), 'utf8');
  const list = (name) => JSON.parse('[' + new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`).exec(src)[1].replace(/'/g, '"').replace(/,\s*$/, '') + ']');
  assert.deepEqual(list('STRONG_CHILD_MARKERS'), rel.STRONG_CHILD_MARKERS);
  for (const re of ['ADULT_CONTEXT_RE', 'CHILD_CONTEXT_RE']) assert.ok(src.includes(`const ${re} = ${rel[re].toString()};`), re);
  assert.ok(src.includes("const INHERENTLY_CHILD_CATEGORIES = new Set(['גן שעשועים', 'משחקייה']);"));
});

// the two live rows, as stored (no source_context: ingested before intake recorded it)
const SHALOM = (date, over = {}) => ({ name: 'שלום בית', description: 'קומדיה משפחתית חדשה מאת גלעד שמואלי המתבוננת על הבדידות בגיל השלישי.', category: 'הצגה', entity_type: 'אירוע', schedule_type: 'one_time', one_time_date: date, start_time: '20:30', city: 'כרמיאל', location_name: 'היכל התרבות כרמיאל', audience: 'family', family_fit: ['מתאים לילד ולהורה'], ...over });
const KARMIEL = { is_trusted: false, source_trust_score: 85, name: 'היכל התרבות כרמיאל', seed_url: 'https://www.htk.co.il/' };
const ctx = (over = {}) => ({ source: KARMIEL, issues: [], today: '2026-09-24', minTrust: 80, maxDaysAhead: 180, row: { status: 'new', match_type: 'new', deferred_until: null }, ...over });

test('"שלום בית" REGRESSION: both performances are HELD for a person - stored rows and rows with the publisher label', () => {
  for (const date of ['2027-03-16', '2027-03-17']) {
    const stored = evaluatePublishPolicy(SHALOM(date), ctx());
    assert.equal(stored.decision, 'HELD', date);
    assert.deepEqual(stored.reasons.find((r) => r.code === 'relevance_review').detail, 'model_audience_label_only');
    const labelled = evaluatePublishPolicy(SHALOM(date, { source_context: { labels: ['עונת תיאטרון 26/27 תיאטרון מופעי בחירה', 'ההצגה היא חלק מעונת התיאטרון 26/27'], evidence_source: 'listing_card' } }), ctx());
    assert.deepEqual(labelled.reasons.find((r) => r.code === 'relevance_review').detail, 'first_party_adult_context');
    // a hold, not a rejection: a reviewer may approve it, automation may not
    const ev = { reasons: labelled.reasons };
    assert.equal(labelled.humanApprovable, true);
    assert.equal(approvalBlockers(ev, 'human').length, 0);
    assert.ok(approvalBlockers(ev, 'auto').some((r) => r.code === 'relevance_review'));
  }
});

test('source trust and a trust override never bypass relevance', () => {
  const r = evaluatePublishPolicy(SHALOM('2027-03-16'), ctx({ source: { ...KARMIEL, is_trusted: true, source_trust_score: 100 }, trustOverride: 'cleaner_settlement_review' }));
  assert.deepEqual(r.reasons.map((x) => x.code), ['relevance_review']);
});

test('verify_location cannot bypass it: a perfectly located "שלום בית" is never planned for hand-back or resolution', () => {
  const plan = (ed) => planRow({ id: 'x', source_id: 's', match_type: 'new', status: 'new', validation_issues: [], deferred_until: null, extracted_data: ed }, { source: KARMIEL, settings: { minTrust: 80, maxDaysAhead: 180 }, today: '2026-09-24', settlementOf: null });
  const located = plan(SHALOM('2027-03-16', { lat: 32.9151303, lng: 35.3032382, venue_id: 'v-karmiel', cleaner_location: { method: 'existing_venue', confidence: 'HIGH', verification: { class: 'HIGH', rule: 'canonical_venue' }, evidence: { venue: 'היכל התרבות כרמיאל' } } }));
  assert.deepEqual([located.kind, located.bucket], [null, 'resolved_policy_held']);
  assert.ok(located.reasons.includes('relevance_review'));
  const unlocated = plan(SHALOM('2027-03-17'));
  assert.deepEqual([unlocated.kind, unlocated.bucket], [null, 'other_blockers']);
});

test('retail / category אחר safety is a separate layer and still applies to child-evidenced rows', () => {
  const r = evaluatePublishPolicy({ name: 'חנות צעצועים לילדים', description: 'חנות צעצועים לילדים בקניון', category: 'אחר', entity_type: 'מקום_קבוע', schedule_type: 'fixed_hours', city: 'חולון', location_name: 'קניון חולון', audience: 'children' }, ctx({ source: { ...KARMIEL, source_trust_score: 90, name: 'קניון חולון', seed_url: 'https://mall.example/' } }));
  assert.ok(r.reasons.some((x) => x.code === 'content_safety'));
  assert.equal(r.reasons.some((x) => x.code === 'relevance_review'), false, 'child evidence present: relevance passes, retail safety holds');
});
