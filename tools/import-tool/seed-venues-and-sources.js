// TuRu - idempotent seed/upsert of venues + sources from source-manifest.json (the registry is
// data, not code: growing coverage = adding manifest entries, then re-running this).
//
//   node seed-venues-and-sources.js            -> dry run (prints what would change)
//   node seed-venues-and-sources.js --apply    -> writes
//   node seed-venues-and-sources.js --apply --batch=<label>   -> stamps sources.discovery_batch
//
// Manifest schema (source-manifest.json):
// {
//   "venues": [{ "key": "renanim", "name_he": "קניון רננים", "venue_type": "mall", "city": "רעננה",
//                "region": "השרון", "chain": null, "website_url": "...", "events_url": "...",
//                "facebook_url": "...", "instagram_url": "...", "aliases": ["רננים"], "notes": "..." }],
//   "sources": [{ "name": "...", "seed_url": "https://...", "source_kind": "events_page",
//                "publisher_type": "venue_operator", "publisher_name": "...", "venue": "renanim",
//                "region": "השרון", "categories": [], "scan_frequency_hours": 72, "priority": 7,
//                "source_trust_score": 75, "is_trusted": false, "strategy": "generic_html",
//                "status": "verified" | "blocked" | "js_only" | "social" | "needs_verification",
//                "disabled_reason": "...", "notes": "..." }]
// }
// Sources are matched by seed_url (upsert), venues by (name_he, city). Existing rows are only
// filled in / updated for registry fields - never deleted, is_active never flipped from true to
// false for a source that already exists unless its manifest status is blocked/js_only/social.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getClient } = require('./supabase');
const { normalizeVenueAlias } = require('./venueNaming');
const { normalizeCityName } = require('./cityNaming');

const APPLY = process.argv.includes('--apply');
const BATCH = (process.argv.find((a) => a.startsWith('--batch=')) || '').split('=')[1] || null;
const MANIFEST = path.join(__dirname, (process.argv.find((a) => a.startsWith('--manifest=')) || '').split('=')[1] || 'source-manifest.json');

const INACTIVE_STATUSES = { blocked: 'blocked_or_waf: page not fetchable by the scanner', js_only: 'js_only: page renders client-side, no server HTML to extract', social: 'unsupported_platform: Facebook/Instagram require a browser or API - not scraped', needs_verification: 'needs_verification: not yet fetch-tested' };

async function main() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const { client, userId } = await getClient();
  console.log(`=== seed venues+sources (${APPLY ? 'APPLY' : 'DRY RUN'}) from ${path.basename(MANIFEST)}: ${manifest.venues.length} venues, ${manifest.sources.length} sources ===`);

  const { data: existingVenues } = await client.from('venues').select('id, name_he, city');
  const venueIdByKey = {};
  let vCreated = 0, vExisting = 0;
  for (const v of manifest.venues) {
    const city = v.city ? normalizeCityName(v.city) : null;
    const found = (existingVenues || []).find((e) => e.name_he === v.name_he && (normalizeCityName(e.city) || null) === city);
    let venueId = found?.id;
    if (!venueId) {
      vCreated++;
      if (APPLY) {
        const { data, error } = await client.from('venues').insert({
          name_he: v.name_he, venue_type: v.venue_type || 'other', city, region: v.region || null, address: v.address || null,
          chain: v.chain || null, website_url: v.website_url || null, events_url: v.events_url || null,
          facebook_url: v.facebook_url || null, instagram_url: v.instagram_url || null, lat: v.lat ?? null, lng: v.lng ?? null,
          notes: v.notes || null, created_by: userId,
        }).select('id').single();
        if (error) { console.error('venue insert failed', v.name_he, error.message); continue; }
        venueId = data.id;
      }
    } else {
      vExisting++;
      if (APPLY) {
        const patch = {};
        for (const k of ['website_url', 'events_url', 'facebook_url', 'instagram_url', 'chain', 'region', 'address']) if (v[k]) patch[k] = v[k];
        if (Object.keys(patch).length) await client.from('venues').update(patch).eq('id', venueId);
      }
    }
    venueIdByKey[v.key] = venueId || `(new:${v.key})`;
    if (APPLY && venueId) {
      const aliases = [...new Set([v.name_he, ...(v.aliases || [])])];
      // several spellings can normalize to the same key ("קניון איילון"/"איילון") - one row per key
      const seenNorm = new Set();
      const rows = aliases.map((a) => ({ alias: a, alias_normalized: normalizeVenueAlias(a), venue_id: venueId }))
        .filter((r) => r.alias_normalized && !seenNorm.has(r.alias_normalized) && seenNorm.add(r.alias_normalized));
      const { error } = await client.from('venue_aliases').upsert(rows, { onConflict: 'alias_normalized,venue_id' });
      if (error) console.error('alias upsert failed', v.name_he, error.message);
    }
  }
  console.log(`venues: ${vCreated} new, ${vExisting} existing`);

  const { data: existingSources } = await client.from('sources').select('id, seed_url, is_active');
  const byUrl = new Map((existingSources || []).map((s) => [s.seed_url.replace(/\/$/, ''), s]));
  let sCreated = 0, sUpdated = 0;
  const byStatus = {};
  for (const s of manifest.sources) {
    byStatus[s.status] = (byStatus[s.status] || 0) + 1;
    const inactiveReason = INACTIVE_STATUSES[s.status];
    const row = {
      name: s.name, seed_url: s.seed_url, type: s.type || 'html', region: s.region || null, categories: s.categories || [],
      scan_frequency_hours: s.scan_frequency_hours || 72, source_trust_score: s.source_trust_score ?? null, is_trusted: !!s.is_trusted,
      source_kind: s.source_kind || 'website', publisher_type: s.publisher_type || null, publisher_name: s.publisher_name || null,
      venue_id: s.venue ? (venueIdByKey[s.venue] && !String(venueIdByKey[s.venue]).startsWith('(new') ? venueIdByKey[s.venue] : null) : null,
      priority: s.priority || 5, strategy: s.strategy || 'generic_html',
      is_active: !inactiveReason, disabled_reason: inactiveReason ? (s.disabled_reason || inactiveReason) : null,
      health_status: inactiveReason ? 'auto_paused' : 'healthy',
      discovery_batch: BATCH || s.discovery_batch || null,
    };
    const existing = byUrl.get(s.seed_url.replace(/\/$/, ''));
    if (existing) {
      sUpdated++;
      if (APPLY) {
        // registry fields only - never re-activate/deactivate an existing row from the manifest
        // unless the manifest explicitly marks it non-scannable
        const { is_active, health_status, ...registryFields } = row;
        const patch = inactiveReason ? row : registryFields;
        const { error } = await client.from('sources').update(patch).eq('id', existing.id);
        if (error) console.error('source update failed', s.name, error.message);
      }
    } else {
      sCreated++;
      if (APPLY) {
        const { error } = await client.from('sources').insert({ ...row, created_by: userId, next_scan_at: new Date().toISOString() });
        if (error) console.error('source insert failed', s.name, error.message);
      }
    }
  }
  console.log(`sources: ${sCreated} new, ${sUpdated} existing updated; by manifest status:`, byStatus);
  if (!APPLY) console.log('\n(dry run) nothing written. Re-run with --apply.');
}

main().catch((e) => { console.error(e); process.exit(1); });
