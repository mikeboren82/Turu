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
        {/* קו-מבטא כתום קטן (2026-09-20, "typography and section-heading refinement" - בקשת
            המשתמש: "add a very small decorative accent line underneath... NOT a full underline...
            use the existing TURU orange/golden accent color from the logo"). #FF9101 נדגם בפועל
            מפיקסלי-הקישוטים הכתומים בתוך assets/turu-logo.png עצמו (rgb(255,145,1), לא ניחוש) -
            אין טוקן-כתום קיים ב-theme.js שמייצג את זה (coral/coralStrong משמשים כבר למפה/מועדפים,
            גוון שונה). alignSelf:'center' - עמודת-האב (searchModuleHeaderWrap) לא ממרכזת ילדים
            כברירת-מחדל. */}
        <View style={styles.heroTitleAccent} />
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
            style={({ pressed }) => [
              styles.heroSideAction,
              // דהייה (עודכן 2026-09-20, "change the DEFAULT BEHAVIOR" - בקשת המשתמש: "בחירה
              // מהירה וחיפוש חופשי צריכים להיות שניהם דהויים בהתחלה אם הם לא נבחרו, רק מי
              // שנבחר נראה רגיל") - היה מותנה ב-searchMode truthy (כך ששניהם נשארו מלאים
              // במצב-ברירת-המחדל הישן); עכשיו דהוי בכל מצב שהוא *לא* הפעיל, כולל null.
              searchMode !== 'free' && styles.heroSideActionFaded,
              pressed && styles.heroSideActionPressed,
            ]}
            onPress={() => onSwitchMode('free')}
            hitSlop={8}
            accessibilityRole="radio"
            accessibilityState={{ checked: searchMode === 'free' }}
            accessibilityLabel={t('home.search.modeFree')}
          >
            <View style={[styles.heroSideActionIconWrap, heroCompact && styles.heroSideActionIconWrapCompact, searchMode === 'free' && styles.heroSideActionIconWrapActive]}>
              <Image
                source={require('../assets/magnifier.png')}
                style={[styles.heroSideActionIconImage, heroCompact && styles.heroSideActionIconImageCompact]}
                resizeMode="contain"
              />
            </View>
            <Text style={[styles.heroSideActionText, heroCompact && styles.heroSideActionTextCompact, searchMode === 'free' && styles.heroSideActionTextActive]} numberOfLines={1}>
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
            style={({ pressed }) => [
              styles.heroSideAction,
              // דהייה - ראו ההערה המלאה ליד הפעולה הצדדית השנייה (heroSideAction הראשון
              // למעלה, "חיפוש חופשי") לאותו שינוי בדיוק (סימטרי לשתי הפעולות).
              searchMode !== 'guided' && styles.heroSideActionFaded,
              pressed && styles.heroSideActionPressed,
            ]}
            onPress={() => onSwitchMode('guided')}
            hitSlop={8}
            accessibilityRole="radio"
            accessibilityState={{ checked: searchMode === 'guided' }}
            accessibilityLabel={t('home.search.modeGuided')}
          >
            <View style={[styles.heroSideActionIconWrap, heroCompact && styles.heroSideActionIconWrapCompact, searchMode === 'guided' && styles.heroSideActionIconWrapActive]}>
              <Image
                source={require('../assets/sparkles.png')}
                style={[styles.heroSideActionIconImage, heroCompact && styles.heroSideActionIconImageCompact]}
                resizeMode="contain"
              />
            </View>
            <Text style={[styles.heroSideActionText, heroCompact && styles.heroSideActionTextCompact, searchMode === 'guided' && styles.heroSideActionTextActive]} numberOfLines={1}>
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
  searchModuleHeaderWrap: { marginTop: 4, marginBottom: 10 },
  // justifyContent:'center' - בלעדיו View-עמודה רגיל (searchModuleHeaderWrap) נותן לילד שלו
  // רוחב-מלא כברירת-מחדל, וללא justifyContent מפורש הטקסט היה נדחף לקצה-ה-flex-start של השורה,
  // לא ממורכז.
  searchModuleTitleRow: { flexDirection: d.row, alignItems: 'center', justifyContent: 'center', gap: 8 },
  // 26px - "approximately 25-27px... Make this feel like the main question of the screen".
  // extraBold=800/textPrimary=#121c23 (navy-כהה, לא #000 טהור). lineHeight:31 - יחס קומפקטי-אך-נוח.
  searchModuleTitle: {
    fontFamily: fonts.extraBold, fontSize: 26, lineHeight: 31, color: colors.textPrimary, textAlign: d.textAlign,
  },
  // heroTitleAccent - "קו-מבטא" כתום קטן מתחת לכותרת הראשית בלבד. #FF9101 נדגם בפועל
  // מ-assets/turu-logo.png. 27x3, borderRadius:1.5 - "NOT a full underline... short centered
  // decorative stroke", בתוך הטווח המבוקש (24-30 רוחב, ~3 גובה). marginTop:8 - "~7-9px below the text".
  heroTitleAccent: {
    width: 27, height: 3, borderRadius: 1.5, backgroundColor: '#FF9101', alignSelf: 'center', marginTop: 8,
  },
  // שורת-הירו התלת-חלקית - flexDirection:'row' פיזי (לא d.row) בכוונה: האפליקציה מכבה forceRTL
  // לגמרי (app/_layout.js), אז 'row' תמיד ממקם את הילד הראשון בקצה הפיזי-שמאלי - חיפוש חופשי
  // משמאל, בחירה מהירה מימין, בסדר-JSX תואם.
  // heroSideCol.flex:1 - בקשת המשתמש המפורשת: "the radar must be geometrically centered in the
  // viewport... Hebrew label lengths are unequal - do not let text width push the radar sideways".
  // שתי עמודות-הצד flex:1 שוות-רוחב-מוחלט (לא תלויות-תוכן) עם alignItems:'center' פנימי, כך
  // שעמודת-המרכז (heroCenterCol, ברוחב-תוכן טבעי) יושבת תמיד בדיוק במרכז הגיאומטרי של השורה.
  heroRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 8, paddingHorizontal: 8 },
  // paddingTop ממקם את אייקון+תווית הפעולה הצדדית בערך מול מרכז דיסקית הרדאר - כך הן מרגישות
  // כמו "secondary actions orbiting the central radar", לא שורה תלושה שיושבת סתם למעלה.
  heroSideCol: { flex: 1, alignItems: 'center', paddingTop: 22 },
  // לא pill/card ("NOT large pills, NOT cards, NOT competing with the radar visually") - רק
  // אייקון+טקסט, minHeight נדיב ל-touch target נוח.
  heroSideAction: { alignItems: 'center', gap: 5, paddingVertical: 8, paddingHorizontal: 0, minHeight: 60, justifyContent: 'center' },
  heroSideActionPressed: { opacity: 0.7 },
  // דהייה עדינה לפעולה-הצדדית שלא נבחרה - "Do NOT gray them out so strongly that they appear
  // disabled... Inactive ≠ unavailable".
  heroSideActionFaded: { opacity: 0.7 },
  // heroSideActionIconWrap - "צ'יפ" עגול-רך מאחורי האייקון (52x52) - "The side icons should feel
  // like actual buttons/actions even before the user reads the text". accentTintLight - אותו
  // טוקן-רקע-עדין הקיים כבר בכפתור "🎯 מסונן" וכו'. עדיין קטן משמעותית מהרדאר (52px מול ~158px).
  heroSideActionIconWrap: {
    width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.accentTintLight,
  },
  heroSideActionIconWrapCompact: { width: 44, height: 44, borderRadius: 22 },
  // heroSideActionIconWrapActive - כשמצב זה נבחר בפועל, הצ'יפ עובר לטון-accent חזק יותר.
  heroSideActionIconWrapActive: { backgroundColor: colors.accentTint },
  heroSideActionIconImage: { width: 35, height: 35 },
  heroSideActionIconImageCompact: { width: 25, height: 25 },
  heroSideActionText: { fontFamily: fonts.bold, fontSize: 16.5, color: colors.textSecondary, textAlign: 'center' },
  heroSideActionTextCompact: { fontSize: 12.5 },
  heroSideActionTextActive: { color: colors.accent },
  heroSideActionActiveDot: { width: 18, height: 2.5, borderRadius: 1.5, backgroundColor: colors.accent, marginTop: 3 },
  heroCenterCol: { alignItems: 'center' },
  nearMeStandalone: { alignItems: 'center', gap: 1 },
  nearMeStandalonePressed: { opacity: 0.85 },
  // גובה קומפקטי (RADAR_COMPACT_H ב-NearMeRadar, showLabel=false) - 158x112 תואם את
  // RADAR_SVG_W: svgHeight בפועל = RADAR_SVG_W * (RADAR_COMPACT_H/180) ≈ 112.4.
  nearMeRadarWrapCompact: { width: 158, height: 112, alignItems: 'center', justifyContent: 'center' },
  // nearMeLabelText/Compact - "מה קרוב?" עצמאי מ-heroSideActionText: 17px, bold - "the center
  // label should be slightly stronger because it belongs to the primary action".
  nearMeLabelText: { fontFamily: fonts.bold, fontSize: 17, color: colors.textSecondary, textAlign: 'center' },
  nearMeLabelTextCompact: { fontSize: 13 },
  nearMeErrorRow: { marginTop: 8, alignItems: 'center' },
  nearMeErrorText: { fontFamily: fonts.semiBold, fontSize: 12, color: colors.danger, textAlign: 'center' },
  nearMeErrorActions: { flexDirection: d.row, alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 4 },
  nearMeErrorLink: { fontFamily: fonts.bold, fontSize: 12, color: colors.accent },
  nearMeErrorDot: { fontSize: 12, color: colors.textMuted },
}));
