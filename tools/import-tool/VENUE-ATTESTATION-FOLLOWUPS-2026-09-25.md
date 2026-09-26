# Generic venue attestation — production data follow-ups (2026-09-25)

Code: branch `venue-resolver-r3` (c0a2e5b + "fix: require explicit generic venue attestation"). Nothing below was
executed at the time; every item was a future, separately-approved data action. Ledger = `PHASE1-GOLDEN-CASES-REPAIR-LEDGER-2026-09-25.md`.

**Status 2026-09-26:** R3 is on MAIN (a0a19fc) and live (scan-source v92). Repair Batch F Part 1 (`cleanup-batch-f1-2026-09-26.js`,
reports `reports/cleanup-batch-f1-2026-09-26-*.json`) APPLIED E-1 (revoked), E-1b, E-21 (+E-21b manifest); E-22 no write.

## Semantics now in code

A `venue_aliases` row whose `alias_normalized` is a generic library key (`ספרייה`, `ספריה`, `ספרייה עירונית`,
`ספריה עירונית`, `ספרייה העירונית`, `ספריה העירונית`) is a **human attestation**: "in this city, this generic label may
refer to this venue". `resolveVenue` resolves a generic label + city only to the single active, non-merged
`venue_type='library'` venue in exactly that city (`sameCityStrict`) carrying such an alias. No city => null. Venue
counts never count. The venue learner, merge carry-over and manifest re-seed can no longer create one; the explicit
admin alias endpoint (`POST /api/venues/:id/alias`) still can.

## Items

| id | object | today | decision needed | order |
|---|---|---|---|---|
| E-1 (re-scoped) — **APPLIED 2026-09-26: REVOKED** (both rows deleted; the 2 open RH incoming rows lost their stale `extracted_data.venue_id`) | `venue_aliases` `ספרייה` + `ספרייה העירונית` on 6801a6f3 (הספרייה העירונית רמת השרון) | present = Ramat HaSharon is ATTESTED under the new code | keep or delete. Deleting un-binds future RH generic-label story hours (they publish with `venue_id=null`). Owner direction: do NOT automatically re-confirm the attestation; decide only after the code deploy is reviewed | after deploy + verification of this code |
| E-1b — **APPLIED 2026-09-26** (manifest now lists only `ספריית רמת השרון`) | `source-manifest.json` `ramat_hasharon_library.aliases` lists `ספרייה`, `הספרייה`, `הספרייה העירונית` | inert: `seed-venues-and-sources.js` now drops generic aliases and logs them | remove from the manifest when E-1 is decided, so the file says what the data says | with E-1 |
| E-21 (new) — **APPLIED 2026-09-26** (alias deleted, evidence re-verified: 0 dependents; E-21b removed it from the manifest `ks_children_library` entry too) | `venue_aliases` `הספרייה העירונית כפר סבא` (normalized `ספרייה העירונית כפר סבא`) on 10f003b0 (ספריית הילדים והנוער כפר סבא) | specific alias, binds through the normal path (pinned as documented behaviour in `venues.cases.json`) | forensic: likely wrong — the municipal library is not the children's & youth library. Review before Phase 1 apply; do not delete without review | before Phase 1 apply |
| E-22 (new) — unchanged, no write (2026-09-26) | Kiryat Ata f5357010 (הספרייה העירונית קריית אתא) | not attested; 2 incoming rows labelled `ספרייה עירונית` stay unbound | do NOT add an attestation; the event-specific printed address is for the future row-address ladder stage | — |
| note | `POST /api/venues` stores `name_he` as an alias | an admin who names a venue generically ("הספרייה העירונית") attests it implicitly | admin path, left unchanged (not automated); name venues specifically | — |
