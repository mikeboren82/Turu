// SERVICE AREA (Deno twin): geographic rule only; Israeli Arab localities in scope, PA localities outside,
// border cases ambiguous, no verdict without valid coordinates.
import { assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { classifyServiceArea, nearestPaLocality } from "./serviceArea.ts";

const SETTLEMENTS = [
  { city: 'אום אל פחם', lat: 32.519, lng: 35.153 }, { city: 'נצרת', lat: 32.702, lng: 35.297 }, { city: 'רהט', lat: 31.393, lng: 34.754 },
  { city: 'אבו גוש', lat: 31.8067, lng: 35.1078 }, { city: 'אריאל', lat: 32.1039, lng: 35.1868 }, { city: 'בית אל', lat: 31.9426, lng: 35.2229 },
  { city: 'ירושלים', lat: 31.7834, lng: 35.2198 }, { city: 'נתיב העשרה', lat: 31.55, lng: 34.53 }, { city: 'קרית ארבע', lat: 31.527, lng: 35.112 },
];

Deno.test('service area: Israeli Arab localities and West Bank / envelope settlements are IN_SCOPE', () => {
  for (const [lat, lng] of [[32.519, 35.153], [32.702, 35.297], [31.393, 34.754], [31.808, 35.106], [32.1039, 35.1868], [31.9426, 35.2229], [31.55, 34.53]]) assertEquals(classifyServiceArea(lat, lng, SETTLEMENTS).klass, 'IN_SCOPE');
});
Deno.test('service area: PA cities / camps / Gaza are OUTSIDE; a PA point with a CBS settlement 2-4 km away is AMBIGUOUS; no data -> DATA_ERROR', () => {
  for (const [lat, lng] of [[31.909, 35.197], [31.52, 34.452], [31.705, 35.202], [32.462, 35.284]]) assertEquals(classifyServiceArea(lat, lng, SETTLEMENTS).klass, 'OUTSIDE_SERVICE_AREA');
  assertEquals(classifyServiceArea(31.524, 35.098, SETTLEMENTS).klass, 'AMBIGUOUS'); // Hebron / Kiryat Arba
  assertEquals(classifyServiceArea(31.535, 35.101, SETTLEMENTS).klass, 'AMBIGUOUS');
  assertEquals(classifyServiceArea(null, null, SETTLEMENTS).klass, 'DATA_ERROR');
  assertEquals(classifyServiceArea(0, 0, SETTLEMENTS).klass, 'DATA_ERROR');
  assertNotEquals(nearestPaLocality(31.909, 35.197), null);
});
Deno.test('service area: without any settlement knowledge nothing outside a PA locality is ever excluded (default in scope)', () => {
  assertEquals(classifyServiceArea(32.0, 35.4, []).klass, 'IN_SCOPE');
  assertEquals(classifyServiceArea(32.08, 34.78, []).klass, 'IN_SCOPE');
});

Deno.test('service area SAFETY: a record naming a CBS settlement within 8 km is never auto-excluded (Jerusalem next to Anata -> AMBIGUOUS); a far hint does not help', () => {
  const anata = nearestPaLocality(31.8115, 35.2620); // Anata's centre
  assertEquals(anata?.name, 'Anata');
  const pt: [number, number] = [31.8115, 35.2735]; // ~1 km east of Anata, ~6 km from Jerusalem's CBS point
  assertEquals(classifyServiceArea(pt[0], pt[1], SETTLEMENTS).klass, 'OUTSIDE_SERVICE_AREA');
  assertEquals(classifyServiceArea(pt[0], pt[1], SETTLEMENTS, 'ירושלים').klass, 'AMBIGUOUS');
  assertEquals(classifyServiceArea(31.5017, 34.4668, SETTLEMENTS, 'ירושלים').klass, 'OUTSIDE_SERVICE_AREA');
});
