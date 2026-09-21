// TuRu - Node/CommonJS twin of sanitizeCategory() in
// supabase/functions/_shared/extraction.ts (Deno). Same deliberate-duplication arrangement as
// playgroundNaming.js / placeholderGroup.js: two runtimes cannot share one module, so the pair
// must be changed together. Behaviour is asserted identical by
// tests/categoryValidation.test.js (root) and tools/import-tool/tests/categoryValidation.test.js.
//
// WHY THIS EXISTS (Phase E, 2026-09-21): the Phase D catalogue audit found two non-canonical
// category values in production - 'גן חיות' and 'חדשנות בחקלאות' - both written by the import
// tool's own AI extraction path. CATEGORY_VALUES was handed to the model in the prompt but the
// model's ANSWER was never checked against it. supabase/functions/scan-source guarded itself
// (inList(raw.category, CATEGORY_VALUES)); tools/import-tool/server.js did not, so any string the
// model invented went straight into activities.category. There is no DB constraint behind it either.
const categoryValues = require('../../../constants/categoryValues.json');
const categorySemantics = require('../../../constants/categorySemantics.json');

const CANONICAL_SET = new Set(categoryValues.categories);
const ALIAS_TO_CANONICAL = new Map();
for (const concept of Object.values(categorySemantics.concepts)) {
  for (const alias of concept.aliases || []) {
    ALIAS_TO_CANONICAL.set(String(alias).trim().toLowerCase(), concept.dbValue);
  }
}

// Returns { category, normalizedFrom, rejected, reason }.
//   canonical value      -> accepted as-is
//   known explicit alias -> normalized to the canonical value (deterministic, from
//                           categorySemantics.json only - never a guess)
//   anything else        -> rejected to null + reason, for review. Never silently mapped to 'אחר':
//                           'אחר' is a legitimate category a model may choose on purpose, so using
//                           it as a dumping ground would hide exactly the corruption being fixed.
function sanitizeCategory(raw) {
  if (raw === null || raw === undefined || raw === '') {
    return { category: null, normalizedFrom: null, rejected: false, reason: null };
  }
  if (typeof raw !== 'string') {
    return { category: null, normalizedFrom: null, rejected: true, reason: 'category_not_a_string' };
  }
  const trimmed = raw.trim();
  if (!trimmed) return { category: null, normalizedFrom: null, rejected: false, reason: null };
  if (CANONICAL_SET.has(trimmed)) {
    return { category: trimmed, normalizedFrom: null, rejected: false, reason: null };
  }
  const aliased = ALIAS_TO_CANONICAL.get(trimmed.toLowerCase());
  if (aliased && CANONICAL_SET.has(aliased)) {
    return { category: aliased, normalizedFrom: trimmed, rejected: false, reason: 'normalized_from_alias' };
  }
  return { category: null, normalizedFrom: null, rejected: true, reason: `non_canonical_category:${trimmed}` };
}

module.exports = { sanitizeCategory, CANONICAL_SET };
