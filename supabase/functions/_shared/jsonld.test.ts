import { assertEquals } from 'jsr:@std/assert@1';
import { applyJsonLdToCandidate, isMultiVenueListing, isSinglePlace, parseJsonLdEvents } from './jsonld.ts';

Deno.test('touring-show listings (22 cities in streetAddress/addressLocality) never fill a location', () => {
  const list = 'איירפורט סיטי, חולון, רמלה, קיבוץ גן שמואל, קרית מוצקין, טבריה, פתח תקווה, הרצליה';
  const events = parseJsonLdEvents([JSON.stringify({ '@type': 'Event', name: 'תיבת נח - מחזמר', startDate: '2026-07-27', location: { '@type': 'Place', name: list, address: { '@type': 'PostalAddress', streetAddress: list, addressLocality: list } } })]);
  assertEquals(isMultiVenueListing(events[0]), true);
  assertEquals(isSinglePlace('היכל התרבות, חולון'), true);
  assertEquals(isSinglePlace(list), false);
  const c: Record<string, unknown> = { name: 'תיבת נח - מחזמר לכל המשפחה', schedule_type: 'one_time', location_name: null, city: null, address: null };
  assertEquals(applyJsonLdToCandidate(c, events), ['one_time_date']);
  assertEquals(c.location_name, null); assertEquals(c.city, null); assertEquals(c.jsonld_multi_venue, true);
});

const block = JSON.stringify({ '@context': 'https://schema.org', '@graph': [{ '@type': 'TheaterEvent', name: 'שעת סיפור בספרייה', startDate: '2026-09-20T17:00', location: { '@type': 'Place', name: 'ספריית בן יהודה', address: { '@type': 'PostalAddress', streetAddress: 'בן יהודה 12', addressLocality: 'חולון' }, geo: { '@type': 'GeoCoordinates', latitude: 32.01, longitude: 34.77 } } }, { '@type': 'Event', name: 'מופע בפריז', location: { '@type': 'Place', name: 'Paris', geo: { latitude: 48.85, longitude: 2.35 } } }] });

Deno.test('parseJsonLdEvents: Event/TheaterEvent with PostalAddress + geo; out-of-Israel geo dropped; malformed blocks ignored', () => {
  const events = parseJsonLdEvents([block, '{not json']);
  assertEquals(events.length, 2);
  assertEquals(events[0].location?.street, 'בן יהודה 12');
  assertEquals(events[0].location?.city, 'חולון');
  assertEquals(events[0].location?.lat, 32.01);
  assertEquals(events[1].location?.lat, null);
});

Deno.test('applyJsonLdToCandidate: fill-null only (extractor values win), name-matched event, date/time for one_time', () => {
  const events = parseJsonLdEvents([block]);
  const c: Record<string, unknown> = { name: 'שעת סיפור בספרייה העירונית', schedule_type: 'one_time', one_time_date: null, city: 'חולון', location_name: null, address: null, lat: null, lng: null, start_time: null };
  const filled = applyJsonLdToCandidate(c, events);
  assertEquals(filled, ['address', 'location_name', 'geo', 'one_time_date', 'start_time']);
  assertEquals(c.address, 'בן יהודה 12'); assertEquals(c.location_name, 'ספריית בן יהודה'); assertEquals(c.city, 'חולון'); assertEquals(c.lat, 32.01); assertEquals(c.one_time_date, '2026-09-20'); assertEquals(c.start_time, '17:00');
  const keep: Record<string, unknown> = { name: 'שעת סיפור בספרייה', schedule_type: 'recurring', address: 'רחוב אחר 3', location_name: 'מקום אחר', city: 'x', lat: 1, lng: 1 };
  assertEquals(applyJsonLdToCandidate(keep, events), []);
  assertEquals(keep.address, 'רחוב אחר 3');
  assertEquals(applyJsonLdToCandidate({ name: 'אירוע שלא קיים' }, events), [], 'two events, none matching the name -> nothing');
});
