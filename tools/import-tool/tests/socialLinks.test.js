// SOCIAL source discovery (step 1) - account identity from links on a publisher's official site.
// States never collapse: a link is DISCOVERED; VERIFIED needs the official site + unambiguity or a name match.
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifySocialLink, resolvePublisherAccounts, handleMatchesPublisher } = require('../lib/socialLinks');

test('accounts are normalized; share / intent / post / builder links are never accounts', () => {
  assert.deepEqual(classifySocialLink('https://www.instagram.com/Rotshteins.k/?hl=he'), { kind: 'account', platform: 'instagram', handle: 'rotshteins.k', by: 'handle', url: 'https://www.instagram.com/rotshteins.k/' });
  assert.equal(classifySocialLink('https://m.facebook.com/grand.BeerSheva/').handle, 'grand.beersheva');
  assert.equal(classifySocialLink('https://www.facebook.com/profile.php?id=100064812345678').by, 'page_id');
  assert.equal(classifySocialLink('https://www.facebook.com/pages/Some-Venue/123456789012').handle, '123456789012');
  assert.equal(classifySocialLink('https://www.facebook.com/pg/nacityculture/posts').handle, 'nacityculture');
  for (const bad of ['https://www.facebook.com/sharer/sharer.php?u=https://x.co.il', 'https://www.facebook.com/share.php?u=x', 'https://www.facebook.com/tr?id=1', 'https://www.facebook.com/plugins/like.php', 'https://www.instagram.com/p/CxYz123/', 'https://www.instagram.com/reel/abc/', 'https://www.instagram.com/explore/tags/kids/', 'https://www.facebook.com/events/123/', 'https://www.instagram.com/wix/', 'https://www.facebook.com/', 'https://www.facebook.com/hashtag/kids'])
    assert.equal(classifySocialLink(bad).kind, 'rejected', bad);
  assert.equal(classifySocialLink('https://example.co.il/instagram'), null, 'not a platform host');
  assert.equal(classifySocialLink('javascript:void(0)'), null);
});

test('link-in-bio and WhatsApp are recorded as discovery / action EVIDENCE, never as accounts or activities', () => {
  assert.deepEqual(classifySocialLink('https://linktr.ee/MyVenue'), { kind: 'bio_link', host: 'linktr.ee', handle: 'myvenue', url: 'https://linktr.ee/MyVenue' });
  assert.equal(classifySocialLink('https://wa.me/972501234567?text=hi').kind, 'whatsapp');
  const r = resolvePublisherAccounts(['https://linktr.ee/MyVenue', 'https://wa.me/972501234567'], {});
  assert.equal(r.accounts.length, 0); assert.equal(r.bioLinks.length, 1); assert.equal(r.whatsapp.length, 1);
});

test('VERIFIED = linked from the official site AND the handle carries the publisher name; a lone unrelated account is only DISCOVERED', () => {
  const single = resolvePublisherAccounts(['https://www.facebook.com/rotshteins/', 'https://facebook.com/rotshteins', 'https://www.instagram.com/rotshteins.k/'], { siteHost: 'www.rotshteins.co.il' });
  assert.deepEqual(single.accounts.map((a) => [a.platform, a.handle, a.state, a.mentions]), [['facebook', 'rotshteins', 'VERIFIED', 2], ['instagram', 'rotshteins.k', 'VERIFIED', 1]]);
  // a municipality site links several departments: only the one that carries the publisher's name is verified
  const muni = resolvePublisherAccounts(['https://www.facebook.com/nahariya.muni', 'https://www.facebook.com/nacityculture', 'https://www.facebook.com/somepartner'], { siteHost: 'www.nahariya.muni.il' });
  const by = Object.fromEntries(muni.accounts.map((a) => [a.handle, a]));
  assert.equal(by['nahariya.muni'].state, 'VERIFIED'); assert.equal(by['nahariya.muni'].verified_via, 'official_site+handle_matches_publisher');
  assert.equal(by['nacityculture'].state, 'DISCOVERED'); assert.match(by['somepartner'].why_not_verified, /3 facebook accounts/);
  // the only account on a mall's site is its PARENT COMPANY: affiliation, not identity
  const parent = resolvePublisherAccounts(['https://www.instagram.com/amot_investment/'], { siteHost: 'www.arim-mall.co.il' });
  assert.equal(parent.accounts[0].state, 'DISCOVERED'); assert.equal(parent.accounts[0].hint, 'only_account_of_this_platform_on_the_official_site');
  assert.equal(classifySocialLink('https://www.facebook.com/v26.0/dialog/share').kind, 'rejected');
});

test('name evidence is conservative: short handles and generic tokens never verify', () => {
  assert.equal(handleMatchesPublisher('rotshteins.k', { siteHost: 'rotshteins.co.il' }), true);
  assert.equal(handleMatchesPublisher('abc', { siteHost: 'abc.co.il' }), false, 'too short');
  assert.equal(handleMatchesPublisher('kidsfun', { siteHost: 'www.muni.il' }), false, 'generic host tokens are ignored');
  assert.equal(handleMatchesPublisher('holonculture', { nameEn: 'Holon Mediatheque' }), true);
});
