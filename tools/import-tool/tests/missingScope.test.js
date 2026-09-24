const test = require('node:test');
const assert = require('node:assert/strict');
const { decideMissing, scopeKey, normalizeForPresence } = require('../lib/missingScope');

// Same matrix as supabase/functions/_shared/missingScope.test.ts - the twins must agree.
const CAL = 'https://www.holon.muni.il/Havingfun/pages/allevents.aspx';
const KEY = scopeKey(CAL);
const act = (over = {}) => ({ id: 'a', name: 'ילדי בית העץ', consecutive_missing_scans: 0, rows: [{ page_url: `${CAL}#part=4`, key: KEY }], ...over });
const scope = (over = {}) => ({ complete: true, changedProcessed: true, text: normalizeForPresence('לוח אירועים גוליבר 10:00'), ...over });
const one = (k, s) => new Map([[k, s]]);

test('scopeKey: relay parts and seed case variants are one listing page', () => {
  assert.equal(scopeKey(`${CAL}#part=4`), scopeKey('https://holon.muni.il/Havingfun/Pages/AllEvents.aspx#part=2'));
  assert.equal(scopeKey(`${CAL}#part=4`), KEY);
});

test('decideMissing: the matrix', () => {
  const present = scope({ text: normalizeForPresence('... ילדי בית העץ 10:30 ...') });
  assert.equal(decideMissing(act(), one(KEY, present), false).action, 'seen_on_page');
  assert.equal(decideMissing(act(), one(KEY, { ...present, changedProcessed: false }), false).action, 'seen_on_page');
  assert.equal(decideMissing(act(), one(KEY, scope()), true).action, 'seen_matched');
  assert.equal(decideMissing(act(), one(KEY, scope()), false).action, 'absent');
  assert.equal(decideMissing(act(), one(KEY, scope({ changedProcessed: false })), false).reason, 'unchanged_no_new_evidence');
  assert.equal(decideMissing(act(), one(KEY, scope({ complete: false })), false).reason, 'scope_incomplete');
  assert.equal(decideMissing(act(), one('other.page/x', scope()), false).reason, 'scope_not_checked');
  assert.equal(decideMissing(act({ rows: [] }), one(KEY, scope()), false).reason, 'no_listing_provenance');
  assert.equal(decideMissing(act({ rows: [...act().rows, { page_url: 'https://x.il/b', key: 'x.il/b' }] }), one(KEY, scope()), false).reason, 'scope_not_checked');
  assert.equal(decideMissing(act({ name: 'יוגה' }), one(KEY, scope({ text: 'יוגה לגיל הרך' })), false).action, 'seen_on_page');
  assert.equal(decideMissing(act({ name: 'אב' }), one(KEY, scope({ text: 'אב ובן' })), false).action, 'present_short_name');
});
