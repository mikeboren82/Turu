// TuRu - smart-search intent contract (2026-09-18): inferred category must be backed by evidence quoted
// from the query and must not be the subject of a named title; residual_query must be quoted verbatim.
// Model outputs below are REAL (captured from claude-haiku-4-5 at temperature 0, deployed prompt and
// updated prompt). Run with `npx deno test --node-modules-dir=none supabase/functions/_shared/`.

import { assertEquals, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { buildSystemPrompt, isQuotedFrom, sanitizeIntent, validateCategoryEvidence } from './smartSearchIntent.ts';

const blankRaw = { location: {} };

Deno.test('regression: the deployed model output "זהבה ליד חיפה" → בעלי חיים is rejected (no evidence)', () => {
  // exact output of the currently deployed prompt: category with no category_evidence field at all
  const s = sanitizeIntent({ ...blankRaw, category: 'בעלי חיים', location: { city: 'חיפה' } }, 'זהבה ליד חיפה');
  assertEquals(s.category, null);
  assertEquals(s.categoryRejectedReason, 'no-evidence');
  assertEquals(s.location.city, 'חיפה', 'the location is untouched');
});

Deno.test('evidence that is not quoted from the query is rejected (associative guess)', () => {
  const s = sanitizeIntent({ ...blankRaw, category: 'בעלי חיים', category_evidence: 'דובים' }, 'זהבה ליד חיפה');
  assertEquals(s.category, null);
  assertEquals(s.categoryRejectedReason, 'evidence-not-in-query');
});

Deno.test('evidence that sits inside the named text is the title subject, not a requested activity type', () => {
  const s = sanitizeIntent(
    { ...blankRaw, category: 'בעלי חיים', category_evidence: 'הכבש', residual_query: 'הכבש השישה עשר' },
    'הכבש השישה עשר',
  );
  assertEquals(s.category, null);
  assertEquals(s.categoryRejectedReason, 'evidence-inside-residual');
  assertEquals(s.residualQuery, 'הכבש השישה עשר', 'the text itself is preserved');
});

Deno.test('legitimate activity-type inference is kept, including synonyms/subtypes (real outputs)', () => {
  const cases: [string, string, string][] = [
    ['קטיף ליד חדרה', 'חווה', 'קטיף'],
    ['חיות ליד נתניה', 'בעלי חיים', 'חיות'],
    ['מוזיאון בירושלים', 'מוזיאון לילדים', 'מוזיאון'],
    ["ג'ימבורי בנתניה", "ג'ימבורי", "ג'ימבורי"],
    ['משחקייה רעננה', 'משחקייה', 'משחקייה'],
  ];
  for (const [query, category, evidence] of cases) {
    const s = sanitizeIntent({ ...blankRaw, category, category_evidence: evidence }, query);
    assertEquals(s.category, category, query);
    assertEquals(s.categoryRejectedReason, null, query);
  }
});

Deno.test('evidence with an attached Hebrew prefix still counts as quoted ("במופע")', () => {
  assert(isQuotedFrom('מופע', 'יש במופע קוסמים'));
  assert(!isQuotedFrom('מופע', 'מופעים'), 'a longer word is not a quote of a shorter one');
});

Deno.test('a type word that is also a separate residual is kept when they do not overlap ("מופע X")', () => {
  const s = sanitizeIntent(
    { ...blankRaw, category: 'הצגה', category_evidence: 'מופע', residual_query: 'הקוסם מארץ עוץ' },
    'מופע הקוסם מארץ עוץ',
  );
  assertEquals(s.category, 'הצגה');
  assertEquals(s.residualQuery, 'הקוסם מארץ עוץ');
});

Deno.test('residual_query: invented, malformed or missing values never leave the server', () => {
  assertEquals(sanitizeIntent({ ...blankRaw, residual_query: 'עם מתקני מים' }, 'פעילויות בחיפה').residualQuery, null);
  assertEquals(sanitizeIntent({ ...blankRaw, residual_query: 42 }, 'זהבה').residualQuery, null);
  assertEquals(sanitizeIntent({ ...blankRaw, residual_query: '   ' }, 'זהבה').residualQuery, null);
  assertEquals(sanitizeIntent({ ...blankRaw }, 'זהבה').residualQuery, null);
  assertEquals(sanitizeIntent({ ...blankRaw, residual_query: 'פיטר פן' }, 'פיטר פן ליד נתניה').residualQuery, 'פיטר פן');
});

Deno.test('a category outside the canonical vocabulary is dropped before evidence is even considered', () => {
  const s = sanitizeIntent({ ...blankRaw, category: 'קרקס', category_evidence: 'קרקס' }, 'קרקס בחיפה');
  assertEquals(s.category, null);
  assertEquals(s.categoryRejectedReason, null);
});

Deno.test('no category → no evidence bookkeeping', () => {
  assertEquals(validateCategoryEvidence(null, 'x', null, 'x'), { category: null, categoryEvidence: null, categoryRejectedReason: null });
});

Deno.test('prompt: contract fields present, and no evaluation-matrix query is used as a prompt example', () => {
  const prompt = buildSystemPrompt('2026-09-18', 'שישי');
  assert(prompt.includes('category_evidence'));
  assert(prompt.includes('residual_query'));
  // Using test queries as few-shot examples makes any evaluation self-fulfilling (this happened once).
  for (const q of ['זהבה', 'שלושת הדובים', 'פיטר פן', 'קרקס', 'קטיף', 'הכבש השישה עשר', 'ספר הג', 'חיות ליד']) {
    assert(!prompt.includes(q), `prompt must not contain the evaluation query "${q}"`);
  }
});
