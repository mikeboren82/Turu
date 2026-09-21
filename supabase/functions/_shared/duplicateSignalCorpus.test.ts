// TuRu - DRIFT PROTECTION for coordinateDuplicateSignal. The Deno original runs the SAME shared
// fixture file the Node port runs (tools/import-tool/tests/duplicateCandidates.test.js). If either
// implementation changes behaviour, its own suite fails against tests/fixtures/duplicateSignalCorpus.json.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { coordinateDuplicateSignal, PLACE_ENTITY_TYPE } from "./placesDiscovery.ts";
import { ENTITY_TYPE_VALUES } from "./extraction.ts";

const corpusPath = new URL("../../../tests/fixtures/duplicateSignalCorpus.json", import.meta.url);
const corpus = JSON.parse(await Deno.readTextFile(corpusPath));

Deno.test("DRIFT CORPUS: every shared fixture case passes on the Deno original", () => {
  for (const c of corpus.cases) {
    const s = coordinateDuplicateSignal(c.a, c.b);
    assertEquals(s.isCandidate, c.expect.isCandidate, c.id + " isCandidate");
    assertEquals(s.relationship, c.expect.relationship, c.id + " relationship");
    const kinds = [...new Set(s.identityEvidence.map((e: string) => e.split(":")[0]))].sort();
    assertEquals(kinds, [...c.expect.identityKinds].sort(), c.id + " identity kinds");
  }
});

Deno.test("PLACE_ENTITY_TYPE is a declared entity type", () => {
  assertEquals(ENTITY_TYPE_VALUES.includes(PLACE_ENTITY_TYPE), true);
});
