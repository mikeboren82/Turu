// Venue clusters: grouping by normalized label (+city), and the STRICT independence rule for MEDIUM
// evidence - rows from one source/page count once, and cluster size is not evidence.
const test = require('node:test');
const assert = require('node:assert/strict');
const { groupMembers, independentAgreeing, MEDIUM_INDEPENDENT_MIN } = require('../cleaner/venueClusters');
const { isLearnableLabel, inferVenueType } = require('../venueLearning');

const m = (label, city, id) => ({ case: { id }, subject: { location_name: label, city, organizer_name: null } });

test('grouping: same label across spellings/cities merges when one city group exists; generic labels are skipped', () => {
  const members = [m('תיאטרון הקרון', null, '1'), m('תיאטרון הקרון', null, '2'), m('תיאטרון הקרון', 'ירושלים', '3'), m('התיאטרון הקרון', 'ירושלים', '4'), m('ספרייה', 'חולון', '5'), m('ספרייה', 'חולון', '6'), m('ספרייה', 'חולון', '7')];
  const groups = groupMembers(members, 3);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].city, 'ירושלים'); assert.equal(groups[0].members.length, 4);
  assert.ok(!isLearnableLabel('שכונות ברחבי העיר')); assert.ok(!isLearnableLabel('הספרייה העירונית')); assert.ok(isLearnableLabel('היכל התרבות מעלה אדומים'));
  assert.equal(inferVenueType('היכל התרבות עכו'), 'theater'); assert.equal(inferVenueType('מוז״א - מוזיאון ארץ ישראל'), 'museum');
});

test('independence: same source or same page host counts once; disagreeing coordinates/cities do not count', () => {
  const base = { lat: 31.77, lng: 35.22, city: 'ירושלים', confidence: 'MEDIUM' };
  const ev = [
    { ...base, source_id: 's1', host: 'a.il' },
    { ...base, source_id: 's1', host: 'b.il' },            // same source -> not independent
    { ...base, source_id: 's2', host: 'a.il' },            // same page host -> not independent
    { ...base, source_id: 's3', host: 'c.il', lat: 32.5 }, // 80 km away -> disagrees
    { ...base, source_id: 's4', host: 'd.il' },
    { ...base, source_id: 's5', host: 'e.il', city: 'תל אביב' }, // city disagrees
    { ...base, source_id: 's6', host: 'f.il', lat: 31.7705, lng: 35.2203 },
  ];
  const ind = independentAgreeing(ev);
  assert.deepEqual(ind.map((e) => e.source_id), ['s1', 's4', 's6']);
  assert.equal(ind.length, MEDIUM_INDEPENDENT_MIN);
  assert.equal(independentAgreeing(ev.slice(0, 3)).length, 1, 'fifty rows from one source are ONE confirmation');
});
