import { useState } from 'react';
import { Modal, View, Text, Pressable, StyleSheet, Platform, LayoutAnimation, UIManager } from 'react-native';
import * as Location from 'expo-location';
import { LocationPinIcon } from './icons';
import CityAutocomplete from './CityAutocomplete';
import { locationWithDrivingTime, locationWithAnyDistance } from '../lib/filterActivities';
import { WALKING_RADIUS_KM } from '../constants/filterSchema';
import { colors, fonts, radii, spacing } from '../constants/theme';

// אותה תשתית אנימציה בדיוק כמו components/FiltersSheet.js (LayoutAnimation מובנה ב-RN, לא
// ספרייה חדשה) - קריאה כפולה ל-setLayoutAnimationEnabledExperimental (כאן ובקובץ ההוא) לא
// מזיקה, אידמפוטנטי.
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}
const animate = () => LayoutAnimation.configureNext(LayoutAnimation.create(220, LayoutAnimation.Types.easeInEaseOut, LayoutAnimation.Properties.opacity));

// שלושה travel modes - siblings, בדיוק אחד יכול להיות active בכל רגע (mutual exclusivity,
// נאכף ב-onChange של כל handler למטה, לא רק ב-UI). "🚶 הליכה" נשאר 750 מטר קבועים
// (WALKING_RADIUS_KM, constants/filterSchema.js) - מרחק אמיתי, לא זמן שהומצא ממרחק. "🚗 נסיעה"
// נשאר display-only (travelMinutes לא ממופה ל-radiusKm אמיתי - לטורו אין מנוע ניווט/ETA, ראו
// ההערה המקבילה ב-app/activities.js ליד buildSpontaneousBadge). "לא משנה לי המרחק" (travelMode
// 'any') מסיר את אילוץ-המרחק המפורש לגמרי (lib/filterActivities.js: locationWithAnyDistance).
const DRIVING_TIME_OPTIONS = [10, 15, 30, 45];

export function locationSummary(location) {
  if (!location) return 'באזור שלי';
  if (location.travelMode === 'walking') {
    if (location.mode === 'current') return 'במרחק הליכה ממני';
    if (location.mode === 'address') return `במרחק הליכה מ${location.addressLabel || location.city || ''}`.trim();
  }
  if (location.travelMode === 'any') return 'בכל האזור';
  // travelMinutes נבדק רק כש-travelMode==='driving' בפועל - הוא עשוי להישאר "זכור" ברקע גם
  // כש-travelMode הוא 'walking'/'any' (כדי לשחזר את הבחירה האחרונה אם חוזרים ל-driving), אז
  // typeof-check לבד לא מספיק - בלי תנאי ה-travelMode כאן, summary היה מציג "עד X דק'" גם
  // כשבפועל לא זו הבחירה הפעילה.
  if (location.travelMode === 'driving' && typeof location.travelMinutes === 'number') {
    if (location.mode === 'current') return `עד ${location.travelMinutes} דק' ממני`;
    if (location.mode === 'city' && location.city) return `עד ${location.travelMinutes} דק' מ${location.city}`;
    if (location.mode === 'address') return `עד ${location.travelMinutes} דק' מ${location.addressLabel || location.city || ''}`.trim();
    if (location.mode === 'region' && location.region?.length) return `עד ${location.travelMinutes} דק' מ${location.region.join(', ')}`;
  }
  if (location.mode === 'current') return 'המיקום שלי';
  if (location.mode === 'city' && location.city) return location.city;
  // 'address' - כתובת מגואוקדדת מ"חיפוש חכם" (lib/smartSearch.js) - addressLabel כבר מוכן
  // לתצוגה ("הרצל, תל אביב"), עדיין נופל בחזרה לעיר/"באזור שלי" אם חסר משהו.
  if (location.mode === 'address') return location.addressLabel || location.city || 'באזור שלי';
  if (location.mode === 'region' && location.region?.length) return location.region.join(', ');
  return 'באזור שלי';
}

// "נבחר מיקום תקין" - אותו סף בדיוק שהיה קיים תמיד באפליקציה (mode+city לא ריקים), לא validation
// חדש מול רשימת הערים: constants/israeliCities.js מתעד בפירוש שהשדה טקסט-חופשי גם ליישובים
// שלא ברשימה, אז דרישת "match מדויק" הייתה חוסמת יישובים אמיתיים.
function isValidLocation(loc) {
  return loc.mode === 'current' || (loc.mode === 'city' && !!(loc.city || '').trim()) || (loc.mode === 'address' && !!loc.coords);
}

// "precise" (למטרת 🚶 הליכה בלבד) - חמור יותר מ-isValidLocation: city-mode תקין-לחיפוש-רגיל
// (matchesLocation ב-lib/filterActivities.js מתאים לפי שם-עיר, בלי GPS בכלל), אבל אין לו
// נקודת-מוצא מדויקת מספיק לחיפוש-רדיוס של 750 מטר - חיפוש כזה ממרכז-עיר מלאכותי היה מטעה.
// מצב 'current' נחשב מדויק רק אם באמת יש deviceCoords שהתקבלו (לא סתם permission שאושר) - אחרת
// הרשאה שנדחתה/GPS לא זמין הייתה משאירה "הליכה" זמינה כשבפועל matchesLocation לא מסנן כלום.
function isPreciseLocation(loc, deviceCoords) {
  if (loc.mode === 'current') return !!deviceCoords;
  if (loc.mode === 'address') return !!loc.coords;
  return false;
}

// שורה/כרטיס משותף ל-🚶 הליכה ו-🚗 נסיעה - אותה שפה עיצובית בדיוק (border/רקע/טיפוגרפיה) כדי
// ששתי האפשרויות ירגישו כמו siblings, לא שכפול-markup (בקשת המשתמש: "extract/reuse a shared
// selectable travel-mode component"). children (למשל צ'יפי הדקות של נסיעה) מוצג בתוך אותו
// כרטיס ממש - לא מתחתיו כבלוק נפרד - כדי שהבחירה+ההרחבה יקראו כיחידה חזותית אחת.
function TravelModeOption({ icon, title, subtitle, selected, disabled, hint, onPress, children }) {
  return (
    <View style={styles.travelOptionWrap}>
      <View style={[styles.travelCard, selected && styles.travelCardSelected, disabled && styles.travelCardDisabled]}>
        <Pressable onPress={onPress} disabled={disabled} style={styles.travelCardHeader}>
          <Text style={styles.travelEmoji}>{icon}</Text>
          <View style={styles.travelTextStack}>
            <Text style={[styles.travelTitleText, selected && styles.travelTitleTextSelected]}>{title}</Text>
            {subtitle ? <Text style={styles.travelSubtitleText}>{subtitle}</Text> : null}
          </View>
        </Pressable>
        {children}
      </View>
      {hint ? <Text style={styles.walkHint}>{hint}</Text> : null}
    </View>
  );
}

export default function LocationQuickPicker({ visible, value, onChange, onCoordsResolved, onClose, deviceCoords }) {
  const [busy, setBusy] = useState(false);

  // מגדיר ברירת מחדל של נסיעה+15 דקות ברגע שהמיקום הופך לתקין לראשונה (travelMode עדיין
  // undefined) - אם כבר יש בחירה, לא דורסים אותה. זה גם המקום שמבטל "🚶 הליכה" אם המיקום השתנה
  // למשהו שכבר לא מדויק מספיק (city-level) - נופל בחזרה לאותה ברירת-מחדל בדיוק (נסיעה, הזמן
  // האחרון שנבחר או 15), במקום להשאיר "אין בחירה" שהיה דורש מהמשתמש ללחוץ שוב. "any" לא צריך
  // guard דומה - הוא valid גם ב-city וגם ב-precise (סעיפים 12/13 בבקשה), אף פעם לא נפסל.
  const commitLocation = (next) => {
    animate();
    let out = next;
    if (isValidLocation(out)) {
      if (out.travelMode === 'walking' && !isPreciseLocation(out, deviceCoords)) {
        out = locationWithDrivingTime(out, out.travelMinutes !== undefined ? out.travelMinutes : 15);
      } else if (out.travelMode === undefined) {
        out = locationWithDrivingTime(out, 15);
      }
    }
    onChange(out);
  };

  const useCurrentLocation = async () => {
    setBusy(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status === 'granted') {
        const pos = await Location.getCurrentPositionAsync({});
        onCoordsResolved({ latitude: pos.coords.latitude, longitude: pos.coords.longitude });
      }
      commitLocation({ ...value, mode: 'current' });
    } catch {
      commitLocation({ ...value, mode: 'current' });
    }
    setBusy(false);
  };

  const precise = isPreciseLocation(value, deviceCoords);
  const travelMode = value.travelMode;

  const selectWalking = () => {
    if (!precise) return;
    animate();
    onChange({ ...value, travelMode: 'walking', radiusKm: WALKING_RADIUS_KM });
  };

  // לחיצה על כותרת "🚗 בנסיעה" עצמה (לא על צ'יפ ספציפי) - בוחרת driving ומשחזרת את זמן הנסיעה
  // האחרון שנבחר (אם יש), אחרת נופלת ל-15 (ברירת המחדל בפעם הראשונה) - סעיף 6 בבקשה: "אם
  // architecture הקיימת מאפשרת זאת בצורה פשוטה, זכור driving time אחרון" - זה בדיוק המקום,
  // travelMinutes כבר לא נמחק אף פעם בעת מעבר ל-walking/any, אז הוא פשוט מחכה כאן.
  const selectDriving = () => {
    animate();
    onChange(locationWithDrivingTime(value, value.travelMinutes !== undefined ? value.travelMinutes : 15));
  };

  const selectDrivingMinutes = (minutes) => {
    animate();
    onChange(locationWithDrivingTime(value, minutes));
  };

  const selectAnyDistance = () => {
    animate();
    onChange(locationWithAnyDistance(value));
  };

  const locationValid = isValidLocation(value);
  const ctaValid = locationValid && (travelMode !== 'walking' || precise);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.card} onPress={(e) => e.stopPropagation()}>
          <Text style={styles.title}>איפה נוח לכם? 📍</Text>
          <Text style={styles.subtitle}>נמצא פעילויות באזור שמתאים לכם</Text>

          <Pressable style={[styles.modeBtn, value.mode === 'current' && styles.modeBtnActive]} onPress={useCurrentLocation} disabled={busy}>
            <LocationPinIcon size={14} color={value.mode === 'current' ? colors.accent : colors.textSecondary} />
            <Text style={[styles.modeBtnText, value.mode === 'current' && styles.modeBtnTextActive]}>
              {busy ? 'מאתר...' : 'השתמשו במיקום שלי'}
            </Text>
          </Pressable>

          <Text style={styles.orText}>או</Text>

          <CityAutocomplete
            inputStyle={styles.input}
            placeholder="הזינו עיר או יישוב..."
            value={value.mode === 'city' ? value.city : ''}
            onChangeText={(t) => commitLocation({ ...value, mode: t ? 'city' : null, city: t })}
            onSubmitEditing={onClose}
          />

          {locationValid ? (
            <View style={styles.travelSection}>
              <Text style={styles.travelTitle}>איך וכמה רחוק מתאים לכם?</Text>

              <TravelModeOption
                icon="🚶"
                title="במרחק הליכה"
                subtitle="עד כ-10 דקות הליכה"
                selected={travelMode === 'walking'}
                disabled={!precise}
                hint={!precise ? 'כדי לחפש במרחק הליכה, השתמשו במיקום הנוכחי או בכתובת מדויקת' : null}
                onPress={selectWalking}
              />

              <TravelModeOption
                icon="🚗"
                title="בנסיעה"
                subtitle={travelMode === 'driving' && typeof value.travelMinutes === 'number' ? `עד ${value.travelMinutes} דקות נסיעה` : null}
                selected={travelMode === 'driving'}
                onPress={selectDriving}
              >
                {travelMode === 'driving' ? (
                  <View style={styles.chipsWrap}>
                    {DRIVING_TIME_OPTIONS.map((minutes) => {
                      const selected = value.travelMinutes === minutes;
                      return (
                        <Pressable key={minutes} onPress={() => selectDrivingMinutes(minutes)} style={[styles.chip, selected && styles.chipSelected]}>
                          <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{minutes} דק'</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                ) : null}
              </TravelModeOption>

              <Pressable onPress={selectAnyDistance} style={[styles.anyRow, travelMode === 'any' && styles.anyRowSelected]}>
                <Text style={[styles.anyRowText, travelMode === 'any' && styles.anyRowTextSelected]}>לא משנה לי המרחק</Text>
              </Pressable>
            </View>
          ) : null}

          <Pressable style={[styles.doneBtn, !ctaValid && styles.doneBtnDisabled]} onPress={onClose} disabled={!ctaValid || busy}>
            <Text style={styles.doneBtnText}>הציגו לי פעילויות</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(20,30,35,0.4)', justifyContent: 'center', padding: spacing.xl },
  card: { backgroundColor: colors.card, borderRadius: radii.xl, padding: spacing.xl },
  title: { fontFamily: fonts.extraBold, fontSize: 17, color: colors.textPrimary, textAlign: 'center' },
  subtitle: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.textSecondary, textAlign: 'center', marginTop: 4, marginBottom: 18 },
  modeBtn: {
    flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'center', gap: 8,
    borderWidth: 1.5, borderColor: colors.border, borderRadius: radii.pill, paddingVertical: 12,
  },
  modeBtnActive: { borderColor: colors.accent, backgroundColor: colors.accentTintLight },
  modeBtnText: { fontFamily: fonts.bold, fontSize: 13.5, color: colors.textSecondary },
  modeBtnTextActive: { color: colors.accent },
  orText: { fontFamily: fonts.semiBold, fontSize: 12, color: colors.textMuted, textAlign: 'center', marginVertical: 12 },
  input: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, padding: 12,
    fontFamily: fonts.regular, fontSize: 14, color: colors.textPrimary, backgroundColor: colors.bg,
  },
  travelSection: { marginTop: 18, paddingTop: 16, borderTopWidth: 1, borderTopColor: colors.borderLight },
  travelTitle: { fontFamily: fonts.bold, fontSize: 13.5, color: colors.textPrimary, textAlign: 'center', marginBottom: 12 },

  travelOptionWrap: { marginBottom: 10 },
  travelCard: {
    borderWidth: 1.5, borderColor: colors.border, borderRadius: radii.lg, padding: 12, overflow: 'hidden',
  },
  travelCardSelected: { borderColor: colors.accent, backgroundColor: colors.accentTintLight },
  travelCardDisabled: { opacity: 0.45 },
  travelCardHeader: { flexDirection: 'row-reverse', alignItems: 'center', gap: 10 },
  travelEmoji: { fontSize: 19 },
  travelTextStack: { alignItems: 'flex-end', flex: 1 },
  travelTitleText: { fontFamily: fonts.bold, fontSize: 13.5, color: colors.textSecondary },
  travelTitleTextSelected: { color: colors.accent },
  travelSubtitleText: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.textMuted, marginTop: 1 },
  walkHint: { fontFamily: fonts.regular, fontSize: 11, color: colors.textMuted, textAlign: 'center', marginTop: 6 },

  chipsWrap: { flexDirection: 'row-reverse', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  chip: {
    backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border,
    borderRadius: radii.pill, paddingVertical: 9, paddingHorizontal: 14,
  },
  chipSelected: { backgroundColor: colors.accentTintLight, borderColor: colors.accent },
  chipText: { fontFamily: fonts.semiBold, fontSize: 12.5, color: colors.textSecondary },
  chipTextSelected: { color: colors.accent, fontFamily: fonts.bold },

  anyRow: {
    alignSelf: 'center', borderWidth: 1.5, borderColor: colors.border, borderRadius: radii.pill,
    paddingVertical: 9, paddingHorizontal: 18, marginTop: 4,
  },
  anyRowSelected: { borderColor: colors.accent, backgroundColor: colors.accentTintLight },
  anyRowText: { fontFamily: fonts.semiBold, fontSize: 12.5, color: colors.textSecondary },
  anyRowTextSelected: { color: colors.accent, fontFamily: fonts.bold },

  doneBtn: { marginTop: 18, backgroundColor: colors.accent, borderRadius: radii.pill, paddingVertical: 13, alignItems: 'center' },
  doneBtnDisabled: { opacity: 0.4 },
  doneBtnText: { fontFamily: fonts.bold, fontSize: 14, color: '#fff' },
});
