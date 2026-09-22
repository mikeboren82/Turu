// Hebrew diacritic / quote-variant normalization ("Normalize Hebrew City Names for Stable
// Fingerprints", 2026-09-22). normalizeCityName already folded hyphen/maqaf variants but left
// niqqud/teamim and gershayim-vs-ASCII-quote untouched, so a scan that spelled a city WITH niqqud
// (a plausible LLM output) never matched the plain-Hebrew form already stored - two different
// city-form fingerprint segments for the same city. Narrow fix: strip Hebrew combining marks
// (U+0591-05C7) and fold geresh/gershayim + their ASCII equivalents to nothing. Does not add any
// settlement-alias mapping (תל אביב stays תל אביב, never תל אביב יפו) - that is a different,
// deliberately out-of-scope concern.
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeCityName } = require('../cityNaming');

test('niqqud/teamim are stripped without touching the base letters', () => {
  assert.equal(normalizeCityName('בְּאֵר שֶׁבַע'), 'באר שבע');
  assert.equal(normalizeCityName('בֵּית שֶׁמֶשׁ'), 'בית שמש');
  assert.equal(normalizeCityName('באר שבע'), 'באר שבע');
});

test('gershayim (Hebrew) and ASCII double-quote fold to the same value', () => {
  assert.equal(normalizeCityName('כפר ביל״ו'), normalizeCityName('כפר ביל"ו'));
  assert.equal(normalizeCityName('כפר ביל״ו'), 'כפר בילו');
});

test('geresh (Hebrew) and ASCII apostrophe fold to the same value', () => {
  assert.equal(normalizeCityName('ג\'לג\'וליה'), normalizeCityName('ג׳לג׳וליה'));
  assert.equal(normalizeCityName('ג׳לג׳וליה'), 'גלגוליה');
});

test('hyphen / maqaf regression: existing equivalence is unchanged', () => {
  assert.equal(normalizeCityName('באר-שבע'), 'באר שבע');
  assert.equal(normalizeCityName('באר־שבע'), 'באר שבע'); // maqaf (U+05BE)
  assert.equal(normalizeCityName('באר שבע'), 'באר שבע');
  assert.equal(normalizeCityName('תל אביב-יפו'), 'תל אביב יפו');
});

test('plain Hebrew with no diacritics/quotes is unchanged', () => {
  assert.equal(normalizeCityName('חולון'), 'חולון');
  assert.equal(normalizeCityName('קריית מוצקין'), 'קריית מוצקין');
  assert.equal(normalizeCityName('קרית מוצקין'), 'קריית מוצקין'); // pre-existing קרית->קריית behavior, untouched
});

test('Latin city names are unchanged', () => {
  assert.equal(normalizeCityName('Tel Aviv'), 'Tel Aviv');
  assert.equal(normalizeCityName("Ma'ale Adumim"), 'Maale Adumim'); // ASCII apostrophe still folds - same rule applies to Latin
});

test('digits and internal spacing are preserved', () => {
  assert.equal(normalizeCityName('רמת גן 2'), 'רמת גן 2');
  assert.equal(normalizeCityName('  חולון  '), 'חולון');
});

// Canonical City Alias Fix (2026-09-22): a merged-municipality short form is a DIFFERENT STRING for
// the same settlement (unreachable by the punctuation/niqqud transforms above), confirmed as a live
// recurrence bug via the "קונטקט לגיל הרך" duplicate (see project memory). Each alias below was
// verified against real location addresses before being added - never inferred from name shape alone.
test('CANONICAL ALIAS: תל אביב short form canonicalizes to the official תל אביב יפו, in every punctuation variant', () => {
  assert.equal(normalizeCityName('תל אביב'), 'תל אביב יפו');
  assert.equal(normalizeCityName('תל אביב יפו'), 'תל אביב יפו');
  assert.equal(normalizeCityName('תל אביב-יפו'), 'תל אביב יפו');
  assert.equal(normalizeCityName('תל אביב־יפו'), 'תל אביב יפו'); // maqaf (U+05BE)
});

test('CANONICAL ALIAS: מודיעין and קדימה short forms canonicalize to their official merged-municipality names (verified against live location addresses, not inferred from name shape)', () => {
  assert.equal(normalizeCityName('מודיעין'), 'מודיעין מכבים רעות');
  assert.equal(normalizeCityName('קדימה'), 'קדימה צורן');
});

test('CANONICAL ALIAS: unrelated/distinct localities never collapse into the aliased forms', () => {
  assert.notEqual(normalizeCityName('תל אביב'), normalizeCityName('רמת גן'));
  assert.notEqual(normalizeCityName('תל אביב'), normalizeCityName('יפו העתיקה'));
  assert.equal(normalizeCityName('יפו העתיקה'), 'יפו העתיקה', 'a real distinct locality name must never be swept into the alias table');
  assert.notEqual(normalizeCityName('מודיעין עילית'), normalizeCityName('מודיעין'), 'מודיעין עילית is a wholly separate city, never touched by the מודיעין alias (exact-match only, not a prefix match)');
});

test('distinct cities never collapse into each other after the fix', () => {
  assert.notEqual(normalizeCityName('בְּאֵר שֶׁבַע'), normalizeCityName('בֵּית שֶׁמֶשׁ'));
  assert.notEqual(normalizeCityName('באר שבע'), normalizeCityName('בית שמש'));
});
