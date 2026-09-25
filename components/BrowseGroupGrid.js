import { useState } from 'react';
import { View, Text, Pressable } from 'react-native';
import { colors, fonts, radii } from '../constants/theme';
import { useI18n, createStyles } from '../lib/i18n';
import { categoryLabel } from '../lib/i18n/format';
import { groupSelectionState, hasMemberLevel } from '../lib/browseGroups';
import { ChevronDownIcon } from './icons';

// Two-level category browsing (2026-09-25, browse groups) shared by QuickPicker (Home/Activities/
// Profile pickers) and FiltersSheet ("סוג פעילות"). Level 1 = browse-group tiles; level 2 = the
// group's canonical member chips, opened ONLY by the tile's own chevron (a separate, visible hit
// target - no long-press/double-tap). Two controls, two meanings:
//   tile body  -> onGroupPress(groupId)   (caller decides: toggle the whole group, or select+close)
//   member chip-> onMemberPress(category) (exact canonical choice)
// Groups without a meaningful second level (single member, or a member labelled exactly like the
// group - see hasMemberLevel) get no chevron. The selection itself is always the caller's canonical
// array (`value`); this component only renders its state: all / partial / none per group.
// Starts with the first partially selected group expanded, so an exact pick made earlier is visible.
export default function BrowseGroupGrid({ groups, options = [], value, onGroupPress, onMemberPress }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(
    () => groups.find((g) => hasMemberLevel(g.id) && groupSelectionState(g.id, value) === 'partial')?.id ?? null,
  );
  const emojiFor = (id) => options.find((o) => o.id === id)?.emoji;

  const rows = [];
  for (let i = 0; i < groups.length; i += 2) rows.push(groups.slice(i, i + 2));

  const renderTile = (group) => {
    const state = groupSelectionState(group.id, value);
    const expandable = hasMemberLevel(group.id);
    const isExpanded = expanded === group.id;
    const hits = group.members.filter((m) => value.includes(m)).length;
    return (
      <View
        key={group.id}
        style={[styles.tile, state === 'all' && styles.tileSelected, state === 'partial' && styles.tilePartial]}
      >
        <Pressable
          style={styles.tileMain}
          onPress={() => onGroupPress(group.id)}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: state === 'all' ? true : state === 'partial' ? 'mixed' : false }}
          accessibilityLabel={state === 'partial' ? `${group.label}, ${t('filters.browse.partial')}` : group.label}
        >
          <Text style={styles.tileEmoji}>{group.emoji}</Text>
          <Text style={[styles.tileText, state !== 'none' && styles.tileTextSelected]} numberOfLines={3}>
            {group.label}
          </Text>
        </Pressable>
        {state === 'partial' ? (
          <View style={styles.partialBadge} pointerEvents="none">
            <Text style={styles.partialBadgeText}>{`${hits}/${group.members.length}`}</Text>
          </View>
        ) : null}
        {expandable ? (
          <Pressable
            style={styles.chevronBtn}
            onPress={() => setExpanded(isExpanded ? null : group.id)}
            accessibilityRole="button"
            accessibilityState={{ expanded: isExpanded }}
            accessibilityLabel={t(isExpanded ? 'filters.browse.collapse' : 'filters.browse.expand', { group: group.label })}
          >
            <View style={{ transform: [{ rotate: isExpanded ? '180deg' : '0deg' }] }}>
              <ChevronDownIcon size={12} color={isExpanded ? colors.accent : colors.textSecondary} />
            </View>
          </Pressable>
        ) : null}
      </View>
    );
  };

  const renderMembers = (group) => (
    <View style={styles.memberPanel}>
      {group.members.map((id) => {
        const selected = value.includes(id);
        const emoji = emojiFor(id);
        return (
          <Pressable
            key={id}
            onPress={() => onMemberPress(id)}
            style={[styles.memberChip, selected && styles.memberChipSelected]}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: selected }}
            accessibilityLabel={categoryLabel(id)}
          >
            {emoji ? <Text style={styles.memberEmoji}>{emoji}</Text> : null}
            <Text style={[styles.memberText, selected && styles.tileTextSelected]}>{categoryLabel(id)}</Text>
          </Pressable>
        );
      })}
    </View>
  );

  return (
    <View>
      {rows.map((row) => {
        const open = row.find((g) => g.id === expanded && hasMemberLevel(g.id));
        return (
          <View key={row.map((g) => g.id).join('|')}>
            <View style={styles.row}>{row.map(renderTile)}</View>
            {open ? renderMembers(open) : null}
          </View>
        );
      })}
    </View>
  );
}

const styles = createStyles((d) => ({
  row: { flexDirection: d.row, justifyContent: 'space-between', marginBottom: 10 },
  // Same tokens as QuickPicker's iconRow / FiltersSheet's iconChip, so category choosing looks the
  // same everywhere; the chevron sits inside the tile as its own hit target.
  tile: {
    width: '48.5%', flexDirection: d.row, alignItems: 'center',
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg, borderRadius: radii.md,
  },
  tileSelected: { borderColor: colors.accent, backgroundColor: colors.accentTintLight },
  // Partial: accent outline without the full tint, plus the "2/3" badge - visibly "some of this".
  tilePartial: { borderColor: colors.accent, borderStyle: 'dashed' },
  tileMain: { flex: 1, minWidth: 0, flexDirection: d.row, alignItems: 'center', gap: 6, paddingVertical: 10, paddingHorizontal: 8 },
  tileEmoji: { fontSize: 18, width: 22, textAlign: 'center' },
  tileText: { flex: 1, fontFamily: fonts.semiBold, fontSize: 12.5, color: colors.textSecondary, textAlign: d.textAlign },
  tileTextSelected: { color: colors.accent, fontFamily: fonts.bold },
  // Sits on the tile's top edge (not inside the label row) so it never squeezes the group label.
  partialBadge: {
    position: 'absolute', top: -8, left: 10,
    backgroundColor: colors.accent, borderRadius: 8, paddingHorizontal: 5, paddingVertical: 1,
  },
  partialBadgeText: { fontFamily: fonts.bold, fontSize: 10, color: '#fff' },
  chevronBtn: { width: 32, minHeight: 40, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center' },
  memberPanel: {
    flexDirection: d.row, flexWrap: 'wrap', gap: 8, marginTop: -2, marginBottom: 12,
    padding: 10, borderRadius: radii.md, borderWidth: 1, borderColor: colors.borderLight, backgroundColor: colors.bg,
  },
  memberChip: {
    flexDirection: d.row, alignItems: 'center', gap: 5,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, borderRadius: radii.pill,
    paddingVertical: 7, paddingHorizontal: 11,
  },
  memberChipSelected: { borderColor: colors.accent, backgroundColor: colors.accentTintLight },
  memberEmoji: { fontSize: 14 },
  memberText: { fontFamily: fonts.semiBold, fontSize: 12.5, color: colors.textSecondary },
}));
