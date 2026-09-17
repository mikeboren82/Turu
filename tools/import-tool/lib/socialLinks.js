// TuRu - SOCIAL SOURCE discovery, step 1: which links on a publisher's OWN official website point at its
// social accounts? (THE MONSTER, social input family - not a second ingestion system: the result is a row in
// the existing source registry.)  Pure functions, no network.
//
// States are never collapsed (binding):  DISCOVERED (a link exists)  ->  VERIFIED (the account is the
// publisher's: it is linked from the publisher's official site and is unambiguous, or its handle carries the
// publisher's name)  ->  ACCESSIBLE (a legitimate access method exists - decided elsewhere, by the platform
// capability audit)  ->  PRODUCTIVE (it yielded canonical information).  Finding a URL proves only the first.
//
// NOT accounts: share / intent / plugin / login / policy URLs, the platform's own pages, hashtag / explore /
// post / reel permalinks (evidence of a POST, not of an account), and website-builder brand accounts.
const PLATFORM_HOSTS = { 'facebook.com': 'facebook', 'fb.com': 'facebook', 'm.facebook.com': 'facebook', 'web.facebook.com': 'facebook', 'he-il.facebook.com': 'facebook', 'instagram.com': 'instagram', 'instagr.am': 'instagram' };
const BIO_HOSTS = new Set(['linktr.ee', 'beacons.ai', 'bio.site', 'lnk.bio', 'taplink.cc', 'campsite.bio', 'linkin.bio', 'msha.ke']);
const WHATSAPP_HOSTS = new Set(['wa.me', 'api.whatsapp.com', 'chat.whatsapp.com', 'web.whatsapp.com']);
const FB_NOT_ACCOUNT = new Set(['sharer', 'sharer.php', 'share', 'share.php', 'dialog', 'plugins', 'tr', 'login', 'login.php', 'l.php', 'help', 'policies', 'policy.php', 'privacy', 'legal', 'business', 'ads', 'events', 'groups', 'watch', 'hashtag', 'photo', 'photo.php', 'photos', 'video.php', 'videos', 'story.php', 'permalink.php', 'profile.php', 'people', 'pages', 'pg', 'home.php', 'marketplace', 'gaming', 'reel', 'reels', 'stories', 'sharer.php']);
const IG_NOT_ACCOUNT = new Set(['p', 'reel', 'reels', 'tv', 'explore', 'stories', 'accounts', 'about', 'legal', 'developer', 'direct', 'share', 'sharer', 'tags', 'web']);
// brand accounts of site builders / agencies that sit in page footers
const BUILDER_HANDLES = new Set(['wix', 'wordpress', 'elementor', 'shopify', 'squarespace', 'webflow', 'godaddy', 'facebook', 'instagram', 'meta']);

const hostOf = (u) => { try { return new URL(u).host.toLowerCase().replace(/^www\./, ''); } catch { return null; } };

// -> { kind: 'account', platform, handle, url } | { kind: 'page_id', ... } | { kind: 'bio_link' | 'whatsapp', url } | { kind: 'rejected', why } | null
function classifySocialLink(href) {
  if (!href || typeof href !== 'string') return null;
  let u; try { u = new URL(href.trim()); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.host.toLowerCase().replace(/^www\./, '');
  if (BIO_HOSTS.has(host)) { const h = u.pathname.split('/').filter(Boolean)[0]; return h ? { kind: 'bio_link', host, handle: h.toLowerCase(), url: `https://${host}/${h}` } : { kind: 'rejected', why: 'bio host without a handle' }; }
  if (WHATSAPP_HOSTS.has(host)) return { kind: 'whatsapp', url: u.toString().split('#')[0] };
  const platform = PLATFORM_HOSTS[host];
  if (!platform) return null;
  const parts = u.pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
  if (!parts.length) return { kind: 'rejected', why: 'platform home page' };
  const first = parts[0].toLowerCase();
  if (platform === 'facebook') {
    if (first === 'profile.php' || first === 'people') { const id = u.searchParams.get('id') || parts[2]; return id && /^\d{5,}$/.test(id) ? { kind: 'account', platform, handle: id, by: 'page_id', url: `https://www.facebook.com/profile.php?id=${id}` } : { kind: 'rejected', why: 'profile link without an id' }; }
    if (first === 'pages' && parts.length >= 3 && /^\d{5,}$/.test(parts[2])) return { kind: 'account', platform, handle: parts[2], by: 'page_id', url: `https://www.facebook.com/${parts[2]}` };
    if (first === 'pg' && parts[1]) return classifySocialLink(`https://www.facebook.com/${parts[1]}`);
    if (FB_NOT_ACCOUNT.has(first)) return { kind: 'rejected', why: `facebook /${first} is not an account` };
    if (/^v\d+(\.\d+)?$/.test(first)) return { kind: 'rejected', why: 'Graph API / SDK version path, not an account' };
    if (!/^[a-z0-9.\-_֐-׿]{2,80}$/i.test(parts[0])) return { kind: 'rejected', why: 'not a page handle' };
    if (BUILDER_HANDLES.has(first)) return { kind: 'rejected', why: 'site-builder / platform brand account' };
    return { kind: 'account', platform, handle: first, by: 'handle', url: `https://www.facebook.com/${parts[0]}` };
  }
  if (IG_NOT_ACCOUNT.has(first)) return { kind: 'rejected', why: `instagram /${first} is not an account` };
  if (!/^[a-z0-9._]{2,30}$/i.test(parts[0])) return { kind: 'rejected', why: 'not an instagram handle' };
  if (BUILDER_HANDLES.has(first)) return { kind: 'rejected', why: 'site-builder / platform brand account' };
  return { kind: 'account', platform, handle: first, by: 'handle', url: `https://www.instagram.com/${first}/` };
}

// name evidence: do the handle's letters carry a distinctive token of the publisher's name / site host?
const latin = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// words every venue of a kind shares: a common "museum" / "kenyon" / "israel" proves nothing about identity
const GENERIC_CHUNKS = ['official', 'israel', 'museum', 'center', 'centre', 'kenyon', 'canyon', 'mall', 'tarbut', 'culture', 'cultural', 'matnas', 'park', 'kids', 'muni', 'city', 'theatre', 'theater', 'library', 'libraries', 'online', 'group'];
const distinctive = (s) => { let v = latin(s); for (const g of GENERIC_CHUNKS) v = v.split(g).join('|'); return v; };
function longestCommonChunk(a, b) {
  let best = 0;
  for (const x of a.split('|')) for (const y of b.split('|')) {
    if (x.length < 5 || y.length < 5) continue;
    for (let i = 0; i < x.length; i++) for (let j = 0; j < y.length; j++) { let k = 0; while (i + k < x.length && j + k < y.length && x[i + k] === y[j + k]) k++; if (k > best) best = k; }
  }
  return best;
}
// the handle and the publisher's site host / English name share a DISTINCTIVE run of >= 5 letters
// (jerusalembiblicalzoo ~ jerusalemzoo.org.il, hechtmus ~ mushecht.haifa.ac.il); transliteration differs too
// much for whole-token equality, and generic words are removed first so "israelmuseum" never verifies
// "israelchildrensmuseum"
function handleMatchesPublisher(handle, { siteHost, nameEn } = {}) {
  const h = distinctive(handle); if (latin(handle).length < 4) return false;
  const sources = [];
  if (siteHost) sources.push(String(siteHost).replace(/^www\./, '').split('.').slice(0, -1).filter((t) => !['co', 'org', 'gov', 'muni', 'net', 'ac', 'com'].includes(t)).join('|'));
  if (nameEn) sources.push(String(nameEn));
  // each host label / name word is compared on its own (labels are never glued into one string)
  // ...or the handle contains the site's WHOLE host label (cinemall.co.il -> cinemallhaifa, seamall -> ashdodseamall)
  return sources.some((src) => src.split(/[|\s]+/).some((part) => longestCommonChunk(h, distinctive(part)) >= 5 || (latin(part).length >= 4 && latin(part) === latin(handle)) || (latin(part).length >= 6 && latin(handle).includes(latin(part)))));
}

// links: hrefs found on ONE publisher's official pages -> accounts with a discovery/verification state
function resolvePublisherAccounts(hrefs, publisher = {}) {
  const accounts = new Map(); const bio = new Map(); const whatsapp = new Set(); const rejected = [];
  for (const href of hrefs || []) {
    const c = classifySocialLink(href); if (!c) continue;
    if (c.kind === 'rejected') { rejected.push({ href: String(href).slice(0, 120), why: c.why }); continue; }
    if (c.kind === 'bio_link') { bio.set(c.url, c); continue; }
    if (c.kind === 'whatsapp') { whatsapp.add(c.url); continue; }
    const k = `${c.platform}:${c.handle}`; const prev = accounts.get(k);
    accounts.set(k, { ...c, mentions: (prev?.mentions || 0) + 1 });
  }
  const out = [];
  for (const platform of ['facebook', 'instagram']) {
    const list = [...accounts.values()].filter((a) => a.platform === platform);
    for (const a of list) {
      const nameOk = handleMatchesPublisher(a.handle, publisher);
      // VERIFIED = linked from the official site AND the handle carries the publisher's own name. Being the only
      // account on the site proves AFFILIATION, not identity: a mall's site links its parent company
      // (קניון ערים -> amot_investment, ביג פאשן נצרת -> bigcenterisrael). That stays DISCOVERED, with the hint.
      const verified = nameOk;
      out.push({ platform, handle: a.handle, url: a.url, by: a.by, mentions: a.mentions, state: verified ? 'VERIFIED' : 'DISCOVERED', verified_via: verified ? 'official_site+handle_matches_publisher' : null, hint: !verified && list.length === 1 ? 'only_account_of_this_platform_on_the_official_site' : null, why_not_verified: verified ? null : (list.length === 1 ? "linked from the official site, but the handle does not carry the publisher's name (may be a parent company / agency account)" : `${list.length} ${platform} accounts on the site and this handle does not carry the publisher's name`) });
    }
  }
  return { accounts: out, bioLinks: [...bio.values()], whatsapp: [...whatsapp], rejected };
}

module.exports = { classifySocialLink, resolvePublisherAccounts, handleMatchesPublisher, hostOf, BIO_HOSTS };
