// HEBREW-AWARE MARKER MATCHING + MARKER STRENGTH (2026-09-24) - the shared case table (_shared/markerMatch.cases.json,
// also run by the Deno twin markerMatch.test.ts) + twin parity + no substring marker matching left in the policy paths.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const M = require('../lib/markerMatch');
const Rel = require('../childRelevance');
const { evaluatePublishPolicy } = require('../lib/publishPolicy');

const SHARED = path.join(__dirname, '../../../supabase/functions/_shared');
const table = JSON.parse(fs.readFileSync(path.join(SHARED, 'markerMatch.cases.json'), 'utf8'));

test('matcher: whole words, clitic prefixes, explicit aliases - never inside another word', () => {
  for (const [text, marker, want] of table.matcher) assert.equal(M.markersIn(text, [marker]).length > 0, want, `${marker} in ${text}`);
});
test('relevance: strong child evidence vs weak holiday / family-topic context; adult markers unchanged', () => {
  for (const k of table.relevance) { const r = Rel.childRelevanceEvidence(k.c); assert.deepEqual([r.verdict, r.reason], k.expect, k.id); }
});
test('canonical policy: the Pilot #8 senior-centre row is HELD even when perfectly located on a trusted source', () => {
  const c = { ...table.relevance.find((k) => k.id === 'G_shabbat_nekabla_senior_centre').c, entity_type: 'אירוע', schedule_type: 'one_time', one_time_date: '2026-10-01', city: 'תל אביב יפו', lat: 32.07, lng: 34.78 };
  const r = evaluatePublishPolicy(c, { source: { source_trust_score: 85, name: 'עיריית תל אביב-יפו', seed_url: 'https://x' }, issues: [], today: '2026-09-24', minTrust: 80, maxDaysAhead: 180, row: { status: 'new', match_type: 'new' } });
  assert.equal(r.decision, 'HELD');
  assert.ok(r.reasons.some((x) => x.code === 'relevance_review'));
});
test('marker tiers: weak context words are not child markers; every strong marker is a child marker', () => {
  for (const w of Rel.WEAK_CHILD_CONTEXT) assert.ok(!Rel.CHILD_MARKERS.includes(w) && !Rel.STRONG_CHILD_MARKERS.includes(w), w);
  for (const w of Rel.STRONG_CHILD_MARKERS) assert.ok(Rel.CHILD_MARKERS.includes(w), w);
  for (const w of ['פורים', 'סוכות', 'חנוכה', 'משפחה', 'משפחות']) assert.ok(Rel.WEAK_CHILD_CONTEXT.includes(w), w);
});
test('twin parity: matcher constants and marker lists are identical in the Deno twins', () => {
  const ts = fs.readFileSync(path.join(SHARED, 'markerMatch.ts'), 'utf8');
  for (const n of ['LETTERS', 'PREFIX']) assert.ok(ts.includes(`export const ${n} = ${JSON.stringify(M[n]).replace(/^"|"$/g, "'").replace(/\\\\/g, '\\')};`) || ts.includes(`export const ${n} = '${M[n]}';`), n);
  const ext = fs.readFileSync(path.join(SHARED, 'extraction.ts'), 'utf8');
  const list = (name) => eval(ext.match(new RegExp(`const ${name} = (\\[[\\s\\S]*?\\]);`))[1]); // eslint-disable-line no-eval
  for (const n of ['ADULT_MARKERS', 'CHILD_MARKERS', 'WEAK_CHILD_CONTEXT', 'STRONG_CHILD_MARKERS']) assert.deepEqual(Rel[n], list(n), n);
});
test('no substring marker matching remains in the relevance / safety / detail / enricher paths', () => {
  const files = [path.join(__dirname, '../childRelevance.js'), path.join(__dirname, '../lib/autoPublishSafety.js'), path.join(__dirname, '../cleaner/fieldEnricher.js'), path.join(SHARED, 'extraction.ts'), path.join(SHARED, 'autoPublishSafety.ts'), path.join(SHARED, 'detailEvidence.ts')];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    assert.ok(!/\b(?:ADULT_MARKERS|HARD_ADULT_MARKERS|CHILD_MARKERS|STRONG_CHILD_MARKERS|WEAK_CHILD_CONTEXT|STRONG_CHILD_WORDS|FAMILY_WORDS|CHILD|ADULT)\.(?:some|filter)\(\(\w\) => [\w.]*\.includes\(/.test(src), path.basename(f));
  }
});
