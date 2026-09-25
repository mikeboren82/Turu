// User-facing browse groups (2026-09-25) - a PRESENTATION-ONLY layer over canonical categories.
// constants/browseGroups.json is the data contract (see its _doc); this file holds the pure helpers
// every category picker/summary uses. Nothing here is stored, sent to search/ingestion, or shown as
// an activity's own category: filters.category stays an array of canonical strings, cards/detail/
// placeholders keep reading activity.category through categoryLabel(). No side effects, no React.
import browseGroupsData from '../constants/browseGroups.json';
import { t, listJoin } from './i18n';
import { categoryLabel } from './i18n/format';

const GROUPS = [...browseGroupsData.groups].sort((a, b) => a.order - b.order);
const GROUP_BY_ID = new Map(GROUPS.map((g) => [g.id, g]));
const GROUP_BY_MEMBER = new Map(GROUPS.flatMap((g) => g.members.map((m) => [m, g.id])));
const INTERNAL = new Set(browseGroupsData.internal);

// Canonical value -> group id. Internal ('אחר'/'חוג'/'קייטנה') and unknown/stale values -> null:
// they have no browse entry and are never surfaced by the browse UI.
export function groupOf(category) {
  return GROUP_BY_MEMBER.get(category) ?? null;
}

// Group id -> a fresh copy of its canonical members (callers may keep/mutate it). Unknown id -> [].
export function membersOf(groupId) {
  const group = GROUP_BY_ID.get(groupId);
  return group ? [...group.members] : [];
}

export function isInternalCategory(category) {
  return INTERNAL.has(category);
}

export function browseGroupLabel(groupId) {
  return t(`domain.browseGroups.${groupId}`);
}

// 'all' | 'partial' | 'none' - how much of one group the canonical selection covers. Values that are
// not members of this group (other groups, internal, stale) never influence the answer.
export function groupSelectionState(groupId, selectedCategories) {
  const members = GROUP_BY_ID.get(groupId)?.members || [];
  const selected = new Set(selectedCategories || []);
  const hits = members.filter((m) => selected.has(m)).length;
  if (members.length > 0 && hits === members.length) return 'all';
  return hits > 0 ? 'partial' : 'none';
}

export function isCompleteGroupSelection(groupId, selectedCategories) {
  return groupSelectionState(groupId, selectedCategories) === 'all';
}

// Group tile tap: fully selected -> remove all its members; none/partial -> add the missing members
// (a partial group is completed, never cleared). Every other value in the array - other groups,
// exact canonical picks, stale/internal values from old saved filters - is preserved in place.
// Never collapses a large selection to [] ("all"): [] is only produced when nothing is left.
export function toggleGroupSelection(groupId, selectedCategories) {
  const current = selectedCategories || [];
  const members = GROUP_BY_ID.get(groupId)?.members || [];
  if (isCompleteGroupSelection(groupId, current)) return current.filter((v) => !members.includes(v));
  return [...current, ...members.filter((m) => !current.includes(m))];
}

// Exact canonical chip tap (level 2) - the same toggle every category chip has always done.
export function toggleCategorySelection(category, selectedCategories) {
  const current = selectedCategories || [];
  return current.includes(category) ? current.filter((v) => v !== category) : [...current, category];
}

// Does this group get a second (member-chip) level? Not when it has one member (cinema, nature), and
// not when a member displays under the very same label as the group (festivals_events: its main
// member פעילות קהילתית is labelled "פסטיבלים ואירועים" since a0fc65c) - that level would be a
// useless duplicate of the tile the user just saw.
export function hasMemberLevel(groupId) {
  const group = GROUP_BY_ID.get(groupId);
  if (!group || group.members.length < 2) return false;
  const label = browseGroupLabel(groupId);
  return !group.members.some((m) => categoryLabel(m) === label);
}

// Picker options: id/emoji/members from the JSON, label a locale-aware getter (same pattern as
// CATEGORY_OPTIONS in constants/filterSchema.js).
export const BROWSE_GROUP_OPTIONS = GROUPS.map((g) => Object.defineProperty(
  { id: g.id, emoji: g.emoji, members: [...g.members], homeDefault: !!g.homeDefault, order: g.order },
  'label',
  { enumerable: true, get: () => browseGroupLabel(g.id) },
));

// The fixed Home "מה עוד מעניין אתכם?" tiles, in `order`. Static by design: never reordered by
// catalogue counts (coverage is ingestion-biased) or by session state.
export function homeDefaultGroups() {
  return BROWSE_GROUP_OPTIONS.filter((g) => g.homeDefault);
}

// Every MANUAL category change (browse group tap, member chip, "הכל") goes through here: a manual
// choice must not inherit the soft-recall alias phrases of an earlier Smart Search concept, or a
// browse union could over-recall through a stale alias. Shape of filters.category is unchanged.
export function withManualCategorySelection(filters, categories) {
  return { ...filters, category: [...(categories || [])], categoryAliasPhrases: [] };
}

// Browse-aware decomposition of a canonical selection, in first-selected order:
//   a group whose members are ALL selected -> one { kind: 'group' } item,
//   otherwise each selected member          -> one { kind: 'member' } item.
// A single-member group (cinema/nature) IS its canonical value, so it is always a 'member' item with
// the canonical label. Internal/unknown values never become items; they only count in hiddenCount.
export function browseSelectionItems(selectedCategories) {
  const selected = [...new Set(selectedCategories || [])];
  const items = [];
  const seenGroups = new Set();
  let hiddenCount = 0;
  for (const value of selected) {
    const groupId = groupOf(value);
    if (!groupId) { hiddenCount += 1; continue; }
    const members = GROUP_BY_ID.get(groupId).members;
    if (members.length > 1 && isCompleteGroupSelection(groupId, selected)) {
      if (seenGroups.has(groupId)) continue;
      seenGroups.add(groupId);
      items.push({ kind: 'group', id: groupId, members: [...members], label: browseGroupLabel(groupId) });
    } else {
      items.push({ kind: 'member', id: value, groupId, label: categoryLabel(value) });
    }
  }
  return { items, hiddenCount };
}

// Number of user-visible selection units (FiltersSheet badge): complete groups count once.
export function browseSelectionCount(selectedCategories) {
  const { items, hiddenCount } = browseSelectionItems(selectedCategories);
  return items.length + hiddenCount;
}

// Deterministic browse-aware summary (active chips, results phrase, profile default summary):
//   []                                  -> "הכל" (no category restriction - unchanged semantics)
//   one item                            -> its label (group label, or the canonical label)
//   only complete groups, 2             -> "A ו-B";  3+ -> "N קבוצות"
//   only exact members, <= 3            -> "a, b ו-c" (the pre-browse behaviour); 4+ -> "N קטגוריות"
//   complete group(s) + exact members   -> "first +N"
//   only internal/stale values          -> "N קטגוריות" (active, but no internal label is surfaced)
export function browseSummary(selectedCategories) {
  if (!selectedCategories || selectedCategories.length === 0) return t('domain.summary.all');
  const { items, hiddenCount } = browseSelectionItems(selectedCategories);
  if (items.length === 0) return t('domain.summary.categories', { count: hiddenCount });
  if (items.length === 1) return items[0].label;
  const labels = items.map((i) => i.label);
  const groups = items.filter((i) => i.kind === 'group').length;
  if (groups === items.length) {
    return items.length <= 2 ? listJoin(labels) : t('domain.summary.groups', { count: items.length });
  }
  if (groups === 0) {
    return items.length <= 3 ? listJoin(labels) : t('domain.summary.categories', { count: items.length });
  }
  return `${labels[0]} +${labels.length - 1}`;
}
