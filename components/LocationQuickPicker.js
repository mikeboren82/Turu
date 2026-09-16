import { useState } from 'react';
import { Modal, View, Text, Pressable, Platform, LayoutAnimation, UIManager } from 'react-native';
import * as Location from 'expo-location';
import { LocationPinIcon, ChevronDownIcon } from './icons';
import CityAutocomplete from './CityAutocomplete';
import { locationWithDrivingTime, locationWithAnyDistance } from '../lib/filterActivities';
import { WALKING_RADIUS_KM, REGION_OPTIONS } from '../constants/filterSchema';
import { colors, fonts, radii, spacing } from '../constants/theme';
import { locationSummaryText, regionLabel } from '../lib/i18n/format';
import { useI18n, createStyles } from '../lib/i18n';

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
const DRIVING_TIME_OPTIONS = [15, 30, 45];

// "10" הוסר מהאפשרויות (מיוצג כבר ע"י 🚶 הליכה) - ערך ישן/זכור מ-state קודם נופל בחזרה ל-15
// בלי לשבור כלום, במקום להישאר "תקוע" על ערך שאין לו יותר צ'יפ תואם.
const normalizeDrivingMinutes = (minutes) => (DRIVING_TIME_OPTIONS.includes(minutes) ? minutes : 15);

// Full location summary in the active locale (see lib/i18n/format.js).
export function locationSummary(location) {
  return locationSummaryText(location);
}

// "נבחר מיקום תקין" - אותו סף בדיוק שהיה קיים תמיד באפליקציה (mode+city לא ריקים), לא validation
// חדש מול רשימת הערים: constants/israeliCities.js מתעד בפירוש שהשדה טקסט-חופשי גם ליישובים
// שלא ברשימה, אז דרישת "match מדויק" הייתה חוסמת יישובים אמיתיים. mode==='region' נוסף כדי
// לתמוך בבחירת אזור רחב (REGION_OPTIONS, בדיוק כמו ב-FiltersSheet) - locationSummary למעלה כבר
// ידע להציג אותו מזמן, רק אף UI כאן לא איפשר לבחור אותו.
function isValidLocation(loc) {
  return loc.mode === 'current' || (loc.mode === 'city' && !!(loc.city || '').trim())
    || (loc.mode === 'address' && !!loc.coords) || (loc.mode === 'region' && !!(loc.region || []).length)
    || loc.mode === 'nationwide';
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
        {/* הסיבה לחסימה (למשל "זמין כשמשתמשים במיקום מדויק") נשארת בתוך אותו כרטיס ממש - לא
            כפסקה נפרדת מתחתיו - כדי שהכרטיס+ההסבר ייקראו כיחידה חזותית אחת. */}
        {hint ? <Text style={styles.walkHint}>{hint}</Text> : null}
      </View>
    </View>
  );
}

export default function LocationQuickPicker({ visible, value, onChange, onCoordsResolved, onClose, deviceCoords }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [regionOpen, setRegionOpen] = useState(false);

  // מגדיר ברירת מחדל של נסיעה+15 דקות ברגע שהמיקום הופך לתקין לראשונה (travelMode עדיין
  // undefined) - אם כבר יש בחירה, לא דורסים אותה. זה גם המקום שמבטל "🚶 הליכה" אם המיקום השתנה
  // למשהו שכבר לא מדויק מספיק (city-level) - נופל בחזרה לאותה ברירת-מחדל בדיוק (נסיעה, הזמן
  // האחרון שנבחר או 15), במקום להשאיר "אין בחירה" שהיה דורש מהמשתמש ללחוץ שוב. "any" לא צריך
  // guard דומה - הוא valid גם ב-city וגם ב-precise (סעיפים 12/13 בבקשה), אף פעם לא נפסל.
  const commitLocation = (next) => {
    animate();
    let out = next;
    // 'nationwide' - אין מרחק להגדיר בכלל (אין נקודת-מוצא), אז לא נוגעים ב-travelMode: לא מגדירים
    // ברירת-מחדל של נסיעה, ולא "מתקנים" הליכה. travelMode נשאר undefined כדי שמעבר עתידי לעיר/GPS
    // יקבל שוב את ברירת-המחדל הרגילה (נסיעה 15) בדיוק כמו בפעם הראשונה.
    if (out.mode === 'nationwide') { onChange(out); return; }
    if (isValidLocation(out)) {
      if (out.travelMode === 'walking' && !isPreciseLocation(out, deviceCoords)) {
        out = locationWithDrivingTime(out, normalizeDrivingMinutes(out.travelMinutes));
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

  // בחירת אזור רחב - נשאר mode נפרד מ-'current'/'city'/'address' (matchesLocation ב-
  // lib/filterActivities.js משווה ישירות מול activity.region, בלי שום נקודת-קואורדינטות) - לכן
  // isPreciseLocation למעלה תמיד false עבורו, וההליכה נשארת חסומה כמצופה. לחיצה חוזרת על אותו
  // אזור מבטלת את הבחירה (toggle), כמו הצ'יפים המקבילים ב-FiltersSheet. עיר ואזור הם מקורות-חיפוש
  // חלופיים, לא משלימים - בחירת אזור מנקה עיר שהוקלדה קודם (ולהפך, בשדה העיר למטה), כדי שלא יהיו
  // שני מקורות "פעילים" בו-זמנית שסותרים זה את זה.
  // מודל הנתונים: location.region הוא *מערך* (matchesLocation ב-lib/filterActivities.js מסנן לפי
  // region.includes(activity.region)), והוא נשאר מערך בכוונה - ה-UI כאן בוחר אזור יחיד (עקביות עם
  // עמוד הבית), אבל הייצוג תומך כבר היום ב-OR גאוגרפי (למשל "חיפה או אילת") לקראת Unified Search
  // Intent עתידי: מצב שמור עם כמה אזורים (למשל default_home_filters ישן) מוצג כאן נאמנה (כל הצ'יפים
  // מודגשים, התווית מציגה את כולם) ולא נחתך - רק לחיצה מפורשת של המשתמש מחליפה אותו באזור יחיד.
  // כדי לאפשר בעתיד בחירה מרובה ב-UI מספיק לשנות את השורה שבונה `region` למטה ל-toggle-במערך
  // (כמו ChipsGrid ב-FiltersSheet) - בלי שינוי בסכמה, ב-matchesLocation או ב-locationSummary.
  const selectRegion = (id) => {
    animate();
    const isSame = value.mode === 'region' && (value.region || []).length === 1 && value.region[0] === id;
    commitLocation({ ...value, mode: isSame ? null : 'region', region: isSame ? [] : [id], city: '' });
    setRegionOpen(false);
  };

  // "בכל הארץ" (2026-09-16) - בחירה מפורשת בלי שום הגבלה גאוגרפית (mode:'nationwide', ראו
  // matchesLocation/locationSummary). מנקה עיר/אזור/קואורדינטות/רדיוס ומשמיט travelMode (לא null -
  // ראו commitLocation), כדי שהמצב יהיה חד-משמעי: לא "לא נבחר" (mode:null) ולא "מיקום נכשל".
  // לחיצה חוזרת מבטלת (toggle) בחזרה ל"לא נבחר", כמו צ'יפ-אזור.
  const selectNationwide = () => {
    animate();
    if (value.mode === 'nationwide') { onChange({ ...value, mode: null }); return; }
    const { travelMode: _travelMode, ...rest } = value;
    commitLocation({ ...rest, mode: 'nationwide', city: '', region: [], coords: null, addressLabel: null, radiusKm: null });
    setRegionOpen(false);
  };

  const precise = isPreciseLocation(value, deviceCoords);
  // "הצלחה" (לצורך טקסט/מצב הכפתור) מחמירה יותר מ-precise הכללי: מדובר ספציפית בלחיצה על
  // "השתמשו במיקום שלי" שהניבה קואורדינטות אמיתיות, לא במצב 'address' שמגיע מ"חיפוש חכם".
  const locationConfirmed = value.mode === 'current' && !!deviceCoords;
  const travelMode = value.travelMode;
  // כל האזורים שנבחרו (בדרך כלל אחד; מצב שמור מרובה-אזורים מוצג במלואו, ראו selectRegion)
  const selectedRegionLabel = value.mode === 'region' && (value.region || []).length
    ? value.region.map((id) => REGION_OPTIONS.find((r) => r.id === id)?.label || regionLabel(id)).join(', ')
    : null;
  const nationwideSelected = value.mode === 'nationwide';

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
    onChange(locationWithDrivingTime(value, normalizeDrivingMinutes(value.travelMinutes)));
  };

  // לחיצה על צ'יפ-דקות שכבר נבחר מבטלת רק אותו (בקשת המשתמש: "הכל צריך להישאר אותו דבר, רק
  // לחיצה על כפתור שנבחר מבטלת את הבחירה של אותו הכפתור בלבד") - travelMode נשאר 'driving' (השורה
  // "בנסיעה" נשארת פתוחה/מסומנת בדיוק כמו שהייתה, לא קורסת ל"לא משנה לי המרחק"), רק travelMinutes
  // מתאפס ל-null כדי שאף צ'יפ לא יישאר מסומן. לא משפיע על החיפוש בפועל - travelMinutes הוא
  // display-only (ראו ההערה למעלה ליד DEFAULT_PRECISE_RADIUS_KM), radiusKm לא תלוי בו.
  const selectDrivingMinutes = (minutes) => {
    animate();
    if (travelMode === 'driving' && value.travelMinutes === minutes) {
      onChange({ ...value, travelMinutes: null });
      return;
    }
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
          <Text style={styles.title}>{t('location.picker.title')}</Text>
          <Text style={styles.subtitle}>{t('location.picker.subtitle')}</Text>

          {/* "השתמשו במיקום שלי" - בולט מעט יותר משאר הכפתורים בחלון הזה כברירת מחדל (2026-09-16,
              בקשת המשתמש: "צריך להישאר כמו שהוא רק להיות קצת יותר בולט") - modeBtnPrimary מוסיף
              רק border מודגש (accent, עבה יותר) מעל modeBtn הרגיל, בלי לגעת ב-padding/layout/
              טקסט. לא נוגע ב-modeBtnActive (מצב "נבחר בפועל") שנשאר ברור/שונה - accent+borderWidth
              בלבד כאן, לא accentTintLight - כדי ששני המצבים (בולט-כברירת-מחדל / נבחר-בפועל)
              יישארו מובחנים אחד מהשני. */}
          <Pressable style={[styles.modeBtn, styles.modeBtnPrimary, locationConfirmed && styles.modeBtnActive]} onPress={useCurrentLocation} disabled={busy}>
            <LocationPinIcon size={14} color={colors.accent} />
            <Text style={[styles.modeBtnText, styles.modeBtnTextPrimary, locationConfirmed && styles.modeBtnTextActive]}>
              {busy ? t('location.picker.locating') : locationConfirmed ? t('location.picker.locationSelected') : t('location.picker.useMyLocation')}
            </Text>
          </Pressable>

          <Text style={styles.orText}>{t('location.picker.or')}</Text>

          <Text style={styles.cityLabel}>{t('location.picker.cityLabel')}</Text>
          <CityAutocomplete
            inputStyle={styles.input}
            placeholder={t('location.picker.cityPlaceholder')}
            value={value.mode === 'city' ? value.city : ''}
            onChangeText={(text) => commitLocation({ ...value, mode: text ? 'city' : null, city: text, region: text ? [] : value.region })}
            onSubmitEditing={onClose}
          />

          <Pressable style={styles.regionLink} onPress={() => { animate(); setRegionOpen((o) => !o); }}>
            <Text style={[styles.regionLinkText, selectedRegionLabel && styles.regionLinkTextActive]}>
              {selectedRegionLabel ? t('location.picker.regionSelected', { regions: selectedRegionLabel }) : t('location.picker.searchByRegion')}
            </Text>
            <View style={{ transform: [{ rotate: regionOpen ? '180deg' : '0deg' }] }}>
              <ChevronDownIcon size={11} color={selectedRegionLabel ? colors.accent : colors.textMuted} />
            </View>
          </Pressable>
          {regionOpen && (
            <View style={styles.regionChipsWrap}>
              {REGION_OPTIONS.map((r) => {
                const selected = value.mode === 'region' && (value.region || []).includes(r.id);
                return (
                  <Pressable key={r.id} onPress={() => selectRegion(r.id)} style={[styles.regionChip, selected && styles.regionChipSelected]}>
                    <Text style={[styles.regionChipText, selected && styles.regionChipTextSelected]}>{r.label}</Text>
                  </Pressable>
                );
              })}
            </View>
          )}

          {/* "בכל הארץ" - אפשרות רביעית לצד מיקום-נוכחי/עיר/אזור: בלי הגבלה גאוגרפית בכלל (ראו
              selectNationwide). אותה שפה חזותית כמו "השתמשו במיקום שלי" (modeBtn), לא כפתור-CTA. */}
          <View style={styles.nationwideWrap}>
            <Pressable
              style={[styles.modeBtn, nationwideSelected && styles.modeBtnActive]}
              onPress={selectNationwide}
              accessibilityRole="button"
              accessibilityState={{ selected: nationwideSelected }}
              accessibilityLabel={t('location.picker.nationwideA11y')}
            >
              <Text style={[styles.modeBtnText, nationwideSelected && styles.modeBtnTextActive]}>
                {nationwideSelected ? t('location.picker.nationwideSelected') : t('location.picker.nationwide')}
              </Text>
            </Pressable>
          </View>

          {/* סעיף המרחק לא רלוונטי ל'nationwide' - אין נקודת-מוצא למדוד ממנה. */}
          {locationValid && !nationwideSelected ? (
            <View style={styles.travelSection}>
              <Text style={styles.travelTitle}>{t('location.picker.travelTitle')}</Text>

              <TravelModeOption
                icon="🚶"
                title={t('location.picker.walkingTitle')}
                subtitle={t('location.picker.walkingSubtitle')}
                selected={travelMode === 'walking'}
                disabled={!precise}
                hint={!precise ? t('location.picker.walkingHint') : null}
                onPress={selectWalking}
              />

              <TravelModeOption
                icon="🚗"
                title={t('location.picker.drivingTitle')}
                subtitle={travelMode === 'driving' && typeof value.travelMinutes === 'number' ? t('location.picker.drivingSubtitle', { minutes: value.travelMinutes }) : null}
                selected={travelMode === 'driving'}
                onPress={selectDriving}
              >
                {travelMode === 'driving' ? (
                  <View style={styles.chipsWrap}>
                    {DRIVING_TIME_OPTIONS.map((minutes) => {
                      const selected = value.travelMinutes === minutes;
                      return (
                        <Pressable key={minutes} onPress={() => selectDrivingMinutes(minutes)} style={[styles.chip, selected && styles.chipSelected]}>
                          <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{t('location.picker.minutesChip', { minutes })}</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                ) : null}
              </TravelModeOption>

              <Pressable onPress={selectAnyDistance} style={[styles.anyRow, travelMode === 'any' && styles.anyRowSelected]}>
                <Text style={[styles.anyRowText, travelMode === 'any' && styles.anyRowTextSelected]}>{t('location.picker.anyDistance')}</Text>
              </Pressable>
            </View>
          ) : null}

          <Pressable style={[styles.doneBtn, !ctaValid && styles.doneBtnDisabled]} onPress={onClose} disabled={!ctaValid || busy}>
            <Text style={styles.doneBtnText}>{t('location.picker.cta')}</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = createStyles((d) => ({
  backdrop: { flex: 1, backgroundColor: 'rgba(20,30,35,0.4)', justifyContent: 'center', padding: spacing.xl },
  card: { backgroundColor: colors.card, borderRadius: radii.xl, padding: spacing.xl },
  title: { fontFamily: fonts.extraBold, fontSize: 17, color: colors.textPrimary, textAlign: 'center' },
  subtitle: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.textSecondary, textAlign: 'center', marginTop: 4, marginBottom: 14 },
  modeBtn: {
    flexDirection: d.row, alignItems: 'center', justifyContent: 'center', gap: 8,
    borderWidth: 1.5, borderColor: colors.border, borderRadius: radii.pill, paddingVertical: 12,
  },
  modeBtnActive: { borderColor: colors.accent, backgroundColor: colors.accentTintLight },
  // מעט יותר בולט מברירת-המחדל של שאר כפתורי modeBtn בחלון (border עבה+צבוע), בלי רקע-tint -
  // ה-tint נשאר שמור למצב "נבחר בפועל" (modeBtnActive) כדי ששני המצבים יישארו מובחנים.
  // 'rgba' עם alpha נמוך (לא colors.accentTintLight - זה שמור למצב "נבחר בפועל" ב-modeBtnActive)
  // כדי שיישאר "קצת צבע, לא הרבה" (בקשת המשתמש) בברירת המחדל, ועדיין תישאר הדרגה ברורה כשעוברים
  // בפועל למצב-נבחר (accentTintLight רווי יותר מה-wash העדין הזה).
  modeBtnPrimary: { borderColor: colors.accent, borderWidth: 2, backgroundColor: 'rgba(0, 117, 152, 0.06)' },
  modeBtnText: { fontFamily: fonts.bold, fontSize: 13.5, color: colors.textSecondary },
  modeBtnTextPrimary: { color: colors.accent },
  modeBtnTextActive: { color: colors.accent },
  orText: { fontFamily: fonts.semiBold, fontSize: 12, color: colors.textMuted, textAlign: 'center', marginVertical: 8 },
  cityLabel: { fontFamily: fonts.bold, fontSize: 12, color: colors.textSecondary, textAlign: d.textAlign, marginBottom: 6 },
  input: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, padding: 12,
    fontFamily: fonts.regular, fontSize: 14, color: colors.textPrimary, backgroundColor: colors.bg,
  },
  regionLink: {
    flexDirection: d.row, alignItems: 'center', justifyContent: 'center', gap: 4,
    alignSelf: 'center', marginTop: 8, paddingVertical: 4, paddingHorizontal: 6,
  },
  regionLinkText: { fontFamily: fonts.semiBold, fontSize: 12, color: colors.textMuted },
  regionLinkTextActive: { color: colors.accent, fontFamily: fonts.bold },
  regionChipsWrap: { flexDirection: d.row, flexWrap: 'wrap', gap: 8, marginTop: 8 },
  regionChip: {
    backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border,
    borderRadius: radii.pill, paddingVertical: 8, paddingHorizontal: 13,
  },
  regionChipSelected: { backgroundColor: colors.accentTintLight, borderColor: colors.accent },
  regionChipText: { fontFamily: fonts.semiBold, fontSize: 12.5, color: colors.textSecondary },
  regionChipTextSelected: { color: colors.accent, fontFamily: fonts.bold },
  travelSection: { marginTop: 14, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.borderLight },
  travelTitle: { fontFamily: fonts.bold, fontSize: 13.5, color: colors.textPrimary, textAlign: 'center', marginBottom: 10 },

  travelOptionWrap: { marginBottom: 10 },
  travelCard: {
    borderWidth: 1.5, borderColor: colors.border, borderRadius: radii.lg, padding: 12, overflow: 'hidden',
  },
  travelCardSelected: { borderColor: colors.accent, backgroundColor: colors.accentTintLight },
  travelCardDisabled: { opacity: 0.45 },
  travelCardHeader: { flexDirection: d.row, alignItems: 'center', gap: 10 },
  travelEmoji: { fontSize: 19 },
  travelTextStack: { alignItems: d.alignStart, flex: 1 },
  travelTitleText: { fontFamily: fonts.bold, fontSize: 13.5, color: colors.textSecondary },
  travelTitleTextSelected: { color: colors.accent },
  travelSubtitleText: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.textMuted, marginTop: 1 },
  walkHint: { fontFamily: fonts.regular, fontSize: 11, color: colors.textMuted, textAlign: 'center', marginTop: 6 },

  chipsWrap: { flexDirection: d.row, flexWrap: 'wrap', gap: 8, marginTop: 12 },
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

  nationwideWrap: { marginTop: 10 },

  doneBtn: { marginTop: 16, backgroundColor: colors.accent, borderRadius: radii.pill, paddingVertical: 13, alignItems: 'center' },
  doneBtnDisabled: { opacity: 0.4 },
  doneBtnText: { fontFamily: fonts.bold, fontSize: 14, color: '#fff' },
}));
