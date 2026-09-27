// TuRu - Activities ordinary search misrouting hotfix (2026-09-27).
//
// Production bug: on /activities, typing a plain keyword ("ספארי") and pressing חיפוש/Enter opened
// the "איפה נוח לכם?" location picker instead of searching. Root cause: handleFreeSearch
// (app/activities.js) carried its own inline "!hasAnyLocation && !filters.location?.mode -> open
// LocationQuickPicker" gate, added 2026-09-10 (889cec6) BEFORE product decision 1 landed
// (836e4c5, 2026-09-21: "Free Search with no geographic intent is nationwide") and never removed
// to match it - so a plain query was intercepted before ever reaching applyFreeSearchIntent's
// already-correct nationwide fallback. It stayed invisible while Free Search was an opt-in toggle
// button; b8770e6 (2026-09-27, "Activities Top-Area Simplification") made the field permanently
// visible and turned the dormant gate into a user-facing regression.
//
// Same "read the real source, assert on it" pattern as tests/mobileUiPolish2026_09_26.test.js /
// tests/categoryHintDrift.test.js - this repo has no RN rendering harness (no jest +
// @testing-library/react-native), so component wiring is pinned at the source-text level. The
// underlying decision logic (intentToFilters/applyFreeSearchIntent producing a nationwide, non-
// excluding filter for a geography-free intent) is already covered as pure-function tests in
// tests/freeSearchLocation.test.js - this file exists to lock down the app/activities.js WIRING
// around that logic: which handler each submit path calls, and that no gate re-intercepts before
// applyFreeSearchIntent runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const activitiesSrc = read('app/activities.js');

function slice(src, fromMarker, toMarker) {
  const start = src.indexOf(fromMarker);
  assert.notEqual(start, -1, `marker not found: ${fromMarker}`);
  const end = toMarker ? src.indexOf(toMarker, start) : src.length;
  assert.notEqual(end, -1, `end marker not found: ${toMarker}`);
  return src.slice(start, end);
}

const handleFreeSearchBody = slice(activitiesSrc, 'const handleFreeSearch = async', 'סגירת LocationQuickPicker של ההבהרה');

// --- A + B: no selected location, ordinary text, click Search / press Enter -------------------

test('Activities: the Search button (onPress) and Enter (onSubmitEditing) call the exact same handler', () => {
  const searchBox = slice(activitiesSrc, 'styles.freeSearchBox', 'TOOLBAR');
  assert.match(searchBox, /onSubmitEditing=\{\(\)\s*=>\s*handleFreeSearch\(\)\}/, 'Enter/submit must call handleFreeSearch');
  assert.match(searchBox, /onPress=\{\(\)\s*=>\s*handleFreeSearch\(\)\}/, 'the חיפוש button must call the same handleFreeSearch');
});

test('Activities: handleFreeSearch no longer contains the over-broad "no location -> open picker" gate', () => {
  // The exact regressed pattern: computing hasAnyLocation and short-circuiting into
  // setFreeSearchClarify before applyFreeSearchIntent runs. If this reappears, ordinary keyword
  // search is broken again exactly like the reported production bug.
  assert.doesNotMatch(handleFreeSearchBody, /hasAnyLocation/, 'the removed gate must not come back');
  assert.doesNotMatch(handleFreeSearchBody, /clarifyArea/, 'the clarifyArea message path must not come back');
  assert.doesNotMatch(handleFreeSearchBody, /mode:\s*'plain'/, 'the plain clarify mode must not come back');
});

test('Activities: after the server-driven needsClarification check, applyFreeSearchIntent runs unconditionally', () => {
  // Only ONE conditional return remains between parseSmartSearchQuery and applyFreeSearchIntent:
  // data.needsClarification (the server's own "street with no city" signal). Nothing else may
  // stand between them - in particular nothing keyed off filters.location or the parsed intent's
  // own location fields, which is exactly the class of bug that was reported.
  const afterNeedsClarificationBlock = handleFreeSearchBody.slice(handleFreeSearchBody.indexOf("if (data.needsClarification) {"));
  const returnsBeforeApply = afterNeedsClarificationBlock.slice(0, afterNeedsClarificationBlock.indexOf('applyFreeSearchIntent(data.intent)')).match(/return;/g) || [];
  assert.equal(returnsBeforeApply.length, 1, 'exactly one early return (needsClarification) should stand between parsing and applying the search');
  assert.match(handleFreeSearchBody, /applyFreeSearchIntent\(data\.intent\);/, 'a plain/geo intent must reach applyFreeSearchIntent unconditionally');
});

// --- C: existing selected location, ordinary text -> normal existing-location behavior, no reopen ---

test('Activities: handleFreeSearch never branches on filters.location before applying the search', () => {
  // Confirms scenario C is handled by the SAME single path as A/B (no location-mode-dependent
  // branch exists at all anymore) - so an existing selection cannot trigger the picker either.
  assert.doesNotMatch(handleFreeSearchBody, /filters\.location/, 'handleFreeSearch must not read filters.location at all');
});

// --- D: explicit location-control click still opens the picker -------------------------------

test('Activities: the explicit location gate control still opens its OWN picker, independent of free-search clarify', () => {
  assert.match(activitiesSrc, /onPress=\{\(\)\s*=>\s*setGateLocationOpen\(true\)\}/, 'explicit location row must still open the gate');
  // Two textually distinct <LocationQuickPicker> instances must exist: one keyed off
  // gateLocationOpen (explicit location control) and one keyed off freeSearchClarify (free-search's
  // own street-clarification round) - a click on the location row cannot be confused with a search
  // submission, and vice versa.
  const pickerBlocks = activitiesSrc.split('<LocationQuickPicker').slice(1);
  const gatePicker = pickerBlocks.find((b) => b.includes('visible={gateLocationOpen}'));
  const clarifyPicker = pickerBlocks.find((b) => b.includes('visible={!!freeSearchClarify}'));
  assert.ok(gatePicker, 'expected a <LocationQuickPicker visible={gateLocationOpen} ...>');
  assert.ok(clarifyPicker, 'expected a <LocationQuickPicker visible={!!freeSearchClarify} ...>');
  assert.notEqual(gatePicker, clarifyPicker);
});

test('Activities: freeSearchClarify (the picker used by free search) is only ever set to a "street" clarification, never a bare-no-location one', () => {
  const setters = [...activitiesSrc.matchAll(/setFreeSearchClarify\(\{[^}]*\}\)/g)].map((m) => m[0]);
  const withMode = setters.filter((s) => s.includes('mode:'));
  assert.ok(withMode.length >= 1, 'expected at least one setFreeSearchClarify call with a mode');
  for (const s of withMode) assert.match(s, /mode:\s*'street'/, `every setFreeSearchClarify call must be the server-driven 'street' case, got: ${s}`);
});

// --- E: clearing the search restores the normal (unfiltered-by-text) catalogue -----------------

test('Activities: clearing the search-intent chip resets ONLY the text query (q), not location/filters', () => {
  const clearFn = slice(activitiesSrc, 'const clearSearchIntent =', '\n');
  assert.match(clearFn, /setField\('q', ''\)/);
});

// --- F: ordinary Activities search and Home smart-search remain fully separate handlers --------

test('Activities free search (handleFreeSearch) does not import or call the Home area-clarification gate (needsAreaClarification)', () => {
  assert.doesNotMatch(activitiesSrc, /needsAreaClarification/, 'Activities must not reuse the Home smart-search area gate - that gate legitimately forces a location for a screen navigation; Activities filters an already-visible list and must not');
});

test('Home (app/index.js) keeps its own, separate needsAreaClarification gate for handleSmartSearch - untouched by this fix', () => {
  const homeSrc = read('app/index.js');
  assert.match(homeSrc, /import \{[^}]*needsAreaClarification[^}]*\} from '\.\.\/lib\/smartSearch'/);
  assert.match(homeSrc, /if \(needsAreaClarification\(data\.intent, filters\.location\)\) \{/);
});
