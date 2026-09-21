// TuRu - is a row eligible for the PUBLIC catalogue? Two independent axes, one answer.
//
//   COMMITMENT (unchanged, since 0041 / server.js shouldArchiveForCommitment): entity_type 'פעילות'
//   or an archiveCategories value (חוג, קייטנה) - TuRu shows only things a family can do without
//   enrolling.
//   ACCESS (Phase 1, 2026-09-21): a FINAL, human-confirmed offering_access_type of 'private_group'.
//   Never the model's proposal, never a keyword, never a missing schedule - only the value that a
//   reviewer explicitly wrote (lib/accessType.js approvalDecision).
//
// The two are deliberately not merged with category, entity granularity or missingTemporalEvidence.
// A 'חוג' is excluded by the commitment axis even if its access is 'public'; a birthday package is
// excluded by the access axis even though its category may be a perfectly good one.
const categoryValues = require('../../../constants/categoryValues.json');

const ARCHIVE_ENTITY_TYPES = new Set(['פעילות']);
const ARCHIVE_CATEGORIES = new Set(categoryValues.archiveCategories);

function isCommitmentActivity(a = {}) {
  return ARCHIVE_ENTITY_TYPES.has(a.entity_type) || ARCHIVE_CATEGORIES.has(a.category);
}
function isPrivateHire(a = {}) {
  return a.offering_access_type === 'private_group';
}
// -> { ineligible, reason: 'commitment_policy'|'private_hire_policy'|null, commitment, access }
//    commitment wins the reason when both apply, so existing rows keep exactly their old label.
function ineligibleForPublicCatalogue(a = {}) {
  const commitment = isCommitmentActivity(a);
  const access = isPrivateHire(a);
  return { ineligible: commitment || access, reason: commitment ? 'commitment_policy' : access ? 'private_hire_policy' : null, commitment, access };
}

module.exports = { ineligibleForPublicCatalogue, isCommitmentActivity, isPrivateHire, ARCHIVE_ENTITY_TYPES, ARCHIVE_CATEGORIES };
