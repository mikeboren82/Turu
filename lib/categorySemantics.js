// TuRu - deterministic semantic layer over the flat category strings (Phase A+B+C, 2026-09-21).
//
// Why this exists: before this, the ONLY thing that turned "לונה פארק" into a category was the
// LLM in supabase/functions/smart-search, constrained afterwards only by validateCategoryEvidence
// (which checks the evidence is quoted from the query - not that it is semantically right). There
// was no alias table and no plural handling at all, so "פארקי שעשועים" reached exactly 1 record
// while "פארק שעשועים" reached 10, and the codebase elsewhere asserted outright that
// 'פארק שעשועים' and 'גן שעשועים' are the same concept. See constants/categorySemantics.json.
//
// Deliberately small: exact normalized-phrase matching over a hand-written alias list, longest
// phrase first. No stemmer, no morphology engine, no fuzzy matching - Hebrew morphology done
// badly is worse than not done at all, and every alias here is a product decision, not a guess.
// Adding a concept or an alias is a one-line edit to the JSON.
import semantics from '../constants/categorySemantics.json';
import { normalizeSearchText } from './searchIntent';

export const CONCEPTS = semantics.concepts;

// dbValue -> concept key. The stored value is the join between this layer and everything that
// already exists (activities.category, filters.category, CATEGORY_OPTIONS).
const BY_DB_VALUE = new Map(Object.entries(CONCEPTS).map(([key, c]) => [c.dbValue, key]));

export function conceptForDbValue(dbValue) {
  return BY_DB_VALUE.get(dbValue) || null;
}

export function conceptDbValue(conceptKey) {
  return CONCEPTS[conceptKey]?.dbValue || null;
}

// Every alias of every concept, normalized, sorted LONGEST FIRST. The ordering is the whole
// disambiguation mechanism: "פארק שעשועים" must resolve to ATTRACTION_COMPLEX, never to PARK via
// its shorter "פארק" alias, and "גן שעשועים" must resolve to PLAYGROUND rather than matching
// "שעשועים" inside some other concept's alias.
const ALIAS_INDEX = Object.entries(CONCEPTS)
  .flatMap(([key, c]) => (c.aliases || []).map((alias) => ({ key, alias: normalizeSearchText(alias) })))
  .filter((entry) => entry.alias.length > 0)
  .sort((a, b) => b.alias.length - a.alias.length);

// Word-ish boundary check for a phrase inside a haystack. Hebrew has no casing and the usual \b
// does not behave for Hebrew letters, so boundaries are "start/end of string, whitespace, or
// punctuation" - plus the optional single-letter Hebrew prefixes (ב/ל/מ/ה/ו/ש/כ) that attach
// directly to a noun ("בלונה פארק", "והפארק"). Same convention as isQuotedFrom in the Edge
// Function's smartSearchIntent.ts, kept consistent on purpose.
const PUNCT = '\\s,.;:!?()\\[\\]{}"\'\\-–—/|';
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function phraseRegExp(phrase) {
  return new RegExp(`(?:^|[${PUNCT}])[והבלמכש]{0,2}${escapeRegExp(phrase)}(?=$|[${PUNCT}])`, 'u');
}

export function textContainsPhrase(text, phrase) {
  const hay = normalizeSearchText(text);
  const needle = normalizeSearchText(phrase);
  if (!hay || !needle) return false;
  return phraseRegExp(needle).test(hay);
}

// The query's category intent, or null. Returns the FIRST (= longest) alias that appears in the
// query as a whole phrase, so "לונה פארק בנתניה" resolves on "לונה פארק" and leaves "בנתניה" for
// the geographic parser, and "פארק בנתניה" resolves to PARK. Composition with location/time
// intent is therefore automatic - this never consumes the rest of the query.
export function resolveCategoryIntent(query) {
  const normalized = normalizeSearchText(query);
  if (!normalized) return null;
  for (const { key, alias } of ALIAS_INDEX) {
    if (phraseRegExp(alias).test(normalized)) {
      return { concept: key, dbValue: CONCEPTS[key].dbValue, matchedAlias: alias };
    }
  }
  return null;
}

// The alias phrases that count as TEXT evidence for a concept, used as the soft recall channel in
// lib/filterActivities.js (see matchesCategoryIntent there). Measured against the live catalogue:
// token-AND matching of "פארק שעשועים" reaches 170 records (mostly playgrounds that merely contain
// both words), whereas these contiguous phrases reach 17 - which is the difference between
// "semantic recall" and "swamping category precision".
// Uses recallAliases when the concept declares it - the subset specific enough to be evidence
// ABOUT a record, which is narrower than what a user may reasonably TYPE. PARK declares [] on
// purpose: "פארק" is a perfectly good query word but a terrible conclusion, since plenty of venue
// names contain it without being public parks ("גרביטי פארק" is an attraction complex). Measured:
// letting the bare word recall took "פארק" from 23 stored matches to 244.
export function aliasPhrasesForConcept(conceptKey) {
  const concept = CONCEPTS[conceptKey];
  if (!concept) return [];
  const source = concept.recallAliases ?? concept.aliases ?? [];
  return source.map(normalizeSearchText).filter(Boolean);
}

export function aliasPhrasesForDbValue(dbValue) {
  const key = conceptForDbValue(dbValue);
  return key ? aliasPhrasesForConcept(key) : [];
}

// Does this activity's own text carry one of the concept's alias phrases? Text evidence only -
// never consulted for an activity whose stored category already matches (that is the strong path).
export function activityMatchesAliasPhrase(activity, phrases) {
  if (!phrases || phrases.length === 0) return false;
  const haystack = normalizeSearchText(
    [activity.title, activity.description, activity.category, activity.locationName].filter(Boolean).join(' '),
  );
  if (!haystack) return false;
  return phrases.some((p) => phraseRegExp(p).test(haystack));
}
