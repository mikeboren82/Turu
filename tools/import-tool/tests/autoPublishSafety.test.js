const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const G = require('../lib/autoPublishSafety');
const { classifyIncoming } = require('../lib/reviewBudget');

const SHARED = path.join(__dirname, '../../../supabase/functions/_shared');
const table = JSON.parse(fs.readFileSync(path.join(SHARED, 'autoPublishSafety.cases.json'), 'utf8'));

test('content safety regression table (shared with the Deno twin): businesses / promotions / אחר held, child activities eligible', () => {
  for (const k of table.cases) {
    const v = G.assessAutoPublishSafety({ ...k.c, audience: 'family', family_fit: ['מתאים לילד ולהורה'] }, table[k.source]);
    assert.deepEqual([v.allow, v.code], [k.expect, k.code], k.id);
  }
});

test('TRUST INDEPENDENCE: no trust state (80, is_trusted, a future earned flag) changes the verdict', () => {
  for (const k of table.cases) {
    const base = G.assessAutoPublishSafety(k.c, table[k.source]);
    assert.deepEqual(G.assessAutoPublishSafety(k.c, { ...table[k.source], is_trusted: true, source_trust_score: 100, auto_publish_earned: true }), base, k.id);
  }
  // every automated publish path decides through the ONE canonical policy (2026-09-24), which evaluates content
  // safety for any trust state (tests/publishPolicy.test.js: retail trust 95 / override / earned -> HELD)
  const policy = fs.readFileSync(path.join(__dirname, '../lib/publishPolicy.js'), 'utf8');
  assert.ok(/const safety = assessAutoPublishSafety\(c,/.test(policy) && !/trusted &&[^\n]*safety/.test(policy), 'canonical policy runs content safety unconditionally');
  const handBack = fs.readFileSync(path.join(__dirname, '../cleaner/apply.js'), 'utf8');
  const hb = handBack.slice(handBack.indexOf('async function handBackIncoming('), handBack.indexOf('// A guarded write on an OPEN incoming row'));
  assert.ok(hb.indexOf('evaluateIncomingRow(') > 0 && hb.indexOf('evaluateIncomingRow(') < hb.indexOf("fetch(`${ADMIN_BASE}/api/incoming/"), 'Cleaner hand-back decides through the canonical evaluator before the approve call');
  const reprocess = fs.readFileSync(path.join(__dirname, '../reprocess-review-queue.js'), 'utf8');
  assert.ok(reprocess.includes('evaluateIncomingRow(') && reprocess.includes("ev.decision === 'ELIGIBLE'"), 'reprocess tool approves only canonically ELIGIBLE rows');
  const scan = fs.readFileSync(path.join(SHARED, '../scan-source/index.ts'), 'utf8');
  const fn = scan.slice(scan.indexOf('function autoApproveEligible('), scan.indexOf('async function autoApproveNewActivity('));
  assert.ok(/return evaluatePublishPolicy\(candidate, \{[^}]*\}\)\.decision === 'ELIGIBLE';/.test(fn), 'scan-source intake delegates to the same policy (Deno twin)');
});

test('Cleaner hand-back: a trusted source AND trustedOverride still cannot publish a tenant listing; a mall kids workshop still can reach the approve step', async () => {
  process.env.ADMIN_BASE = 'http://127.0.0.1:9'; // never reach a real admin server from a test
  const { handBackIncoming } = require('../cleaner/apply');
  // the hand-back re-reads the CURRENT row (canonical evaluator), so the fake serves it by table
  let current = null;
  const client = { from: (table) => { const chain = new Proxy({}, { get(_o, k) {
    if (k === 'maybeSingle') return () => Promise.resolve({ data: table === 'sources' ? { is_trusted: true, source_trust_score: 95, name: 'קניון כפר סבא הירוקה - לוח אירועים', seed_url: 'https://mall.example/events' } : table === 'incoming_activities' ? current : null, error: null });
    if (k === 'then') return (res) => res({ data: [], error: null });
    return () => chain;
  } }); return chain; } };
  const settings = { thresholds: { duplicate: 0.9, needsReview: 0.6, proximityKm: 0.15 }, minTrust: 80, maxDaysAhead: 180 };
  const base = { id: 'i1', source_id: 's1', page_url: 'https://mall.example/events', status: 'new', match_type: 'new', validation_issues: [] };
  const mcd = { ...base, extracted_data: { name: 'מקדונלדס', description: 'רשת מקדונלד׳ס המציעה תפריט לכל המשפחה', category: 'אחר', city: 'כפר סבא', location_name: 'קניון כפר סבא הירוקה', lat: 32.18, lng: 34.91, entity_type: 'מקום_קבוע', schedule_type: 'fixed_hours', audience: 'family', family_fit: ['מתאים לילד ולהורה'] } };
  current = mcd;
  for (const trustedOverride of [false, true]) {
    const r = await handBackIncoming(client, mcd, { settings, userId: 'u', cache: new Map(), today: '2026-09-24', counters: null, trustedOverride });
    assert.deepEqual([r.outcome, r.why], ['awaiting_policy', 'content_safety:business_listing'], `trustedOverride=${trustedOverride}`);
  }
  // a legitimate mall children's workshop passes the gate and proceeds to the (here unreachable) approve step
  const workshop = { ...base, extracted_data: { name: 'סדנת יצירה לילדים', description: 'סדנת יצירה לילדים בקומה 2', category: 'יצירה', city: 'כפר סבא', location_name: 'קניון כפר סבא הירוקה', lat: 32.18, lng: 34.91, entity_type: 'אירוע', schedule_type: 'one_time', one_time_date: '2026-10-01', audience: 'children' } };
  current = workshop;
  const w = await handBackIncoming(client, workshop, { settings, userId: 'u', cache: new Map(), today: '2026-09-24', counters: null });
  assert.notEqual(w.outcome, 'awaiting_policy', JSON.stringify(w));
});

test('a held row is human work in the review budget, not a Cleaner or trust bucket', () => {
  assert.equal(classifyIncoming({ status: 'needs_review', match_type: 'new', validation_issues: [G.SAFETY_ISSUE_LABEL], city: 'x', location_name: 'y' }), 'requires_human_judgment');
});

test('twin parity: the Node child-age rule is the extraction.ts rule; both twins export the same surface', () => {
  const ext = fs.readFileSync(path.join(SHARED, 'extraction.ts'), 'utf8');
  assert.ok(ext.includes(`const CHILD_AGE_RE = ${G.CHILD_AGE_RE.toString()};`), 'CHILD_AGE_RE identical to extraction.ts');
  const ts = fs.readFileSync(path.join(SHARED, 'autoPublishSafety.ts'), 'utf8');
  for (const name of ['childAgeEvidence', 'strongChildWords', 'isCommercialContext', 'assessAutoPublishSafety']) {
    assert.ok(new RegExp(`export function ${name}\\(`).test(ts), `TS ${name}`); assert.equal(typeof G[name], 'function', `JS ${name}`);
  }
  for (const [re, label] of [[/STRONG_CHILD_WORDS = (\[[^\]]+\])/, 'STRONG_CHILD_WORDS'], [/FAMILY_WORDS = (\[[^\]]+\])/, 'FAMILY_WORDS']]) {
    const tsList = ts.match(re)[1];
    assert.deepEqual(eval(tsList), G[label], label); // eslint-disable-line no-eval
  }
  const cats = JSON.parse(fs.readFileSync(path.join(SHARED, 'categoryValues.json'), 'utf8')).categories;
  for (const c of G.CHILD_INTRINSIC_CATEGORIES) assert.ok(cats.includes(c), `${c} is a canonical category`);
});
