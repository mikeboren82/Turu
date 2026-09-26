// R12 (Phase 1 ledger Z-A, 2026-09-26): automatic venue learning matches existing venues BEFORE it creates one.
// Every automatic creator goes through venueLearning.createVenueWithAlias -> lib/venueMatch.matchExistingVenue.
// Pure - an in-memory fake of the venues / venue_aliases reads the ladder issues; no DB, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { normalizeVenueAlias, resolveVenue } = require('../venueNaming');
const { normalizeCityName } = require('../cityNaming');
const { createVenueWithAlias } = require('../venueLearning');
const { matchExistingVenue, decideVenueMatch, isGenericVenueName } = require('../lib/venueMatch');

function fakeDb({ venues = [], aliases = [], failVenueReads = false } = {}) {
  const db = {
    venues: venues.map((v) => ({ is_active: true, merged_into: null, google_place_id: null, lat: null, lng: null, ...v, city: normalizeCityName(v.city || null) })),
    aliases: aliases.map(([alias, venue_id]) => ({ alias, alias_normalized: normalizeVenueAlias(alias), venue_id })),
    inserts: [], aliasWrites: [], seq: 0,
  };
  const clone = (r) => (r ? { ...r } : r);
  class Q {
    constructor(t) { this.t = t; this.f = []; this.op = 'select'; this.sel = '*'; this.mode = 'many'; }
    select(s) { if (this.op === 'select') this.sel = s || '*'; return this; }
    insert(row) { this.op = 'insert'; this.row = row; return this; }
    upsert(row) { this.op = 'upsert'; this.row = row; return this; }
    eq(c, v) { this.f.push((r) => r[c] === v); return this; }
    is(c, v) { this.f.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
    in(c, vs) { this.f.push((r) => vs.includes(r[c])); return this; }
    gte(c, v) { this.f.push((r) => r[c] != null && r[c] >= v); return this; }
    lte(c, v) { this.f.push((r) => r[c] != null && r[c] <= v); return this; }
    maybeSingle() { this.mode = 'maybe'; return this; }
    single() { this.mode = 'single'; return this; }
    then(res, rej) { return Promise.resolve().then(() => this.exec()).then(res, rej); }
    exec() {
      const match = (r) => this.f.every((fn) => fn(r));
      if (this.t === 'venue_aliases' && this.op === 'select') {
        let data = db.aliases.filter(match);
        if (this.sel.includes('venue:venues')) data = data.map((a) => ({ alias_normalized: a.alias_normalized, venue: clone(db.venues.find((v) => v.id === a.venue_id)) })).filter((r) => r.venue);
        return { data, error: null };
      }
      if (this.t === 'venue_aliases' && this.op === 'upsert') {
        for (const r of [].concat(this.row)) {
          db.aliasWrites.push(r);
          if (!db.aliases.some((a) => a.alias_normalized === r.alias_normalized && a.venue_id === r.venue_id)) db.aliases.push({ ...r });
        }
        return { data: null, error: null };
      }
      if (this.t === 'venues' && this.op === 'select') {
        if (failVenueReads) return { data: null, error: { message: 'canceling statement due to statement timeout' } };
        const data = db.venues.filter(match).map(clone);
        return this.mode === 'many' ? { data, error: null } : { data: data[0] || null, error: null };
      }
      if (this.t === 'venues' && this.op === 'insert') {
        const v = { id: `new-${++db.seq}`, is_active: true, merged_into: null, google_place_id: null, ...this.row };
        db.venues.push(v); db.inserts.push(v);
        return { data: clone(v), error: null };
      }
      throw new Error(`fake: ${this.op} on ${this.t}`);
    }
  }
  db.client = { from: (t) => new Q(t) };
  return db;
}

// Jerusalem Biblical Zoo (ledger Z-A): seeded keeper e254dab3 and its 4 seeded aliases; Israel Aquarium 1.15 km away
const ZOO = { id: 'e254dab3', name_he: 'גן החיות התנ״כי', venue_type: 'attraction', city: 'ירושלים', lat: 31.7448338, lng: 35.1781123 };
const ZOO_ALIASES = ['גן החיות התנ״כי', 'הגן הזואולוגי התנכי', 'גן החיות התנ״כי ואקווריום ישראל', 'גן החיות התנ"כי ירושלים'].map((a) => [a, ZOO.id]);
const AQUARIUM = { id: '42b4758b', name_he: 'אקווריום ישראל', venue_type: 'attraction', city: 'ירושלים', lat: 31.744884, lng: 35.1658507 };
const LEARNED = { label: 'גן החיות התנ״כי בירושלים', city: 'ירושלים', lat: 31.7461139, lng: 35.1766343 }; // 287600a2's label + coords
const learn = (db, c, extra = {}) => createVenueWithAlias(db.client, { type: 'park', ...c, ...extra });
const newResolve = (db, label, city) => resolveVenue(db.client, { locationName: label, city });

// ---------------------------------------------------------------- Jerusalem Zoo
test('Z-A as it happened: the learned label one letter off the seeded alias, 190 m away, now REUSES the keeper - no second venue', async () => {
  const db = fakeDb({ venues: [ZOO, AQUARIUM], aliases: [...ZOO_ALIASES, ['אקווריום ישראל', AQUARIUM.id]] });
  const r = await learn(db, LEARNED);
  assert.equal(r.created, false);
  assert.equal(r.venue.id, ZOO.id);
  assert.equal(r.identity.level, 4);
  assert.equal(db.inserts.length, 0);
  assert.equal(db.aliasWrites.length, 0, 'an inferred reuse never writes an alias');
  const again = await learn(db, LEARNED);
  assert.equal(again.venue.id, ZOO.id, 'the same variant tomorrow reuses the keeper again');
  assert.equal(again.identity.level, 4, 'by identity again - it never depended on a persisted inferred alias');
  assert.equal(db.inserts.length + db.aliasWrites.length, 0);
});

test('Z-A today (after Batch F part 2): losers merged into the keeper; a new label variant still lands on the keeper', async () => {
  const keeper = { ...ZOO, lat: 31.7461139, lng: 35.1766343 };
  const db = fakeDb({
    venues: [keeper, AQUARIUM,
      { id: '287600a2', name_he: 'גן החיות התנ״כי בירושלים', venue_type: 'park', city: 'ירושלים', lat: 31.7461139, lng: 35.1766343, is_active: false, merged_into: ZOO.id },
      { id: '6b785f3c', name_he: 'גן החיות ואקווריום ישראל', venue_type: 'park', city: 'ירושלים', is_active: false, merged_into: ZOO.id }],
    aliases: [...ZOO_ALIASES, ['גן החיות התנ״כי בירושלים', ZOO.id], ['גן החיות ואקווריום ישראל', ZOO.id], ['גן החיות התנ״כי בירושלים', '287600a2'], ['גן החיות ואקווריום ישראל', '6b785f3c']],
  });
  for (const label of ['גן החיות התנ״כי בירושלים', 'גן החיות ואקווריום ישראל']) {
    const r = await learn(db, { ...LEARNED, label });
    assert.equal(r.venue.id, ZOO.id, label); assert.equal(r.identity.level, 2, label);
  }
  const variant = await learn(db, { ...LEARNED, label: 'גן החיות התנ״כי של ירושלים', lat: 31.7464, lng: 35.1769 });
  assert.equal(variant.venue.id, ZOO.id);
  assert.equal(variant.created, false);
  assert.equal(db.inserts.length, 0);
  // the aquarium is a separate, separately ticketed place - never absorbed
  const aq = await learn(db, { label: 'אקווריום ישראל', city: 'ירושלים', lat: 31.7449, lng: 35.1659 });
  assert.equal(aq.venue.id, AQUARIUM.id);
});

// ---------------------------------------------------------------- aggregator / ambiguity
test('same venue from an aggregator label ("חי פארק כפר סבא" at the spot of "חי פארק") reuses it', async () => {
  const db = fakeDb({ venues: [{ id: 'ks', name_he: 'חי פארק', venue_type: 'petting_zoo', city: 'כפר סבא', lat: 32.1760, lng: 34.9060 }], aliases: [['חי פארק', 'ks']] });
  const r = await learn(db, { label: 'חי פארק כפר סבא', city: 'כפר סבא', lat: 32.1762, lng: 34.9061 });
  assert.equal(r.venue.id, 'ks'); assert.equal(r.identity.level, 3); assert.equal(db.inserts.length, 0);
});

test('ambiguous identity is HELD, never guessed and never created', async () => {
  const two = fakeDb({ venues: [{ id: 'a', name_he: 'מוזיאון המדע', city: 'ירושלים', lat: 31.7700, lng: 35.2000 }, { id: 'b', name_he: 'מוזיאון המדע', city: 'ירושלים', lat: 31.7702, lng: 35.2004 }] });
  const r1 = await learn(two, { label: 'מוזיאון המדע', city: 'ירושלים', lat: 31.7701, lng: 35.2002 });
  assert.ok(r1.hold && !r1.venue); assert.match(r1.error, /more than one/); assert.equal(two.inserts.length, 0);

  const near = fakeDb({ venues: [{ id: 'm', name_he: 'מוזיאון הטבע והסביבה לילדים', city: 'חיפה', lat: 32.8000, lng: 34.9900 }] });
  const r2 = await learn(near, { label: 'מוזיאון הטבע והסביבה לילדים ולנוער', city: 'חיפה', lat: 32.8018, lng: 34.9900 }); // ~200 m, agreement 0.8
  assert.ok(r2.hold); assert.equal(near.inserts.length, 0);

  const branch = fakeDb({ venues: [{ id: 't', name_he: 'תיאטרון הבובות', city: 'חולון', lat: 32.0100, lng: 34.7700 }] });
  const r3 = await learn(branch, { label: 'תיאטרון הבובות חולון', city: 'חולון', lat: 32.0280, lng: 34.7700 }); // same name, 2 km: maybe a branch
  assert.ok(r3.hold); assert.equal(branch.inserts.length, 0);
});

test('an alias known only in another city is held (unchanged rule, same message)', async () => {
  const db = fakeDb({ venues: [{ id: 'az', name_he: 'עזריאלי אילון', city: 'תל אביב-יפו', lat: 32.07, lng: 34.79 }], aliases: [['עזריאלי אילון', 'az']] });
  const r = await learn(db, { label: 'עזריאלי אילון', city: 'רמת גן', lat: 32.08, lng: 34.81 });
  assert.ok(r.hold); assert.match(r.error, /city mismatch, human check/); assert.equal(db.inserts.length, 0);
});

// ---------------------------------------------------------------- generic / merged / no-city / lookup failure
test('generic library labels still cannot learn; a generic-named existing venue is never identity evidence', async () => {
  for (const l of ['ספרייה', 'הספרייה העירונית', 'ספריה עירונית']) {
    const db = fakeDb({ venues: [ZOO] });
    const r = await learn(db, { label: l, city: 'רמת השרון', lat: 32.14, lng: 34.84 });
    assert.ok(r.error && !r.venue, l); assert.equal(db.inserts.length + db.aliasWrites.length, 0, l);
  }
  assert.equal(isGenericVenueName('ספריית רמת השרון', 'רמת השרון'), true, 'the city form of a generic label is still generic (R4)');
  assert.equal(isGenericVenueName('פינת חי', null), true);
  assert.equal(isGenericVenueName('ספריית בית אריאלה', 'תל אביב-יפו'), false);
  const v = decideVenueMatch({ label: 'ספריית בית אריאלה', city: 'תל אביב-יפו', lat: 32.08, lng: 34.78 }, [{ id: 'g', name_he: 'ספרייה', aliases: ['הספרייה העירונית'], city: 'תל אביב-יפו', lat: 32.08, lng: 34.78, is_active: true }]);
  assert.equal(v.verdict, 'NO_MATCH');
});

test('a merged venue resolves to its keeper; a deactivated one or a broken chain is held', async () => {
  const merged = fakeDb({ venues: [
    { id: 'K', name_he: 'מוזיאון ילדים ישראלי', city: 'חולון', lat: 32.0200, lng: 34.7800 },
    { id: 'L', name_he: 'מוזיאון הילדים', city: 'חולון', lat: 32.0205, lng: 34.7800, is_active: false, merged_into: 'K' }] });
  const r = await learn(merged, { label: 'מוזיאון הילדים', city: 'חולון', lat: 32.0206, lng: 34.7801 });
  assert.equal(r.venue.id, 'K'); assert.equal(r.identity.via, 'L'); assert.equal(merged.inserts.length, 0);

  const dead = fakeDb({ venues: [{ id: 'D', name_he: 'בית התפוצות', city: 'תל אביב-יפו', lat: 32.1130, lng: 34.8040, is_active: false }] });
  const r2 = await learn(dead, { label: 'בית התפוצות', city: 'תל אביב-יפו', lat: 32.1131, lng: 34.8041 });
  assert.ok(r2.hold); assert.match(r2.error, /deactivated/); assert.equal(dead.inserts.length, 0);

  const broken = fakeDb({ venues: [{ id: 'X', name_he: 'בית התפוצות', city: 'תל אביב-יפו', lat: 32.1130, lng: 34.8040, is_active: false, merged_into: 'gone' }] });
  const r3 = await learn(broken, { label: 'בית התפוצות', city: 'תל אביב-יפו', lat: 32.1131, lng: 34.8041 });
  assert.ok(r3.hold); assert.equal(broken.inserts.length, 0);
});

test('a no-city label never invents a match (and the learner refuses it before any read)', async () => {
  const far = { id: 'h', name_he: 'מרכז המדע', city: 'חיפה', lat: 32.80, lng: 34.99, is_active: true, aliases: [] };
  assert.equal(decideVenueMatch({ label: 'מרכז המדע', city: null, lat: 32.83, lng: 34.99 }, [far]).verdict, 'NO_MATCH');
  assert.equal(decideVenueMatch({ label: 'מרכז המדע', city: null, lat: null, lng: null }, [{ ...far, lat: null, lng: null }]).verdict, 'NO_MATCH');
  const db = fakeDb({ venues: [far] });
  const r = await learn(db, { label: 'מרכז המדע', city: null, lat: 32.83, lng: 34.99 });
  assert.equal(r.error, 'no city'); assert.equal(db.inserts.length, 0);
});

test('a failed identity lookup holds - a venue is never created blind', async () => {
  const db = fakeDb({ venues: [ZOO], failVenueReads: true });
  const r = await learn(db, { label: 'תיאטרון הקרון', city: 'ירושלים', lat: 31.76, lng: 35.21 });
  assert.ok(r.hold); assert.match(r.error, /identity lookup failed/); assert.equal(db.inserts.length, 0);
});

// ---------------------------------------------------------------- still creates
test('a genuinely new venue - or another tenant at the same spot - is still created', async () => {
  const db = fakeDb({ venues: [ZOO, AQUARIUM], aliases: ZOO_ALIASES });
  const r = await learn(db, { label: 'תיאטרון הקרון', city: 'ירושלים', lat: 31.7680, lng: 35.2250 });
  assert.equal(r.created, true); assert.equal(r.identity.verdict, 'NO_MATCH'); assert.equal(db.inserts.length, 1);

  const park = fakeDb({ venues: [{ id: 'p', name_he: 'פינת חי בפארק רעננה', city: 'רעננה', lat: 32.1900, lng: 34.8700 }] });
  const t = await learn(park, { label: 'שייט בסירה באגם הפארק', city: 'רעננה', lat: 32.1901, lng: 34.8700 });
  assert.equal(t.created, true);
});

test('level 1: an external place id owner is the identity when the caller has one', async () => {
  const db = fakeDb({ venues: [{ ...ZOO, google_place_id: 'ChIJzoo' }] });
  const r = await matchExistingVenue(db.client, { label: 'Jerusalem Biblical Zoo', city: 'ירושלים', lat: 31.7, lng: 35.1, googlePlaceId: 'ChIJzoo' });
  assert.equal(r.verdict, 'MATCH'); assert.equal(r.level, 1); assert.equal(r.venue.id, ZOO.id);
});

// ---------------------------------------------------------------- the three automatic creators share the one door
test('propose-venues, Cleaner venue clusters and escalate-venue create only through createVenueWithAlias, which matches first', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const learning = read('venueLearning.js');
  assert.ok(learning.indexOf('matchExistingVenue(') < learning.indexOf(".from('venues').insert("), 'identity runs before the insert');
  for (const f of ['propose-venues.js', 'cleaner/venueClusters.js', 'escalate-venue.js']) {
    const src = read(f);
    assert.doesNotMatch(src, /from\('venues'\)\.insert\(/, `${f} must not insert venues directly`);
    assert.match(src, /createVenueWithAlias\(/, f);
  }
});

// ---------------------------------------------------------------- R12 correction (2026-09-26 production replay)
// Batch F part 3 refused the city-less alias "ספריית הילדים והנוער" on 10f003b0 - a cross-city binding trap. R12 reuse
// is identity/linking only: no reuse, at any level, writes an alias.
const KS_LIB = { id: '10f003b0', name_he: 'ספריית הילדים והנוער כפר סבא', venue_type: 'library', city: 'כפר סבא', lat: 32.173774, lng: 34.892692 };
const KS_LIB_ALIASES = [['ספריית הילדים והנוער כפר סבא', KS_LIB.id], ['ספריית הילדים כפר סבא', KS_LIB.id]];

test('children\'s library: the city-less label at the library reuses 10f003b0 twice - zero venues, zero aliases', async () => {
  const db = fakeDb({ venues: [KS_LIB], aliases: KS_LIB_ALIASES });
  const cand = { label: 'ספריית הילדים והנוער', city: 'כפר סבא', lat: 32.173774, lng: 34.892692 };
  for (const run of [1, 2]) {
    const r = await learn(db, cand);
    assert.equal(r.venue.id, KS_LIB.id, `run ${run}`);
    assert.equal(r.created, false, `run ${run}`);
    assert.ok(r.identity.level >= 3, `run ${run}: identity, not a stored inferred alias`);
  }
  assert.equal(db.inserts.length, 0);
  assert.equal(db.aliasWrites.length, 0);
  assert.ok(!db.aliases.some((a) => a.alias_normalized === normalizeVenueAlias('ספריית הילדים והנוער')), 'the refused city-less alias never appears');
  // the same label in another city cannot bind through an inferred alias, because none exists
  assert.equal(await newResolve(db, 'ספריית הילדים והנוער', null), null);
  assert.equal(await newResolve(db, 'ספריית הילדים והנוער', 'רעננה'), null);
  const other = await learn(db, { label: 'ספריית הילדים והנוער', city: 'רעננה', lat: 32.184, lng: 34.871 });
  assert.notEqual(other.venue.id, KS_LIB.id, 'Raanana is never bound to the Kfar Saba library');
  assert.equal(other.created, true, 'the pre-R12 creation policy decides the Raanana label (its own venue)');
});

test('broad inferred labels (היכל התרבות / תיאטרון / בית ספר שדה) may reuse on strong identity but never become aliases', async () => {
  const venues = [
    { id: 'hma', name_he: 'היכל התרבות מעלה אדומים', venue_type: 'theater', city: 'מעלה אדומים', lat: 31.7770, lng: 35.2980 },
    { id: 'tj', name_he: 'תיאטרון ירושלים', venue_type: 'theater', city: 'ירושלים', lat: 31.7680, lng: 35.2150 },
    { id: 'bsg', name_he: 'בית ספר שדה גולן', venue_type: 'visitor_center', city: 'גולן', lat: 32.9920, lng: 35.6900 },
  ];
  const db = fakeDb({ venues, aliases: venues.map((v) => [v.name_he, v.id]) });
  for (const [label, v] of [['היכל התרבות', venues[0]], ['תיאטרון', venues[1]], ['בית ספר שדה', venues[2]]]) {
    const r = await learn(db, { label, city: v.city, lat: v.lat + 0.0001, lng: v.lng });
    assert.equal(r.venue.id, v.id, label); assert.equal(r.created, false, label);
  }
  assert.equal(db.inserts.length, 0);
  assert.equal(db.aliasWrites.length, 0, 'no broad alias written');
  // a later "היכל התרבות" in another city is not bound to Ma'ale Adumim - there is no alias to bind through
  const ashkelon = await learn(db, { label: 'היכל התרבות', city: 'אשקלון', lat: 31.6690, lng: 34.5710 });
  assert.equal(ashkelon.created, true);
  assert.notEqual(ashkelon.venue.id, 'hma');
});

test('generic / weak / empty-core names are NO identity evidence and fall through to the pre-R12 creation policy (never an R12-only hold)', async () => {
  for (const [label, city, lat, lng] of [['פארק עירוני הרצליה', 'הרצליה', 32.168, 34.822], ['מוזיאון תל אביב', 'תל אביב-יפו', 32.077, 34.786], ['פארק רעננה', 'רעננה', 32.189, 34.870], ['קניון ירושלים', 'ירושלים', 31.751, 35.187], ['ملعب خلة الحداد', 'אפרת', 31.655, 35.150], ['חיפה', 'חיפה', 32.794, 34.989]]) {
    const db = fakeDb({ venues: [ZOO], aliases: ZOO_ALIASES });
    const r = await learn(db, { label, city, lat, lng });
    assert.ok(!r.hold, `${label}: no R12 hold`);
    assert.equal(r.created, true, `${label}: the existing creation path runs`);
    assert.equal(r.identity.verdict, 'NO_MATCH', label);
  }
  // a generic candidate next to a venue whose own name is generic-cored: neither side is evidence -> no reuse, no hold
  const safed = fakeDb({ venues: [{ id: 'pc', name_he: 'פינת חי צפת', city: 'צפת', lat: 32.9650, lng: 35.4960 }], aliases: [['פינת חי צפת', 'pc']] });
  const r = await learn(safed, { label: 'פינת חי', city: 'צפת', lat: 32.9651, lng: 35.4960 });
  assert.equal(r.identity.verdict, 'NO_MATCH'); assert.ok(!r.hold); assert.equal(r.created, true);
  // Arabic: an empty identity core can never produce an inferred reuse either
  assert.equal(decideVenueMatch({ label: 'ملعب خلة الحداد', city: 'אפרת', lat: 31.655, lng: 35.150 }, [{ id: 'x', name_he: 'ملعب خلة الحداد', aliases: [], city: 'אפרת', lat: 31.655, lng: 35.150, is_active: true }]).verdict, 'NO_MATCH');
});

test('Tel Aviv: a venue still stored as "תל אביב" is found by the same-settlement lookup (evidence-based short form only)', async () => {
  const { storedCityForms } = require('../lib/venueMatch');
  assert.deepEqual(storedCityForms('תל אביב יפו'), ['תל אביב יפו', 'תל אביב']);
  assert.deepEqual(storedCityForms('חיפה'), ['חיפה'], 'no widening for any other settlement');
  const db = fakeDb({ venues: [{ id: 'tlv', name_he: 'תיאטרון הבובות', city: 'תל אביב', lat: 32.0800, lng: 34.7800 }] });
  db.venues[0].city = 'תל אביב'; // stored short form (the fake normalizes on seed; production has one such row)
  const r = await learn(db, { label: 'תיאטרון הבובות', city: 'תל אביב-יפו', lat: 32.1000, lng: 34.7800 }); // same name, 2.2 km: possible branch
  assert.ok(r.hold, 'the short-form venue is seen, so the same-name-elsewhere rule holds instead of creating blind');
  assert.equal(db.inserts.length, 0);
});
