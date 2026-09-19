import { View, Text, Pressable, Image, Platform, Linking, Animated } from 'react-native';
import NearMeRadar from './NearMeRadar';
import { colors, fonts } from '../constants/theme';
import { useI18n, createStyles } from '../lib/i18n';

// PHASE 1 EXTRACTION (2026-09-19, "safe presentational extraction" - ראו הביקורת הארכיטקטונית) -
// הועבר byte-for-byte מ-app/index.js (הכותרת "לאן קופצים היום?"+קו-המבטא הכתום+שורת-הירו
// התלת-חלקית) - כולל ה-JSX/סטיילים, בלי שום שינוי חזותי/פיקסל. קומפוננטה presentational-בלבד:
// כל ה-state (searchMode/nearMeLoading/nearMeError/heroCompact) וכל ה-handlers (switchSearchMode/
// handleNearMePress/nearMePressIn/Out/setWhereQuickOpen) עדיין גרים ב-HomeScreen - מגיעים לכאן
// כ-props בלבד. שום לוגיקת-GPS/הרשאה/ניווט לא זזה - ראו app/index.js להסבר המלא על כל אחד
// מהם (nearMeExplainerModal/goNearMe/handleNearMePress וכו' נשארו שם ללא שינוי).
//
// props:
//   searchMode        - 'free' | 'guided' | null (החזותי-הפעיל, ל-active/faded)
//   onSwitchMode(mode) - switchSearchMode המקורי
//   heroCompact        - windowWidth<360 (טיפוגרפיה/אייקון מוקטנים בפעולות הצדדיות בלבד)
//   nearMeLoading/nearMeError/nearMePressScale - state של "מה קרוב?" (ראו HomeScreen)
//   onNearMePress()    - גם לחיצה על הרדאר עצמו וגם "נסו שוב" בשגיאה (אותו handler בדיוק כמו קודם)
//   onNearMePressIn/Out() - אנימציית-לחיצה עדינה על הרדאר
//   onChooseCityInstead() - "בחרו עיר במקום" בשגיאת-מיקום (setWhereQuickOpen(true) המקורי)
export default function HomeHero({
  searchMode, onSwitchMode, heroCompact,
  nearMeLoading, nearMeError, nearMePressScale,
  onNearMePress, onNearMePressIn, onNearMePressOut, onChooseCityInstead,
}) {
  const { t } = useI18n();
  return (
    <>
      {/* 🧭 "לאן קופצים היום?" - כותרת-העל של כל מודול החיפוש, מחוץ לכרטיס עצמו. סדר-הילדים
          (2026-09-20, סבב-עידון רביעי, בקשת המשתמש: "האימוג'י שלו צריך להיות בתחילת המשפט") -
          אייקון קודם, טקסט אחריו ב-JSX: ש-d.row (row-reverse בעברית) ממקם את הילד-הראשון
          (האייקון) בקצה הפיזי-הימני, שהוא תחילת סדר-הקריאה בעברית - "בתחילת המשפט" כפשוטו
          (זה חזרה למבנה שהיה לפני סבב-עידון קודם, שהניח בטעות שה-mockup רצה את הסדר ההפוך).
          justifyContent:'center' (חדש) על searchModuleTitleRow עצמו - "צריך להיות בדיוק
          באמצע": בלי זה הזוג אייקון+טקסט היה נדחף לקצה-ה-flex-start של השורה (רוחב-מלא, ראו
          searchModuleHeaderWrap - View עמודה רגיל, הילד שלו נמתח לרוחב מלא כברירת-מחדל), לא
          ממורכז ביחס לתוכן שמתחתיו. בלי תת-כותרת (בקשת המשתמש הישנה: הוסרו שלוש תתי-הכותרות
          בעמוד הבית) - עטיפה חיצונית (searchModuleHeaderWrap) עדיין נושאת את המרווח מעל/מתחת
          לשורה עצמה. */}
      <View style={styles.searchModuleHeaderWrap}>
        <View style={styles.searchModuleTitleRow}>
          <Text style={styles.searchModuleTitle}>{t('home.search.title')}</Text>
        </View>
      </View>

      {/* שורת-הירו התלת-חלקית (2026-09-20, "TURU home reference mockup" - מחליפה לגמרי את
          nearMeStandaloneAction+searchModeRow הנפרדים הקודמים ב-structure אחד: חיפוש חופשי |
          רדאר+כיתוב-מרחק | בחירה מהירה). ראו heroRow בסטיילים למעלה להסבר המלא על טכניקת
          שתי-העמודות-הצדדיות-שוות-flex שמבטיחה מירכוז גיאומטרי אמיתי של הרדאר (סעיף 11 בבקשה),
          ועל heroSideCol/heroSideAction ל"secondary actions orbiting the central radar" (סעיף
          4, "INTENTIONAL DEVIATION #1" - קטנות/משניות בכוונה, לא pill/card מתחרה). כל לוגיקת-
          ה-GPS/הרשאה/שגיאה (onNearMePress/onNearMePressIn/Out/nearMeLoading/nearMeError) מגיעה
          מ-HomeScreen כ-props - רק ה-JSX/עיצוב-סביב חי כאן. onSwitchMode (switchSearchMode
          המקורי) גם מגיע כ-prop - נקרא משתי הפעולות הצדדיות. */}
      <View style={styles.heroRow}>
        <View style={styles.heroSideCol}>
          <Pressable
            style={({ pressed }) => [styles.heroSideAction, pressed && styles.heroSideActionPressed]}
            onPress={() => onSwitchMode('free')}
            hitSlop={8}
            accessibilityRole="radio"
            accessibilityState={{ checked: searchMode === 'free' }}
            accessibilityLabel={t('home.search.modeFree')}
          >
            <View style={[
              styles.heroSideActionIconWrap, heroCompact && styles.heroSideActionIconWrapCompact,
              searchMode !== 'free' && styles.heroSideActionIconWrapFaded,
            ]}
            >
              <Image
                source={require('../assets/magnifier.png')}
                style={[styles.heroSideActionIconImage, heroCompact && styles.heroSideActionIconImageCompact]}
                resizeMode="contain"
              />
            </View>
            <Text
              style={[
                styles.heroSideActionText, heroCompact && styles.heroSideActionTextCompact,
                searchMode === 'free' ? styles.heroSideActionTextActive : styles.heroSideActionTextInactive,
              ]}
              numberOfLines={1}
            >
              {t('home.search.modeFree')}
            </Text>
            {searchMode === 'free' ? <View style={styles.heroSideActionActiveDot} /> : null}
          </Pressable>
        </View>

        <View style={styles.heroCenterCol}>
          <Pressable
            style={({ pressed }) => [styles.nearMeStandalone, pressed && styles.nearMeStandalonePressed]}
            onPress={onNearMePress}
            onPressIn={onNearMePressIn}
            onPressOut={onNearMePressOut}
            disabled={nearMeLoading}
            accessibilityRole="button"
            accessibilityLabel={t('home.nearMe.a11yLabel')}
            accessibilityState={{ disabled: nearMeLoading, busy: nearMeLoading }}
          >
            <Animated.View
              style={[styles.nearMeRadarWrapCompact, { transform: [{ scale: nearMePressScale }] }]}
              importantForAccessibility="no-hide-descendants"
              accessibilityElementsHidden
            >
              <NearMeRadar loading={nearMeLoading} color={colors.accent} showLabel={false} />
            </Animated.View>
            {/* "מה קרוב?" - nearMeLabelText עצמאי (לא עוד heroSideActionText משותף, ראו שם:
                2026-09-20 "תגדיל את בחירה מהירה וחיפוש חופשי... ותקטין מעט... את הכיתוב מה
                קרוב" - הפרדנו סטייל כדי שכל אחד יוכל לזוז לכיוון הפוך). בלי active-dot/faded
                (זו לא "בחירת מצב" - לחיצה מנווטת ישירות, ראו goNearMe ב-HomeScreen). בתוך אותו
                Pressable כמו הרדאר עצמו - כל האזור (רדאר+טקסט) הוא יעד-לחיצה אחד. מוצג רק
                כש-searchMode===null - נעלם כש-panel צדדי פתוח, חוזר במצב ברירת-המחדל הנקי. */}
            {!searchMode ? (
              <Text style={[styles.nearMeLabelText, heroCompact && styles.nearMeLabelTextCompact]} numberOfLines={1}>
                {t('home.nearMe.label')}
              </Text>
            ) : null}
          </Pressable>
          {/* כיתוב-מרחק/רדיוס (למשל "עד 15 דק' ממני") לא חוזר כאן - "מה קרוב?" למעלה הוא
              התווית הקבועה היחידה מתחת לרדאר (בקשת המשתמש: "אל תוסיפו עוד כיתוב-מרחק מתחת
              ל'מה קרוב?'"). goNearMe (HomeScreen) הוא זה שקובע radiusKm:null - "מה קרוב?" הוא
              shortcut-גילוי ("הכי קרוב אליי"), לא בורר-טווח - ראו ההערה המלאה ב-app/index.js. */}
          {nearMeError ? (
            <View style={styles.nearMeErrorRow}>
              <Text style={styles.nearMeErrorText}>{t(nearMeError)}</Text>
              <View style={styles.nearMeErrorActions}>
                <Pressable onPress={onNearMePress} hitSlop={8}>
                  <Text style={styles.nearMeErrorLink}>{t('common.actions.retry')}</Text>
                </Pressable>
                <Text style={styles.nearMeErrorDot}>·</Text>
                <Pressable onPress={onChooseCityInstead} hitSlop={8}>
                  <Text style={styles.nearMeErrorLink}>{t('home.nearMe.errors.chooseCity')}</Text>
                </Pressable>
                {nearMeError === 'home.nearMe.errors.blocked' && Platform.OS !== 'web' ? (
                  <>
                    <Text style={styles.nearMeErrorDot}>·</Text>
                    <Pressable onPress={() => Linking.openSettings()} hitSlop={8}>
                      <Text style={styles.nearMeErrorLink}>{t('home.nearMe.errors.openSettings')}</Text>
                    </Pressable>
                  </>
                ) : null}
              </View>
            </View>
          ) : null}
        </View>

        <View style={styles.heroSideCol}>
          <Pressable
            style={({ pressed }) => [styles.heroSideAction, pressed && styles.heroSideActionPressed]}
            onPress={() => onSwitchMode('guided')}
            hitSlop={8}
            accessibilityRole="radio"
            accessibilityState={{ checked: searchMode === 'guided' }}
            accessibilityLabel={t('home.search.modeGuided')}
          >
            <View style={[
              styles.heroSideActionIconWrap, heroCompact && styles.heroSideActionIconWrapCompact,
              searchMode !== 'guided' && styles.heroSideActionIconWrapFaded,
            ]}
            >
              <Image
                source={require('../assets/sparkles.png')}
                style={[styles.heroSideActionIconImage, heroCompact && styles.heroSideActionIconImageCompact]}
                resizeMode="contain"
              />
            </View>
            <Text
              style={[
                styles.heroSideActionText, heroCompact && styles.heroSideActionTextCompact,
                searchMode === 'guided' ? styles.heroSideActionTextActive : styles.heroSideActionTextInactive,
              ]}
              numberOfLines={1}
            >
              {t('home.search.modeGuided')}
            </Text>
            {searchMode === 'guided' ? <View style={styles.heroSideActionActiveDot} /> : null}
          </Pressable>
        </View>
      </View>
    </>
  );
}

const styles = createStyles((d) => ({
  // marginTop:4 (לא 10) - קובץ turu-logo.png עצמו נושא כמה px של שוליים-שקופים בתחתית התמונה
  // (לא נגוע כאן, זה ה-asset עצמו), אז marginTop קטן יותר מפצה על זה כדי שהמרווח *החזותי* בפועל
  // (לא רק הערך ב-style) יצא שווה למרווח שמתחת לכותרת - נמדד ואומת בדפדפן (16px משני הצדדים).
  // marginTop:10 (היה 16, "visual polish: free search + quick choice" 2026-09-20, בקשת המשתמש:
  // "slightly reduce the vertical gap between the TURU logo and 'לאן קופצים היום?'... do not
  // aggressively compress") - צמצום עדין, לא דרסטי; הלוגו עצמו לא זז (content.paddingTop
  // ב-app/index.js, לא נגוע כאן).
  // marginBottom:8 (היה 12) - "slightly reduce the gap between the heading and the three
  // discovery actions... preserve comfortable breathing room".
  searchModuleHeaderWrap: { marginTop: 10, marginBottom: 8 },
  // justifyContent:'center' - בלעדיו View-עמודה רגיל (searchModuleHeaderWrap) נותן לילד שלו
  // רוחב-מלא כברירת-מחדל, וללא justifyContent מפורש הטקסט היה נדחף לקצה-ה-flex-start של השורה,
  // לא ממורכז.
  searchModuleTitleRow: { flexDirection: d.row, alignItems: 'center', justifyContent: 'center', gap: 8 },
  // 26px (ללא שינוי) - "approximately 25-27px... Make this feel like the main question of the
  // screen". extraBold=800/textPrimary=#121c23 (navy-כהה, לא #000 טהור). lineHeight:22 (היה 31,
  // "SMALL VISUAL POLISH" 2026-09-20, בקשת המשתמש: "reduce its line-height... make the glyph/text
  // block feel less tall... do NOT simply make the font noticeably smaller") - קרוב לגובה-הגופן
  // עצמו (26px), לא עוד "אוויר" גדול מעליו/מתחתיו - כותרת חד-שורתית (לא עוברת שורה ברוחבי-מסך
  // נתמכים), אז lineHeight קובע ישירות את גובה-הבלוק החזותי בלי להשפיע על גודל-התווים עצמם.
  searchModuleTitle: {
    fontFamily: fonts.extraBold, fontSize: 26, lineHeight: 22, color: colors.textPrimary, textAlign: d.textAlign,
  },
  // שורת-הירו התלת-חלקית - flexDirection:'row' פיזי (לא d.row) בכוונה: האפליקציה מכבה forceRTL
  // לגמרי (app/_layout.js), אז 'row' תמיד ממקם את הילד הראשון בקצה הפיזי-שמאלי - חיפוש חופשי
  // משמאל, בחירה מהירה מימין, בסדר-JSX תואם.
  // heroSideCol.flex:1 - בקשת המשתמש המפורשת: "the radar must be geometrically centered in the
  // viewport... Hebrew label lengths are unequal - do not let text width push the radar sideways".
  // שתי עמודות-הצד flex:1 שוות-רוחב-מוחלט (לא תלויות-תוכן) עם alignItems:'center' פנימי, כך
  // שעמודת-המרכז (heroCenterCol, ברוחב-תוכן טבעי) יושבת תמיד בדיוק במרכז הגיאומטרי של השורה.
  heroRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 8, paddingHorizontal: 8 },
  // paddingTop:14 (היה 22, "small visual polish" round 2, 2026-09-20, בקשת המשתמש: "שני הכפתורים
  // בצדדיו צריכים להיות קצת יותר גבוה, גם הכיתוב וגם האייקונים") - מרים את כל התוכן של שתי
  // העמודות-הצדדיות (אייקון+טקסט יחד, ראו heroSideAction למטה) קצת יותר קרוב לראש השורה.
  heroSideCol: { flex: 1, alignItems: 'center', paddingTop: 14 },
  // לא pill/card ("NOT large pills, NOT cards, NOT competing with the radar visually") - רק
  // אייקון+טקסט, minHeight נדיב ל-touch target נוח.
  // gap:0 (היה 2, "small visual polish" round 4, 2026-09-20, בקשת המשתמש: "לקרב עוד יותר את
  // הכיתוב... לאייקונים שלהם") - חל על שני הצדדים, אותה פרופורציה בדיוק.
  heroSideAction: { alignItems: 'center', gap: 0, paddingVertical: 8, paddingHorizontal: 0, minHeight: 60, justifyContent: 'center' },
  heroSideActionPressed: { opacity: 0.7 },
  // heroSideActionIconWrap - קופסת-מיקום/גודל בלבד מסביב לאייקון (54x54) - בלי רקע-עגול צבוע
  // (הוסר בסבב קודם). צמוד לגודל-האייקון עצמו (52, ראו heroSideActionIconImage למטה).
  heroSideActionIconWrap: {
    width: 54, height: 54, alignItems: 'center', justifyContent: 'center',
  },
  heroSideActionIconWrapCompact: { width: 40, height: 40 },
  // heroSideActionIconWrapFaded (חדש, "visual polish: free search + quick choice" 2026-09-20,
  // בקשת המשתמש: "strengthen the selected-state hierarchy... [inactive] icon may be slightly
  // visually quieter") - מחליף את heroSideActionFaded הישן (opacity:0.7 שחל על כל ה-Pressable,
  // כולל הטקסט): עכשיו רק האייקון דוהה מעט כשלא פעיל, והטקסט מקבל צבע מפורש משלו
  // (heroSideActionTextInactive למטה) - שתי אותות נפרדים וברורים, לא עוד עמעום גורף אחד.
  heroSideActionIconWrapFaded: { opacity: 0.6 },
  // 52/38 - "האימוג'י שלהם ["בחירה מהירה"/"חיפוש חופשי"]... יותר גדולים".
  heroSideActionIconImage: { width: 52, height: 52 },
  heroSideActionIconImageCompact: { width: 38, height: 38 },
  // heroSideActionText - בלי color כאן יותר (הוסר, "visual polish: free search + quick choice"
  // 2026-09-20): כל אחד משני המצבים (Active/Inactive למטה) מזין צבע מפורש משלו במקום ברירת-מחדל
  // אחת+עמעום. 15/11.5 - "הכיתוב 'בחירה מהירה' ו'חיפוש חופשי' צריכים להיות מעט יותר קטנים"
  // (בקשת-עבר). nearMeLabelText/Compact למטה מוגדרים לאותו גודל בדיוק.
  heroSideActionText: { fontFamily: fonts.bold, fontSize: 15, textAlign: 'center' },
  heroSideActionTextCompact: { fontSize: 11.5 },
  // ACTIVE: #007598 (colors.accent) - "TURU accent color", בדיוק כמו underline (heroSideActionActiveDot
  // למטה) והרדאר המרכזי - זהות-צבע אחת עקבית ל"פעיל".
  heroSideActionTextActive: { color: colors.accent },
  // INACTIVE (חדש) - colors.textMuted (#7a8185, אפרפר-ניטרלי) במקום textSecondary+עמעום-גורף
  // ישן - "label should be visibly more neutral/gray" (בקשת המשתמש), ניגוד ברור יותר מול הכחול
  // הפעיל מאשר גוון-יחיד בשתי שקיפויות.
  heroSideActionTextInactive: { color: colors.textMuted },
  // 22x3 (היה 18x2.5, "visual polish: free search + quick choice" 2026-09-20, בקשת המשתמש:
  // "current small underline alone is slightly too subtle... strengthen") - חיזוק עדין, עדיין
  // קו-תחתי דק, לא בר/פס גדול.
  heroSideActionActiveDot: { width: 22, height: 3, borderRadius: 1.5, backgroundColor: colors.accent, marginTop: 4 },
  heroCenterCol: { alignItems: 'center' },
  nearMeStandalone: { alignItems: 'center', gap: 1 },
  nearMeStandalonePressed: { opacity: 0.85 },
  // גובה קומפקטי (RADAR_COMPACT_H ב-NearMeRadar, showLabel=false) - 158x112 (היה 134x95, "small
  // visual polish" round 2, 2026-09-20, בקשת המשתמש: "הכפתור הגדול צריך להיות יותר גדול" - חזרה
  // לגודל הקודם/מוכר) תואם את RADAR_SVG_W שם: svgHeight בפועל = RADAR_SVG_W * (RADAR_COMPACT_H/180)
  // ≈ 112.4. שינוי-פרמטר יחיד ב-NearMeRadar.js (RADAR_SVG_W בלבד, ראו שם) מגדיל את כל הגיאומטריה
  // הפנימית פרופורציונלית - הרדאר עדיין מעוגל ומרוכז בדיוק כמו קודם, רק גדול יותר.
  nearMeRadarWrapCompact: { width: 158, height: 112, alignItems: 'center', justifyContent: 'center' },
  // nearMeLabelText/Compact - אותו גודל בדיוק כמו heroSideActionText/Compact (15/11.5, "small
  // visual polish" round 2, בקשת המשתמש: "הטקסט 'מה קרוב' צריך להיות באותו גודל של 'בחירה מהירה
  // וחיפוש חופשי'" - במפורש לא עוד גדול-יותר, כמו שהיה קודם).
  nearMeLabelText: { fontFamily: fonts.bold, fontSize: 15, color: colors.textSecondary, textAlign: 'center' },
  nearMeLabelTextCompact: { fontSize: 11.5 },
  nearMeErrorRow: { marginTop: 8, alignItems: 'center' },
  nearMeErrorText: { fontFamily: fonts.semiBold, fontSize: 12, color: colors.danger, textAlign: 'center' },
  nearMeErrorActions: { flexDirection: d.row, alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 4 },
  nearMeErrorLink: { fontFamily: fonts.bold, fontSize: 12, color: colors.accent },
  nearMeErrorDot: { fontSize: 12, color: colors.textMuted },
}));
