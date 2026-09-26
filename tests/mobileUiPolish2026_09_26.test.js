// Mobile UI Polish (2026-09-26) - source-level regression pins for the parts of this pass that
// are NOT pure functions (HomeHero/ActivityCard/login JSX+styles) and would otherwise need a full
// RN rendering harness (jest + @testing-library/react-native) that this repo does not have. Same
// "read the real source, assert on it" pattern as tests/venueAttestation.test.js /
// tests/categoryHintDrift.test.js - catches an accidental revert without being pixel-perfect.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// --- 1. Home top-actions clipping: heroSideAction must be bounded to its own flex column ---

test('HomeHero: the side action (חיפוש חופשי / בחירה מהירה) is width-bound to its column, not free to overflow past the screen edge', () => {
  const src = read('components/HomeHero.js');
  const decl = src.slice(src.indexOf('heroSideAction:'), src.indexOf('heroSideActionPressed:'));
  assert.match(decl, /width:\s*'100%'/, 'heroSideAction must fill exactly its flex:1 column - the original clipping bug was an unbounded Pressable overflowing past it');
});

test('HomeHero: both side labels have a font-shrink safety net (adjustsFontSizeToFit) so the full Hebrew label is never truncated or clipped', () => {
  const src = read('components/HomeHero.js');
  const freeBlock = src.slice(src.indexOf("onPress={() => onSwitchMode('free')}"), src.indexOf("onPress={() => onSwitchMode('guided')}"));
  const guidedBlock = src.slice(src.indexOf("onPress={() => onSwitchMode('guided')}"));
  for (const [label, block] of [['free search', freeBlock], ['quick choice', guidedBlock]]) {
    assert.match(block, /adjustsFontSizeToFit/, `${label} label`);
    assert.match(block, /minimumFontScale/, `${label} label`);
    assert.match(block, /numberOfLines=\{1\}/, `${label} label still stays on one line, never wraps`);
  }
});

test('HomeHero: heroCompact now covers the real reported Android widths (360-412), not only <360', () => {
  const src = read('app/index.js');
  assert.match(src, /const heroCompact = windowWidth < 420/, 'threshold widened to include 360/375/390/412 from the request');
});

test('HomeHero: the compact side-column padding and center-column width are actually wired to heroCompact', () => {
  const src = read('components/HomeHero.js');
  assert.match(src, /heroCompact && styles\.heroSideColLeftCompact/);
  assert.match(src, /heroCompact && styles\.heroSideColRightCompact/);
  assert.match(src, /heroCompact && styles\.heroCenterColCompact/);
  assert.match(src, /heroCenterColCompact:\s*\{\s*width:\s*108/);
});

// --- 2. Home: the three decorative orange dots beside "בחירה מהירה" are gone ---

test('HomeHero: the hop-trail dots are fully removed - no hopTrail/hopDot JSX or styles remain', () => {
  const src = read('components/HomeHero.js');
  assert.doesNotMatch(src, /<View style=\{styles\.hopTrail\}/, 'no hopTrail element in the JSX');
  assert.doesNotMatch(src, /hopDot1:|hopDot2:|hopDot3:/, 'no hopDot style declarations left behind');
  // the icon itself (home-quick-choice-orange.png) and its circular wrap must be untouched - only the dots go
  assert.match(src, /home-quick-choice-orange\.png/);
  assert.match(src, /heroSideActionIconWrap:/);
});

// --- 3. Home: carousel centering wiring (padding + snap + dots) is present on all three branches ---

test('Home: every discovery-carousel ScrollView centers its first card (padding) and native-snaps card to card', () => {
  const src = read('app/index.js');
  const scrollViews = src.split('<ScrollView').slice(1).filter((s) => s.includes('recRow'));
  assert.ok(scrollViews.length >= 3, `expected the 3 recRow ScrollViews (locked-preview / loading / real), found ${scrollViews.length}`);
  for (const sv of scrollViews) {
    assert.match(sv, /paddingHorizontal:\s*carouselSidePad/, 'centers the first/last card instead of hugging the physical edge');
    assert.match(sv, /snapToInterval=\{CAROUSEL_CARD_WIDTH \+ CAROUSEL_GAP\}/, 'real center-to-center snapping, not a simulated one');
    assert.match(sv, /decelerationRate="fast"/);
  }
});

test('Home: the carousel active-card index is tracked and fed to CarouselDots for both the locked-preview and real states', () => {
  const src = read('app/index.js');
  assert.match(src, /import CarouselDots from '..\/components\/CarouselDots'/);
  assert.match(src, /handleRecScrollEnd\(4\)/, 'locked-preview branch always renders exactly 4 cards');
  assert.match(src, /handleRecScrollEnd\(recommendations\.length\)/, 'real branch tracks the actual recommendation count');
  assert.match(src, /<CarouselDots count=\{4\} activeIndex=\{recActiveIndex\} \/>/);
  assert.match(src, /<CarouselDots count=\{recommendations\.length\} activeIndex=\{recActiveIndex\} \/>/);
});

test('Home: the active index resets when the carousel\'s own card count changes (no dot pointing at a card that no longer exists) - see carouselTrueSymmetryFollowup2026_09_26.test.js for the interior-start-index behavior itself', () => {
  const src = read('app/index.js');
  assert.match(src, /useEffect\(\(\) => \{ setRecActiveIndex\(carouselInitialIndex\(recDotsCount\)\); \}, \[recDotsCount\]\)/);
});

test('CarouselDots: renders nothing for 0 or 1 item, and clamps an out-of-range active index', () => {
  const src = read('components/CarouselDots.js');
  assert.match(src, /if \(!count \|\| count <= 1\) return null/);
  assert.match(src, /Math\.min\(Math\.max\(activeIndex \|\| 0, 0\), count - 1\)/);
});

// --- 4. Registration: heart repetition reduced. Superseded by the "no heart icon" follow-up
// (2026-09-26) - see tests/carouselTrueSymmetryFollowup2026_09_26.test.js for the current
// assertions (the 'saved' benefit is now the ⭐ emoji, no heart icon or emoji anywhere in the row).

test('login: the headline yellow heart emoji itself is untouched (still 💛 in the he locale)', () => {
  const auth = read('lib/i18n/locales/he/auth.json');
  assert.match(auth, /registerTitle.*💛/);
});

// --- 5. Activity card placeholder: the swing-kangaroo illustration gets breathing room, still fully "contain" ---

test('ActivityCard: the placeholder illustration is inset (84%) inside its frame, not edge-to-edge via ImageBackground', () => {
  const src = read('components/ActivityCard.js');
  const branch = src.slice(src.indexOf('placeholderImageFor(placeholderGroup, id, category) ? ('), src.indexOf(') : ('));
  assert.doesNotMatch(branch, /<ImageBackground/, 'no longer an edge-to-edge ImageBackground for placeholders');
  assert.match(branch, /resizeMode="contain"/, 'still fully "contain" - no photo/placeholder pixel is ever cropped');
  assert.match(branch, /style=\{styles\.placeholderImageArt\}/);
  assert.match(src, /placeholderImageArt:\s*\{\s*width:\s*'84%',\s*height:\s*'84%'/);
  // the real-photo branch (imageUrl) must be completely untouched - still edge-to-edge cover via ImageBackground
  const photoBranch = src.slice(src.indexOf('imageUrl ? ('), src.indexOf('placeholderImageFor(placeholderGroup, id, category) ? ('));
  assert.match(photoBranch, /<ImageBackground source=\{\{ uri: imageUrl \}\} style=\{styles\.image\}>/, 'real photos still use the original edge-to-edge ImageBackground/cover behaviour');
});

test('ActivityCard: the overlay buttons (hide / favorite / visited / note) still render on top of the placeholder frame', () => {
  const src = read('components/ActivityCard.js');
  const branch = src.slice(src.indexOf('placeholderImageFor(placeholderGroup, id, category) ? ('), src.indexOf(') : ('));
  assert.match(branch, /\{imageOverlay\}/);
});

test('ActivityCard: placeholder image selection itself (which file gets shown per group/category) is unchanged', () => {
  // lib/placeholderImages.js is untouched by this pass - tests/placeholderImages.test.js already
  // covers its own behaviour; this just pins that ActivityCard still calls the same two functions.
  const src = read('components/ActivityCard.js');
  assert.match(src, /placeholderImageFor\(placeholderGroup, id, category\)/);
  assert.match(src, /placeholderBgColorFor\(placeholderGroup\)/);
});
