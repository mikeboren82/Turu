#!/usr/bin/env node
/*
 * TuRu - Taxonomy Reclassification Phase D: READ-ONLY production catalogue audit + dry run.
 *
 * ############################################################################
 * # THIS SCRIPT PERFORMS ZERO WRITES. It issues SELECTs only.                #
 * # No UPDATE / DELETE / INSERT / upsert / rpc / merge / archive anywhere.   #
 * # It emits report artifacts to tools/import-tool/reports/ and nothing else.#
 * ############################################################################
 *
 * Purpose: audit every catalogue record against the semantic model committed in 29cacf4
 * (constants/categorySemantics.json) plus the approved-but-not-yet-built "חיות וגני חיות"
 * concept, and propose - never apply - a classification per record.
 *
 * The governing rule is PRIMARY EXPERIENCE: what is the visitor mainly there to do.
 * Size, ticketing, popularity, "being a destination" and the venue's NAME are explicitly
 * not sufficient evidence (see FALSE_POSITIVE_GUARDS below).
 *
 * Run: node tools/import-tool/audit-category-taxonomy.js
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://kkvgzubwsjsbqxzjejcs.supabase.co';
const ANON = process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_t1vcj_DxtlmdSeCt1AW6HA_LrXrZaI-';
const PAGE = 1000;
const OUT_DIR = path.join(__dirname, 'reports');
const STAMP = '2026-09-21';

const semantics = require('../../constants/categorySemantics.json');
const categoryValues = require('../../constants/categoryValues.json');

// ---------------------------------------------------------------------------------------------
// Evidence vocabulary. Each term is a CONTIGUOUS phrase matched against normalized text.
// Terms are chosen to be diagnostic of a PRIMARY EXPERIENCE, not merely associated with it.
// ---------------------------------------------------------------------------------------------
const SIGNALS = {
  PARK: {
    strong: ['דונם', 'מדשאה', 'מדשאות', 'פארק עירוני', 'גן ציבורי', 'פיקניק', 'מנגלים', 'מנגל',
      'טיילת', 'מסלול הליכה', 'מסלולי הליכה', 'שבילי הליכה', 'שביל אופניים', 'אמפי', 'חורשה',
      'פארק ציבורי', 'ריאה ירוקה', 'שטח ירוק'],
    weak: ['ספסלים', 'ברזיות', 'צל', 'עצים', 'טבע עירוני', 'גינה'],
  },
  PLAYGROUND: {
    strong: ['מתקני משחק', 'מתקני משחקים', 'ציוד משחקים', 'מתקן משחקים', 'מגלשה', 'מגלשות',
      'נדנדה', 'נדנדות', 'ארגז חול', 'מתקני טיפוס', 'קרוסלה לילדים', 'גן משחקים', 'מגרש משחקים'],
    weak: ['לילדים בכל הגילאים', 'משחקים לילדים', 'פעוטות'],
  },
  ATTRACTION_COMPLEX: {
    // Actual rides / built entertainment installations. NOT "attraction" as a word.
    strong: ['רכבת הרים', 'גלגל ענק', 'מכוניות מתנגשות', 'קרוסלות', 'לונה פארק', 'לונהפארק',
      'luna park', 'מתקני שעשועים', 'פארק אתגרים', 'אתגרים', 'קארטינג', 'גו קארט',
      'סימולטור', 'מתקנים ממונעים', 'רכבת שדים'],
    weak: ['אטרקציות', 'מתחם בילוי', 'מתקנים', 'בילוי משפחתי'],
  },
  ANIMALS: {
    strong: ['גן חיות', 'גן החיות', 'ספארי', 'אקווריום', 'פינת חי', 'פינת ליטוף', 'בעלי חיים',
      'חיות מדבר', 'זוחלים', 'קופים', 'ציפורים', 'חוות סוסים', 'רכיבה על סוסים', 'אלפקות',
      'פארק חיות', 'מפגש עם חיות', 'האכלת חיות'],
    weak: ['חיות', 'ליטוף', 'חווה'],
  },
  MUSEUM_SCIENCE: {
    strong: ['מוזיאון', 'מוזיאון מדע', 'מדעטק', 'תערוכה', 'תערוכות', 'מרכז מדע', 'פלנטריום',
      'חוויית למידה', 'ניסויים', 'מיצגים'],
    weak: ['מדע', 'היסטוריה', 'ארכיאולוגי', 'אינטראקטיבי'],
  },
  NATURE: {
    strong: ['שמורת טבע', 'גן לאומי', 'נחל', 'מעיין', 'יער', 'מצפור', 'טיול רגלי', 'אתר טבע'],
    weak: ['טבע', 'נוף'],
  },
  WATER: {
    strong: ['פארק מים', 'בריכת שחייה', 'מגלשות מים', 'ווטר פארק', 'בריכה'],
    weak: ['מים', 'מתקני מים'],
  },
};

// Things that must NEVER on their own drive a classification (section 14).
const FALSE_POSITIVE_GUARDS = [
  'the token "פארק" inside a venue NAME is not evidence of an attraction complex',
  'playground equipment inside a large municipal park does not make it a playground',
  'being ticketed / paid entry is not evidence of an attraction complex',
  'being a large multi-activity family destination is not evidence of an attraction complex',
  'the word "אטרקציה"/"אטרקציות" alone is not evidence of an attraction complex',
  'the word "שעשועים" alone is not evidence of either playground or attraction complex',
  'an animal destination with several activities is still an ANIMAL experience',
];

const norm = (s) => String(s ?? '')
  .replace(/["״“”'׳’`]/g, '')
  .replace(/[-–—־]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();

// Matched STRONG phrases are removed from the haystack before weak matching, so a single stretch
// of text cannot be counted twice. Without this, "ציוד משחקים לילדים" scored as both the strong
// "ציוד משחקים" AND the weak "משחקים לילדים", which was enough to tie פארק שרונה (a known product
// decision: it is a PARK) against its own park-scale evidence.
// Drops any matched phrase that is contained inside ANOTHER matched phrase of the same group, so
// one stretch of text is never counted twice. Two distinct nesting bugs were found this way:
//   - "מתקני משחק" is a substring of "מתקני משחקים" (both in PLAYGROUND.strong), which double-
//     scored play equipment and pushed פארק נחל חדרה - a river park WITH a playground in it -
//     to "playground, HIGH".
//   - "ציוד משחקים לילדים" matched strong "ציוד משחקים" and weak "משחקים לילדים", which tied
//     פארק שרונה against its own park-scale evidence (a known product decision: it is a PARK).
function dedupeNested(matches) {
  return matches.filter((m) => !matches.some((other) => other !== m && norm(other).includes(norm(m))));
}

function countSignals(text, group) {
  let hay = norm(text);
  const strong = dedupeNested((group.strong || []).filter((t) => hay.includes(norm(t))));
  for (const t of strong) hay = hay.split(norm(t)).join(' ');
  const weak = dedupeNested((group.weak || []).filter((t) => hay.includes(norm(t))));
  return { strong, weak, score: strong.length * 2 + weak.length };
}

// ---------------------------------------------------------------------------------------------
// The dry-run classifier. Returns a PROPOSED SEMANTIC category - never a DB write.
// Note the deliberate asymmetry: proposals are semantic concept names. ATTRACTION_COMPLEX's
// current DB value remains the legacy 'פארק שעשועים' (see section 17 of the brief) and
// חיות וגני חיות has no DB value at all yet.
// ---------------------------------------------------------------------------------------------
function classify(activity) {
  const nameOnly = norm(activity.name);
  // Split the RAW name, before norm() - norm() rewrites dashes to spaces, so splitting the
  // normalized string silently never matched and the address guard below was a no-op.
  const nameHeadRaw = norm(String(activity.name ?? '').split(/\s[–—-]\s|\s\|\s/)[0]);
  // Scanner-generated OSM names follow "גן שעשועים – <street>, <city>". The portion after the
  // dash is ADDRESS METADATA, not experience evidence, and it routinely carries another concept's
  // vocabulary: "גן שעשועים – טיילת קרית אליעזר, חיפה" is a playground ON a promenade, and
  // "גן שעשועים – דרך גן החיות, ירושלים" is a playground on Zoo Road. Left unguarded this produced
  // dozens of bogus "this playground is really a park/zoo" proposals. Stripping is applied ONLY to
  // this scanner convention - for an ordinary name like
  // "פארק אתגרי טופ 94 – מתחם האטרקציות הגדול באילת" the text after the dash is real description.
  const scannerNamed = /^(גן|גני)\s?(שעשועים|משחקים)/.test(nameHeadRaw) || /^מגרש\s?משחקים/.test(nameHeadRaw);
  const nameForEvidence = scannerNamed ? nameHeadRaw : activity.name;
  const text = [nameForEvidence, activity.description].filter(Boolean).join(' . ');
  const ev = {};
  for (const [key, group] of Object.entries(SIGNALS)) ev[key] = countSignals(text, group);

  const evidence = [];
  const negativeEvidence = [];
  let proposed = null;
  let confidence = 'LOW';
  let reason = '';

  const hasDescription = !!(activity.description && activity.description.trim().length > 15);

  // Source provenance as SUPPORTING evidence only - it can corroborate or downgrade, never decide.
  // playground.co.il is a playground-equipment contractor's project index; OSM leisure=playground
  // is a precise upstream tag. Neither tells us the PRIMARY experience on its own (a contractor
  // also builds equipment inside large municipal parks), so it is recorded and used to break ties,
  // not to classify.
  const src = norm(activity.source_url);
  const srcHints = [];
  if (/openstreetmap\.org\/(node|way|relation)\//.test(src)) srcHints.push('source:osm-leisure-playground');
  if (/playground\.co\.il/.test(src)) srcHints.push('source:playground-equipment-vendor');
  if (/maps\.google\.com|google\.com\/maps/.test(src)) srcHints.push('source:google-places-scanner');

  // --- highly diagnostic NAME tokens (section 13: name alone only when the name itself carries
  // an unambiguous concept, and even then we record whether supporting evidence existed).
  //
  // ADDRESS GUARD: the settlement scanner names OSM playgrounds "גן שעשועים – <street>, <city>",
  // so the STREET can carry another concept's vocabulary. Found in production:
  // "גן שעשועים – דרך גן החיות, ירושלים" is a playground on Zoo Road, not a zoo. We therefore
  // read name diagnostics only from the part BEFORE the address separator, and never from a
  // street-prefixed fragment. This is the same class of error as "פארק" in a venue name.
  // Only the SCANNER convention hides an address after the dash. For an ordinary name the text
  // after it is real content and must stay available to the name diagnostics below - otherwise
  // "מדבריום - פארק החיות" loses the very half that identifies it as an animal destination.
  const nameHead = scannerNamed ? nameHeadRaw : nameOnly;
  const looksLikeStreet = /(^|\s)(דרך|רחוב|רח |שדרות|שד )/.test(nameOnly);
  const namePrefixedAsPlayground = scannerNamed;

  const nameIsLunaPark = /לונה\s?פארק|luna\s?park/.test(nameHead);
  const nameIsZoo = !namePrefixedAsPlayground && !looksLikeStreet
    && /גן\s?ה?חיות|ספארי|אקווריום|פארק\s?ה?חיות/.test(nameHead);
  const nameIsMuseum = !namePrefixedAsPlayground && /מוזיאון|מדעטק|פלנטריום/.test(nameHead);
  if (namePrefixedAsPlayground) {
    negativeEvidence.push('guard: name is scanner-generated "גן שעשועים – <street>, <city>" - the street portion is not evidence');
  }

  // --- PRIMARY EXPERIENCE precedence -----------------------------------------------------------
  // Animals first: an animal venue that also has rides/lawns/tickets is still an animal venue
  // (explicit product decision on מדבריום).
  if (nameIsZoo || ev.ANIMALS.strong.length >= 2 || (ev.ANIMALS.strong.length === 1 && nameIsZoo)) {
    proposed = 'חיות וגני חיות';
    evidence.push(...ev.ANIMALS.strong.map((t) => `animal:${t}`));
    if (nameIsZoo) evidence.push('animal:name');
    confidence = (nameIsZoo && ev.ANIMALS.strong.length >= 1) || ev.ANIMALS.strong.length >= 2 ? 'HIGH' : 'MEDIUM';
    reason = 'primary experience is animals/zoo/wildlife';
    if (ev.ATTRACTION_COMPLEX.strong.length) {
      negativeEvidence.push(`has ride terms (${ev.ATTRACTION_COMPLEX.strong.join(',')}) but animals dominate - ride terms do not override an animal primary experience`);
    }
  } else if (nameIsMuseum || ev.MUSEUM_SCIENCE.strong.length >= 2) {
    proposed = 'מוזיאון לילדים';
    evidence.push(...ev.MUSEUM_SCIENCE.strong.map((t) => `museum:${t}`));
    if (nameIsMuseum) evidence.push('museum:name');
    confidence = nameIsMuseum && ev.MUSEUM_SCIENCE.strong.length >= 1 ? 'HIGH' : 'MEDIUM';
    reason = 'primary experience is museum/science exhibition';
  } else if (nameIsLunaPark || ev.ATTRACTION_COMPLEX.strong.length >= 2) {
    proposed = 'מתחם אטרקציות';
    evidence.push(...ev.ATTRACTION_COMPLEX.strong.map((t) => `ride:${t}`));
    if (nameIsLunaPark) evidence.push('ride:name=לונה פארק');
    // HIGH needs a diagnostic name WITH support, or two independent ride signals.
    confidence = (nameIsLunaPark && (ev.ATTRACTION_COMPLEX.strong.length >= 1 || hasDescription))
      || ev.ATTRACTION_COMPLEX.strong.length >= 2 ? 'HIGH' : 'MEDIUM';
    reason = 'primary experience is rides / built entertainment installations';
  } else if (ev.WATER.strong.length >= 2) {
    proposed = 'פעילות מים';
    evidence.push(...ev.WATER.strong.map((t) => `water:${t}`));
    confidence = 'MEDIUM';
    reason = 'primary experience is water activity';
  } else if (ev.NATURE.strong.length >= 2 && ev.PARK.strong.length === 0) {
    proposed = 'טבע';
    evidence.push(...ev.NATURE.strong.map((t) => `nature:${t}`));
    confidence = 'MEDIUM';
    reason = 'primary experience is a nature site rather than a municipal park';
  } else if (ev.PARK.strong.length > 0 || ev.PLAYGROUND.strong.length > 0) {
    // The park-vs-playground call. A park that CONTAINS play equipment is still a park:
    // park-scale evidence (dunam / lawns / trails / picnic) outweighs equipment lists.
    const parkScore = ev.PARK.strong.length * 2 + ev.PARK.weak.length;
    const playScore = ev.PLAYGROUND.strong.length * 2 + ev.PLAYGROUND.weak.length;
    if (parkScore > playScore) {
      proposed = 'פארק';
      evidence.push(...ev.PARK.strong.map((t) => `park:${t}`));
      if (ev.PLAYGROUND.strong.length) {
        negativeEvidence.push(`also has play equipment (${ev.PLAYGROUND.strong.join(',')}) - a park may contain a playground and remain a park`);
      }
      confidence = ev.PARK.strong.length >= 2 ? 'HIGH' : 'MEDIUM';
      reason = 'park-scale evidence (open space / lawns / trails / picnic) dominates';
    } else if (playScore > parkScore) {
      proposed = 'גן שעשועים';
      evidence.push(...ev.PLAYGROUND.strong.map((t) => `play:${t}`));
      confidence = ev.PLAYGROUND.strong.length >= 2 ? 'HIGH' : 'MEDIUM';
      reason = 'primary experience is children playing on playground equipment';
    } else {
      // Balanced text evidence - provenance may break the tie, but only to MEDIUM, never HIGH.
      const osmOrVendor = srcHints.some((h) => h.includes('osm') || h.includes('vendor'));
      if (osmOrVendor) {
        proposed = 'גן שעשועים';
        evidence.push(...ev.PLAYGROUND.strong.map((t) => `play:${t}`), ...srcHints);
        confidence = 'MEDIUM';
        reason = 'park and playground text evidence are balanced; provenance points to playground';
      } else {
        proposed = null;
        confidence = 'LOW';
        reason = 'park and playground evidence are balanced - needs human judgement';
      }
    }
  } else {
    proposed = null;
    confidence = 'LOW';
    reason = hasDescription ? 'no diagnostic primary-experience evidence found' : 'no description recorded - insufficient evidence';
  }

  // Guard: never let a bare "פארק" in the name push anything to an attraction complex.
  if (proposed === 'מתחם אטרקציות' && !nameIsLunaPark && ev.ATTRACTION_COMPLEX.strong.length < 2) {
    proposed = null; confidence = 'LOW';
    reason = 'attraction-complex proposal withdrawn: name contains "פארק" but no ride evidence';
    negativeEvidence.push('guard: venue name alone is not evidence of an attraction complex');
  }
  // Guard: no description at all can never be HIGH.
  if (!hasDescription && confidence === 'HIGH' && !nameIsLunaPark && !nameIsZoo && !nameIsMuseum) {
    confidence = 'MEDIUM';
    negativeEvidence.push('downgraded: no description to corroborate');
  }

  if (srcHints.length && !evidence.some((e) => e.startsWith("source:"))) evidence.push(...srcHints);
  return { proposed, confidence, evidence, negativeEvidence, reason, signals: ev, sourceHints: srcHints };
}

// Records with an AUTHORITATIVE product decision (Phase D brief section 2). These are not
// classifier output - they are given, and they override the text evidence. Listed explicitly so
// the dry run never has to pretend it inferred them: מיני ישראל in particular is unreachable from
// its own text ("שלל אטרקציות" is guarded as non-evidence), and correctly scores LOW without this.
const PRODUCT_DECISIONS = [
  { match: /^פארק שרונה/, decided: 'פארק' },
  { match: /^מדבריום/, decided: 'חיות וגני חיות' },
  { match: /גן החיות ואקווריום/, decided: 'חיות וגני חיות' },
  { match: /^מיני ישראל$/, decided: 'מתחם אטרקציות' },
  { match: /^פארק ומוזיאון המדע$/, decided: 'PRIMARY_MUSEUM_SCIENCE_NOT_ATTRACTION' },
];
function productDecisionFor(name) {
  const hit = PRODUCT_DECISIONS.find((d) => d.match.test((name || '').trim()));
  return hit ? hit.decided : null;
}

function bucketFor(row) {
  if (!row.proposedCategory) return 'D';
  if (row.proposedCategory === row.currentCategory) return null; // already correct, not a candidate
  // Concepts that have no DB value yet cannot be auto-written, whatever the confidence.
  if (row.proposedCategory === 'חיות וגני חיות') return 'C';
  if (row.confidence === 'HIGH') return 'A';
  if (row.confidence === 'MEDIUM') return 'B';
  return 'D';
}

async function fetchAll(select, filter = '') {
  const rows = [];
  let off = 0;
  for (;;) {
    const url = `${SUPABASE_URL}/rest/v1/activities?select=${encodeURIComponent(select)}&status=eq.approved${filter}&order=id.asc&offset=${off}&limit=${PAGE}`;
    const res = await fetch(url, { headers: { apikey: ANON } });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const page = await res.json();
    rows.push(...page);
    if (page.length < PAGE) break;
    off += PAGE;
  }
  return rows;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const SELECT = 'id,name,description,category,entity_type,source,source_url,created_at,placeholder_group,locations(city,region,lat,lng)';
  console.log('Fetching approved catalogue (READ-ONLY)...');
  const raw = await fetchAll(SELECT);
  console.log(`Fetched ${raw.length} approved activities.\n`);

  const acts = raw.map((r) => ({
    id: r.id, name: r.name, description: r.description, category: r.category,
    entity_type: r.entity_type, source: r.source, source_url: r.source_url,
    created_at: r.created_at, placeholder_group: r.placeholder_group,
    city: r.locations?.city || null, region: r.locations?.region || null,
    lat: r.locations?.lat ?? null, lng: r.locations?.lng ?? null,
  }));

  // --- A. counts by category ------------------------------------------------------------------
  const byCategory = {};
  for (const a of acts) byCategory[a.category || '(null)'] = (byCategory[a.category || '(null)'] || 0) + 1;

  // --- non-canonical values --------------------------------------------------------------------
  const canonical = new Set(categoryValues.categories);
  const nonCanonical = {};
  for (const a of acts) {
    if (a.category && !canonical.has(a.category)) {
      (nonCanonical[a.category] ||= []).push({ id: a.id, name: a.name, city: a.city, source: a.source, source_url: a.source_url, created_at: a.created_at });
    }
  }

  // --- classify the focus populations -----------------------------------------------------------
  const FOCUS = ['פארק', 'פארק שעשועים', 'אטרקציה'];
  const candidates = [];
  const auditRows = {};
  for (const cat of FOCUS) {
    auditRows[cat] = acts.filter((a) => a.category === cat).map((a) => {
      const c = classify(a);
      const row = {
        activityId: a.id, name: a.name, city: a.city, currentCategory: a.category,
        proposedCategory: c.proposed, confidence: c.confidence, reason: c.reason,
        evidence: c.evidence, negativeEvidence: c.negativeEvidence,
        source: a.source, sourceUrl: a.source_url, createdAt: a.created_at,
        descriptionExcerpt: (a.description || '').slice(0, 180),
      };
      const decided = productDecisionFor(a.name);
      if (decided) {
        row.productDecision = decided;
        row.evidence = [...(row.evidence || []), 'product-decision:Phase-D-brief-section-2'];
        row.proposedCategory = decided === 'PRIMARY_MUSEUM_SCIENCE_NOT_ATTRACTION' ? (c.proposed || null) : decided;
        row.confidence = 'HIGH';
        row.reason = `authoritative product decision (Phase D brief) - ${c.proposed ? `classifier independently proposed ${c.proposed}` : 'not inferable from text evidence alone'}`;
      }
      row.bucket = bucketFor(row);
      return row;
    });
    candidates.push(...auditRows[cat].filter((r) => r.bucket));
  }

  // --- playground population: full-population heuristics + stratification -----------------------
  const playgrounds = acts.filter((a) => a.category === 'גן שעשועים');
  const OSM_RE = /openstreetmap\.org\/(node|way|relation)\//i;
  const GOOGLE_RE = /maps\.google\.com|google\.com\/maps/i;
  const strata = { osmNoDescription: [], osmWithDescription: [], googleScanner: [], otherSource: [] };
  for (const p of playgrounds) {
    const hasDesc = !!(p.description && p.description.trim().length > 15);
    if (OSM_RE.test(p.source_url || '')) (hasDesc ? strata.osmWithDescription : strata.osmNoDescription).push(p);
    else if (GOOGLE_RE.test(p.source_url || '')) strata.googleScanner.push(p);
    else strata.otherSource.push(p);
  }
  // Deterministic heuristics across the FULL playground population.
  const playgroundSuspects = { likelyPark: [], likelyAttraction: [], likelyAnimals: [], likelyMuseum: [], noEvidence: 0, confirmedPlayground: 0 };
  for (const p of playgrounds) {
    const c = classify(p);
    if (!c.proposed) { playgroundSuspects.noEvidence += 1; continue; }
    if (c.proposed === 'גן שעשועים') { playgroundSuspects.confirmedPlayground += 1; continue; }
    const entry = {
      activityId: p.id, name: p.name, city: p.city, currentCategory: p.category,
      proposedCategory: c.proposed, confidence: c.confidence, reason: c.reason,
      evidence: c.evidence, negativeEvidence: c.negativeEvidence,
      source: p.source, sourceUrl: p.source_url, createdAt: p.created_at,
      descriptionExcerpt: (p.description || '').slice(0, 180),
    };
    entry.bucket = bucketFor(entry);
    if (c.proposed === 'פארק') playgroundSuspects.likelyPark.push(entry);
    else if (c.proposed === 'מתחם אטרקציות') playgroundSuspects.likelyAttraction.push(entry);
    else if (c.proposed === 'חיות וגני חיות') playgroundSuspects.likelyAnimals.push(entry);
    else if (c.proposed === 'מוזיאון לילדים') playgroundSuspects.likelyMuseum.push(entry);
    if (entry.bucket) candidates.push(entry);
  }

  // Deterministic sample per stratum (first N by id order = reproducible, not random).
  const sampleOf = (arr, n) => arr.slice(0, n).map((p) => {
    const c = classify(p);
    return { activityId: p.id, name: p.name, city: p.city, hasDescription: !!(p.description || '').trim(), proposedCategory: c.proposed, confidence: c.confidence, reason: c.reason };
  });
  const playgroundSample = {
    osmNoDescription: sampleOf(strata.osmNoDescription, 12),
    osmWithDescription: sampleOf(strata.osmWithDescription, 12),
    googleScanner: sampleOf(strata.googleScanner, 12),
    otherSource: sampleOf(strata.otherSource, 12),
  };

  // --- animal-related categories -----------------------------------------------------------------
  const ANIMAL_CATS = ['בעלי חיים', 'פינת חי', 'חווה', 'גן חיות'];
  const animalAudit = {};
  for (const cat of ANIMAL_CATS) {
    animalAudit[cat] = acts.filter((a) => a.category === cat).map((a) => ({
      activityId: a.id, name: a.name, city: a.city, source: a.source,
      descriptionExcerpt: (a.description || '').slice(0, 150),
      signals: countSignals([a.name, a.description].filter(Boolean).join(' . '), SIGNALS.ANIMALS).strong,
    }));
  }
  // Records anywhere in the catalogue whose primary experience looks like animals.
  const animalCandidatesElsewhere = acts
    .filter((a) => !ANIMAL_CATS.includes(a.category))
    .map((a) => ({ a, c: classify(a) }))
    .filter((x) => x.c.proposed === 'חיות וגני חיות')
    .map((x) => ({ activityId: x.a.id, name: x.a.name, city: x.a.city, currentCategory: x.a.category, confidence: x.c.confidence, evidence: x.c.evidence }));

  // --- Midbarium duplicate ------------------------------------------------------------------------
  const midbarium = acts.filter((a) => /מדבריום/.test(a.name || ''));

  // --- scanner bulk-classification impact ----------------------------------------------------------
  const scannerImpact = {
    totalPlaygrounds: playgrounds.length,
    osmSourced: strata.osmNoDescription.length + strata.osmWithDescription.length,
    googleScannerSourced: strata.googleScanner.length,
    otherSourced: strata.otherSource.length,
    withoutAnyDescription: playgrounds.filter((p) => !(p.description || '').trim()).length,
  };

  const artifact = {
    generatedAt: new Date().toISOString(),
    stamp: STAMP,
    commit: '29cacf4',
    mode: 'READ-ONLY DRY RUN - no production writes performed',
    governingPrinciple: 'PRIMARY EXPERIENCE',
    falsePositiveGuards: FALSE_POSITIVE_GUARDS,
    semanticConceptsUsed: Object.keys(semantics.concepts).concat(['חיות וגני חיות (approved, no DB value yet)']),
    totals: { approvedActivities: acts.length, byCategory },
    nonCanonicalCategoryValues: nonCanonical,
    audits: {
      'פארק': auditRows['פארק'],
      'פארק שעשועים': auditRows['פארק שעשועים'],
      'אטרקציה': auditRows['אטרקציה'],
    },
    playgroundPopulation: {
      total: playgrounds.length,
      strata: {
        osmNoDescription: strata.osmNoDescription.length,
        osmWithDescription: strata.osmWithDescription.length,
        googleScanner: strata.googleScanner.length,
        otherSource: strata.otherSource.length,
      },
      fullPopulationHeuristics: {
        confirmedPlayground: playgroundSuspects.confirmedPlayground,
        noEvidence: playgroundSuspects.noEvidence,
        likelyPark: playgroundSuspects.likelyPark.length,
        likelyAttraction: playgroundSuspects.likelyAttraction.length,
        likelyAnimals: playgroundSuspects.likelyAnimals.length,
        likelyMuseum: playgroundSuspects.likelyMuseum.length,
      },
      suspects: playgroundSuspects,
      deterministicSample: playgroundSample,
    },
    animalCategories: { existing: animalAudit, candidatesElsewhere: animalCandidatesElsewhere },
    midbariumDuplicate: midbarium,
    scannerImpact,
    candidates,
    bucketCounts: candidates.reduce((acc, c) => { acc[c.bucket] = (acc[c.bucket] || 0) + 1; return acc; }, {}),
  };

  const jsonPath = path.join(OUT_DIR, `category-reclassification-dry-run-${STAMP}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(artifact, null, 2));
  console.log(`Dry-run artifact written: ${jsonPath}`);
  console.log(`\nBucket counts: ${JSON.stringify(artifact.bucketCounts)}`);
  console.log(`Candidates: ${candidates.length}`);
  return artifact;
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
module.exports = { classify, SIGNALS, FALSE_POSITIVE_GUARDS };
