// TuRu - "Carousel true symmetry + registration emoji" follow-up (2026-09-26), on top of Mobile UI
// Polish (same day). Source-level regression pins, same "read the real source, assert on it"
// pattern as tests/mobileUiPolish2026_09_26.test.js - this repo has no RN rendering harness, so a
// real ScrollView's on-screen contentOffset can't be asserted directly; the pure math it is built
// from (carouselInitialIndex/carouselOffsetForIndex) is fully covered in tests/homeCarousel.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// --- 1. Home carousel: true initial symmetry (interior start index, not the dataset's edge) ---

test('Home: imports carouselOffsetForIndex/carouselInitialIndex alongside the existing carousel helpers', () => {
  const src = read('app/index.js');
  const homeCarouselImportEnd = src.indexOf("from '../lib/homeCarousel'");
  const importDecl = src.slice(homeCarouselImportEnd - 200, homeCarouselImportEnd + 30);
  assert.match(importDecl, /carouselSidePadding/);
  assert.match(importDecl, /carouselActiveIndex/);
  assert.match(importDecl, /carouselOffsetForIndex/);
  assert.match(importDecl, /carouselInitialIndex/);
});

test('Home: recDotsCount mirrors whichever carousel branch is actually rendered - fixed 4 for locked-preview, the live count once a location is known', () => {
  const src = read('app/index.js');
  assert.match(src, /const recDotsCount = carouselLocationKnown \? recommendations\.length : 4;/);
});

test('Home: the initial index/offset are derived from recDotsCount via the shared helpers, not hardcoded', () => {
  const src = read('app/index.js');
  assert.match(src, /const recCarouselInitialIndex = carouselInitialIndex\(recDotsCount\);/);
  assert.match(src, /const recCarouselInitialOffset = carouselOffsetForIndex\(recCarouselInitialIndex, CAROUSEL_CARD_WIDTH, CAROUSEL_GAP\);/);
});

test('Home: the dot state starts (and resets) at the SAME interior index the ScrollViews center on, not always 0', () => {
  const src = read('app/index.js');
  assert.match(src, /useState\(recCarouselInitialIndex\)/, 'initial recActiveIndex must match the carousel\'s own starting index');
  assert.match(src, /useEffect\(\(\) => \{ setRecActiveIndex\(carouselInitialIndex\(recDotsCount\)\); \}, \[recDotsCount\]\)/);
});

test('Home: both the locked-preview and the real recommendations ScrollView start already centered on recCarouselInitialOffset (native contentOffset AND a ref for the web scrollTo fallback)', () => {
  const src = read('app/index.js');
  const scrollViews = src.split('<ScrollView').slice(1).filter((s) => s.includes('recRow') && s.includes('onMomentumScrollEnd'));
  assert.equal(scrollViews.length, 2, 'the locked-preview (count 4) and real (count recommendations.length) branches - the loading skeleton has no dots/identity and is intentionally left alone');
  for (const sv of scrollViews) {
    assert.match(sv, /contentOffset=\{\{ x: recCarouselInitialOffset, y: 0 \}\}/);
    assert.match(sv, /ref=\{recCarouselRef\}/, 'react-native-web ignores contentOffset entirely - this ref is what actually centers it on web');
  }
});

test('Home: react-native-web does NOT support contentOffset (checked directly in node_modules) - this is exactly why the ref+scrollTo fallback below exists, not a redundant belt-and-suspenders', () => {
  const rnwScrollView = read('node_modules/react-native-web/dist/exports/ScrollView/index.js');
  assert.doesNotMatch(rnwScrollView, /contentOffset/, 'if this ever starts matching, the recCarouselRef/useLayoutEffect fallback below may have become genuinely redundant on web too - but it is still correct to keep (native still needs contentOffset, and the ref call is a no-op once already in position)');
});

test('Home: a useLayoutEffect (fires before paint, so no visible jump even on web) drives recCarouselRef.scrollTo to the exact same offset, keyed on which branch is actually mounted', () => {
  const src = read('app/index.js');
  assert.match(src, /import \{\s*\n\s*useState, useCallback, useEffect, useLayoutEffect, useMemo, useRef,\s*\n\s*\} from 'react';/);
  assert.match(src, /const recCarouselRef = useRef\(null\);/);
  const effectDecl = src.slice(src.indexOf('const recCarouselRef = useRef(null);'), src.indexOf('}, [recBranchKey]);') + 20);
  assert.match(effectDecl, /recCarouselRef\.current\.scrollTo\(\{ x: recCarouselInitialOffset, y: 0, animated: false \}\);/);
  assert.match(src, /\}, \[recBranchKey\]\);/, 'keyed on the branch identity, not on every recommendations change - matches contentOffset\'s own "only at mount" native semantics, so web and native behave the same way');
});

test('Home: recBranchKey names exactly the 5 mutually-exclusive carousel branches (locked/loading/error/empty/real), matching the render ternary below it', () => {
  const src = read('app/index.js');
  assert.match(src, /const recBranchKey = !carouselLocationKnown \? 'locked' : recLoading \? 'loading' : recError \? 'error' : recommendations\.length === 0 \? 'empty' : 'real';/);
});

test('lib/homeCarousel: carouselInitialIndex and its offset counterpart are exported (covered by tests/homeCarousel.test.js)', () => {
  const src = read('lib/homeCarousel.js');
  assert.match(src, /function carouselInitialIndex\(count\)/);
  assert.match(src, /if \(!Number\.isFinite\(count\) \|\| count < 3\) return 0;/, '<3 cards falls back to the edge (0) - no fake duplicate card invented to flank it');
  assert.match(src, /module\.exports = \{[\s\S]*carouselInitialIndex[\s\S]*\};/);
});

// --- 2. Registration: no heart anywhere in the "שומרים פעילויות שאהבתם" row - emoji only, ⭐ ---

test('login: BENEFITS has no icon-based entries at all anymore - every row (including "saved") is a plain emoji', () => {
  const src = read('app/login.js');
  const benefitsDecl = src.slice(src.indexOf('const BENEFITS'), src.indexOf('];', src.indexOf('const BENEFITS')) + 2);
  assert.doesNotMatch(benefitsDecl, /icon:/, 'no row declares an icon component anymore');
  assert.match(benefitsDecl, /emoji:\s*'⭐',\s*key:\s*'saved'/, 'the saved row is the ⭐ emoji');
  assert.doesNotMatch(benefitsDecl, /❤|💛/, 'no heart of any kind (outline, filled, or emoji) in the benefits list');
});

test('login: HeartIcon is no longer imported or rendered in login.js (it stays defined in components/icons.js for BottomNav/Header, which are untouched) - the name may still appear in an explanatory comment', () => {
  const src = read('app/login.js');
  assert.doesNotMatch(src, /import \{[^}]*HeartIcon/s, 'no longer imported');
  assert.doesNotMatch(src, /<HeartIcon|b\.icon/, 'no longer rendered as JSX');
});

test('login: the dead icon-vs-emoji branch and its benefitIconWrap style are gone - every benefit row renders through the single emoji Text path', () => {
  const src = read('app/login.js');
  assert.doesNotMatch(src, /b\.icon/, 'BENEFITS no longer has an icon field, so the JSX no longer branches on it');
  assert.doesNotMatch(src, /benefitIconWrap/, 'style removed along with its only usage');
  const benefitsMap = src.slice(src.indexOf('{BENEFITS.map'), src.indexOf('{BENEFITS.map') + 400);
  assert.match(benefitsMap, /style=\{styles\.benefitEmoji\}[^]*?\{b\.emoji\}/, 'every row (including "saved") renders b.emoji the same way');
});

test('login: the headline yellow heart emoji is untouched - only the benefits-row heart was in scope', () => {
  const auth = read('lib/i18n/locales/he/auth.json');
  assert.match(auth, /registerTitle.*💛/);
  const src = read('app/login.js');
  assert.match(src, /registerTitle/, 'sanity: the headline title key is still referenced');
});

test('login: benefit row spacing/alignment is shared, not special-cased per row - benefitEmoji is the only slot style now', () => {
  const src = read('app/login.js');
  assert.match(src, /benefitEmoji:\s*\{\s*fontSize:\s*17,\s*lineHeight:\s*22,\s*width:\s*22,\s*textAlign:\s*'center'\s*\}/);
});
