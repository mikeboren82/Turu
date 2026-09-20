import { memo } from 'react';
import { View, Text, Pressable, ImageBackground } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { colors, fonts, radii } from '../constants/theme';
import { StarIcon, HideIcon, CheckIcon, NoteIcon, LocationPinIcon, ChevronLeftIcon } from './icons';
import { placeholderImageFor, placeholderBgColorFor } from '../lib/placeholderImages';
import { useI18n, createStyles } from '../lib/i18n';
import { categoryLabel, placeName } from '../lib/i18n/format';

function ActionButton({ children, onPress, accessibilityLabel }) {
  return (
    <Pressable style={styles.actionBtn} onPress={onPress} hitSlop={6} accessibilityRole="button" accessibilityLabel={accessibilityLabel}>{children}</Pressable>
  );
}

// React.memo (2026-09-20, "Performance Phase 1" audit סעיף 4A) - בלי זה, כל כרטיס נבנה-מחדש
// בכל רינדור של הרשימה כולה, גם כשאף prop שלו לא השתנה בפועל (ה-audit מדד ~118ms תקיעת-thread
// על סימון-מועדף/ביקרתי בודד ברשימה של אלפי כרטיסים). ההשוואה הרדודה-כברירת-מחדל של memo
// מספיקה: כל ה-props המועברים כאן הם primitives (מחרוזות/booleans/מספרים) חוץ מ-recommendedBy/
// gradient - שניהם references שנשארים יציבים בין רינדורים כשהפעילות עצמה לא השתנתה (ראו
// app/activities.js#filteredActivities: השכבה היקרה שמחשבת distance/matchReason/gradient
// מופרדת מהשכבה הזולה שרק מצרפת favorite/visited/hasNote - כך שלכרטיסים לא-קשורים כל
// ה-props נשארים === בין רינדורים, וה-memo חוסך את כל עץ-ה-JSX למטה).
// onToggleFavorite/onToggleVisited/onOpenNote/onHide (חדש - שינוי-API) מקבלים עכשיו את ה-id
// (ואת title, ל-onOpenNote) כפרמטר בזמן-הקריאה, במקום שה-parent יעטוף כל אחד ב-closure חדש
// per-item per-render (`() => handleToggleFavorite(a.id)`); ה-parent מזין את אותה פונקציה
// יציבה בדיוק (useCallback) לכל הכרטיסים - שם ה-reference חייב להישאר קבוע כדי ש-memo יעבוד.
function ActivityCard({
  id,
  title,
  type,
  distance,
  city = null,
  ageRange,
  min_age = null,
  max_age = null,
  price,
  hours,
  gradient,
  imageUrl,
  placeholderGroup,
  recommendedBy,
  requiresTicket = false,
  benefitTag = null,
  matchReason = null,
  favorite = false,
  visited = false,
  hasNote = false,
  onToggleFavorite,
  onToggleVisited,
  onOpenNote,
  onHide,
}) {
  const router = useRouter();
  const { t, dir } = useI18n();
  const cityDisplay = city ? placeName(city) : null;

  const cardBg = favorite ? colors.accentTintLight : visited ? colors.greenTint : colors.card;
  const cardBorder = favorite ? colors.accentTint : visited ? '#a9e3b6' : colors.border;

  const stop = (fn) => (e) => { e.stopPropagation?.(); fn?.(); };
  // העיר תמיד מוצגת, אלא אם כבר כתובה בשורת המיקום עצמה. בלי מקור-מרחק, formatDistance מציג
  // קודם את הכתובת (למשל "פבזנר") ורק אחריה את העיר - כתובת לבד לא אומרת באיזו עיר מדובר.
  const showCityLine = !!city && !String(distance ?? '').includes(city) && !String(distance ?? '').includes(cityDisplay);

  const imageOverlay = (
    <>
      <View style={styles.topLeft}>
        <ActionButton onPress={stop(() => onHide?.(id))} accessibilityLabel={t('activities.card.a11y.hide')}><HideIcon size={14} /></ActionButton>
      </View>
      {/* עמודה אנכית אחת בצד ימין: מועדפים למעלה, "כבר הייתי כאן" באמצע, הערה למטה - סדר
          שהמשתמש ביקש במפורש. "כבר הייתי כאן" עבר מתג-טקסט רחב לכפתור עגול תמציתי כמו שני
          האחרים (filled ירוק כשמסומן, כמו ש-StarIcon כבר עושה ל-favorite) כדי שהעמודה תישאר
          קומפקטית ואחידה. */}
      <View style={styles.rightStack}>
        <ActionButton onPress={stop(() => onToggleFavorite?.(id))} accessibilityLabel={t(favorite ? 'activities.card.a11y.unfavorite' : 'activities.card.a11y.favorite')}><StarIcon size={14} filled={favorite} /></ActionButton>
        <ActionButton onPress={stop(() => onToggleVisited?.(id))} accessibilityLabel={t(visited ? 'activities.card.a11y.unvisited' : 'activities.card.a11y.visited')}><CheckIcon size={14} filled={visited} /></ActionButton>
        <ActionButton onPress={stop(() => onOpenNote?.(id, title))} accessibilityLabel={t('activities.card.a11y.note')}><NoteIcon size={14} color={hasNote ? colors.accent : colors.textPrimary} /></ActionButton>
      </View>
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
      ) : placeholderImageFor(placeholderGroup, id) ? (
        <ImageBackground
          source={placeholderImageFor(placeholderGroup, id)}
          resizeMode="contain"
          style={[styles.image, { backgroundColor: placeholderBgColorFor(placeholderGroup) }]}
        >
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
            <Text style={styles.typeBadgeText}>{categoryLabel(type)}</Text>
          </View>
        </View>
        {/* שם היישוב מתחת לשורת המיקום - ראו showCityLine. city מגיע ב-{...a} מ-mapActivityRow. */}
        <View style={[styles.metaRow, showCityLine && styles.metaRowWithCity]}>
          <LocationPinIcon />
          <Text style={styles.metaText}>{distance}</Text>
        </View>
        {showCityLine ? <Text style={styles.cityText} numberOfLines={1}>{cityDisplay}</Text> : null}
        {recommendedBy?.nickname ? (
          <View style={styles.recommendedRow}>
            <Text style={styles.recommendedText}>
              {t('activities.card.recommendedByPrefix')}<Text style={styles.recommendedName}>{recommendedBy.nickname}</Text> ⭐{recommendedBy.stars}
            </Text>
          </View>
        ) : null}
        <View style={styles.statsRow}>
          <View style={styles.statsGroup}>
            {/* גיל-לא-ידוע לגמרי (min_age/max_age שניהם null) מושמט לגמרי מהכרטיס - לא מוצג
                "לא צוין"/"כל הגילאים" (2026-09-20, "reliability pass" audit סעיף 2: "ACTIVITY
                CARDS: omit the age label when age information is completely unknown"). statsGroup
                מבוסס gap (לא מפרידי-"·" ידניים), אז השמטת ה-Text כאן פשוט מכווצת את הרווח בלי
                תו-הפרדה יתום. כל טווח-גיל אמיתי (גם חלקי, min בלבד/max בלבד) עדיין מוצג כרגיל -
                ageRange עצמו (lib/activities.js#formatAgeRange) כבר מטפל בהבחנה בין "לא הוזן" ל
                "הוזן חלקית". */}
            {min_age != null || max_age != null ? <Text style={styles.stat}>{ageRange}</Text> : null}
            <Text style={[styles.stat, styles.statPrice]}>{price}</Text>
            <Text style={styles.stat}>{hours}</Text>
            {requiresTicket ? <Text style={styles.ticketBadge}>{t('activities.card.ticket')}</Text> : null}
            {benefitTag ? <Text style={styles.benefitBadge} numberOfLines={1}>🏷️ {benefitTag}</Text> : null}
          </View>
          <View style={{ transform: [{ rotate: dir.forwardRotate }] }}><ChevronLeftIcon /></View>
        </View>
        {/* "✓ למה זה מתאים" - שורה משותפת אחת (lib/matchReasons.js), לא שתי שורות-הסבר
            מקבילות: ספונטני פעיל מעביר את buildSpontaneousBadge (פתוח-עכשיו/נפתח-בקרוב +
            דורש-הזמנה), אחרת buildMatchReasons (התאמת-גיל לילדים שנבחרו + פתוח-עכשיו/ללא-
            הרשמה) - שני ה-caller-ים (app/index.js, app/activities.js) בוחרים איזה מהשניים
            להזין ל-prop הזה, ה-Text כאן רק מציג מה שקיבל. null כשאין הסבר מבוסס - בלי שורה/
            רווח ריק. */}
        {matchReason ? (
          <View style={styles.matchReasonRow}>
            <Text style={styles.matchReasonText}>{matchReason}</Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

export default memo(ActivityCard);

const styles = createStyles((d) => ({
  card: {
    borderRadius: radii.lg,
    borderWidth: 1,
    overflow: 'hidden',
    marginBottom: 16,
  },
  image: { width: '100%', height: 158, position: 'relative' },
  topLeft: { position: 'absolute', top: 10, [d.end]: 10 },
  rightStack: { position: 'absolute', top: 10, [d.start]: 10, gap: 8 },
  actionBtn: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.9)',
    alignItems: 'center', justifyContent: 'center',
  },
  body: { padding: 14 },
  titleRow: { flexDirection: d.row, alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, marginBottom: 8 },
  title: { flex: 1, fontFamily: fonts.extraBold, fontSize: 16, color: colors.textPrimary, textAlign: d.textAlign },
  typeBadge: { backgroundColor: colors.accentTintLight, borderRadius: 7, paddingVertical: 4, paddingHorizontal: 9 },
  typeBadgeText: { fontFamily: fonts.bold, fontSize: 11.5, color: colors.accent },
  metaRow: { flexDirection: d.row, alignItems: 'center', gap: 6, marginBottom: 10 },
  metaText: { fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary },
  // כששורת-עיר מוצגת מתחת, המרווח התחתון עובר אליה (שתי השורות נקראות כיחידת-מיקום אחת);
  // paddingRight מיישר את שם העיר מתחת לטקסט המרחק, לא מתחת לאייקון הסיכה (row-reverse: הסיכה מימין).
  metaRowWithCity: { marginBottom: 2 },
  cityText: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.textMuted, textAlign: d.textAlign, [d.isRTL ? 'paddingRight' : 'paddingLeft']: 22, marginBottom: 10 },
  recommendedRow: { marginBottom: 10 },
  recommendedText: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.textMuted, textAlign: d.textAlign },
  recommendedName: { fontFamily: fonts.bold, color: colors.accent },
  statsRow: {
    flexDirection: d.row, alignItems: 'center', justifyContent: 'space-between',
    paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.borderLight,
  },
  statsGroup: { flexDirection: d.row, alignItems: 'center', gap: 10, flexShrink: 1 },
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
  matchReasonRow: {
    marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: colors.borderLight,
  },
  matchReasonText: { fontFamily: fonts.semiBold, fontSize: 11.5, color: colors.accent, textAlign: d.textAlign },
}));
