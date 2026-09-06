import { View, Text, StyleSheet, Pressable, ImageBackground } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { colors, fonts, radii } from '../constants/theme';
import { StarIcon, HideIcon, CheckIcon, LocationPinIcon, ChevronLeftIcon } from './icons';

function ActionButton({ children, onPress }) {
  return (
    <Pressable style={styles.actionBtn} onPress={onPress} hitSlop={6}>{children}</Pressable>
  );
}

export default function ActivityCard({
  id,
  title,
  type,
  distance,
  ageRange,
  price,
  hours,
  gradient,
  imageUrl,
  recommendedBy,
  requiresTicket = false,
  benefitTag = null,
  favorite = false,
  visited = false,
  onToggleFavorite,
  onToggleVisited,
  onHide,
}) {
  const router = useRouter();

  const cardBg = favorite ? colors.accentTintLight : visited ? colors.greenTint : colors.card;
  const cardBorder = favorite ? colors.accentTint : visited ? '#a9e3b6' : colors.border;

  const stop = (fn) => (e) => { e.stopPropagation?.(); fn?.(); };

  const imageOverlay = (
    <>
      <View style={styles.topLeft}>
        <ActionButton onPress={stop(onHide)}><HideIcon size={14} /></ActionButton>
      </View>
      <View style={styles.topRight}>
        <ActionButton onPress={stop(onToggleFavorite)}><StarIcon size={14} filled={favorite} /></ActionButton>
      </View>
      {visited ? (
        <Pressable style={styles.visitedBadge} onPress={stop(onToggleVisited)} hitSlop={6}>
          <CheckIcon size={11} filled />
          <Text style={styles.visitedBadgeText}>כבר הייתי כאן</Text>
        </Pressable>
      ) : (
        <View style={styles.bottomRight}>
          <ActionButton onPress={stop(onToggleVisited)}><CheckIcon size={14} /></ActionButton>
        </View>
      )}
    </>
  );

  return (
    <Pressable
      style={[styles.card, { backgroundColor: cardBg, borderColor: cardBorder }]}
      onPress={() => router.push(`/activity/${id}`)}
    >
      {imageUrl ? (
        <ImageBackground source={{ uri: imageUrl }} style={styles.image}>
          {imageOverlay}
        </ImageBackground>
      ) : (
        <LinearGradient colors={gradient} style={styles.image}>
          {imageOverlay}
        </LinearGradient>
      )}

      <View style={styles.body}>
        <View style={styles.titleRow}>
          <Text style={styles.title}>{title}</Text>
          <View style={styles.typeBadge}>
            <Text style={styles.typeBadgeText}>{type}</Text>
          </View>
        </View>
        <View style={styles.metaRow}>
          <LocationPinIcon />
          <Text style={styles.metaText}>{distance}</Text>
        </View>
        {recommendedBy?.nickname ? (
          <View style={styles.recommendedRow}>
            <Text style={styles.recommendedText}>
              הומלץ ע"י <Text style={styles.recommendedName}>{recommendedBy.nickname}</Text> ⭐{recommendedBy.stars}
            </Text>
          </View>
        ) : null}
        <View style={styles.statsRow}>
          <View style={styles.statsGroup}>
            <Text style={styles.stat}>{ageRange}</Text>
            <Text style={[styles.stat, styles.statPrice]}>{price}</Text>
            <Text style={styles.stat}>{hours}</Text>
            {requiresTicket ? <Text style={styles.ticketBadge}>🎟️ כרטיס</Text> : null}
            {benefitTag ? <Text style={styles.benefitBadge} numberOfLines={1}>🏷️ {benefitTag}</Text> : null}
          </View>
          <ChevronLeftIcon />
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radii.lg,
    borderWidth: 1,
    overflow: 'hidden',
    marginBottom: 16,
  },
  image: { height: 158, position: 'relative' },
  topLeft: { position: 'absolute', top: 10, left: 10 },
  topRight: { position: 'absolute', top: 10, right: 10 },
  bottomRight: { position: 'absolute', bottom: 10, right: 10 },
  actionBtn: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.9)',
    alignItems: 'center', justifyContent: 'center',
  },
  visitedBadge: {
    position: 'absolute', bottom: 10, right: 10,
    flexDirection: 'row-reverse', alignItems: 'center', gap: 5,
    backgroundColor: 'rgba(255,255,255,0.92)', borderRadius: radii.pill,
    paddingVertical: 5, paddingHorizontal: 10,
  },
  visitedBadgeText: { fontFamily: fonts.bold, fontSize: 11.5, color: colors.greenStrong },
  body: { padding: 14 },
  titleRow: { flexDirection: 'row-reverse', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, marginBottom: 8 },
  title: { flex: 1, fontFamily: fonts.extraBold, fontSize: 16, color: colors.textPrimary, textAlign: 'right' },
  typeBadge: { backgroundColor: colors.accentTintLight, borderRadius: 7, paddingVertical: 4, paddingHorizontal: 9 },
  typeBadgeText: { fontFamily: fonts.bold, fontSize: 11.5, color: colors.accent },
  metaRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 6, marginBottom: 10 },
  metaText: { fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary },
  recommendedRow: { marginBottom: 10 },
  recommendedText: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.textMuted, textAlign: 'right' },
  recommendedName: { fontFamily: fonts.bold, color: colors.accent },
  statsRow: {
    flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between',
    paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.borderLight,
  },
  statsGroup: { flexDirection: 'row-reverse', alignItems: 'center', gap: 10, flexShrink: 1 },
  stat: { fontFamily: fonts.semiBold, fontSize: 12.5, color: colors.textPrimary },
  statPrice: { color: colors.greenStrong },
  ticketBadge: {
    fontFamily: fonts.bold, fontSize: 10.5, color: colors.warn, backgroundColor: '#fff1de',
    borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2,
  },
  // אייקון שונה מ-ticketBadge (🏷️ לא 🎟️) בכוונה - שני התגים יכולים להופיע יחד באותה שורה
  // (פעילות בתשלום שגם יש בה הטבה), ולא לבלבל "צריך לשלם" עם "יש הנחה".
  benefitBadge: {
    fontFamily: fonts.bold, fontSize: 10.5, color: colors.accent, backgroundColor: colors.accentTintLight,
    borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, flexShrink: 1,
  },
});
