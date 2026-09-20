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
//   children           - (חדש, "Home Discovery Panel Redesign" 2026-09-20, עודכן "no rectangle
//     at all" באותו יום) תוכן חיפוש-חופשי/בחירה-מהירה (מה שהיה בעבר smartSearchCard נפרד
//     ב-app/index.js) - מוצג עכשיו *בתוך* אותו discoveryArea בדיוק ששורת-שלוש-הפעולות יושבת בו
//     (בלי רקע-מרובע, ראו discoveryArea/discoveryAreaExpanded למטה), לא בכרטיס-צף נפרד מתחתיו.
//     app/index.js עדיין הבעלים היחיד של כל ה-state/JSX הפנימי (input/GuidedSearchIntentControl/
//     CTA וכו') - HomeHero רק מחליט *איפה* זה מצטייר, לא *מה* מצטייר.
export default function HomeHero({
  searchMode, onSwitchMode, heroCompact,
  nearMeLoading, nearMeError, nearMePressScale,
  onNearMePress, onNearMePressIn, onNearMePressOut, onChooseCityInstead,
  children,
}) {
  const { t } = useI18n();
  // אין יותר רקע-מרובע בכלל, באף מצב (2026-09-20, "no rectangle at all" - בקשת המשתמש המפורשת:
  // "אני לא רוצה את המרובע בכלל מסביב לשום דבר משלושת הכפתורים ולא מסביב למה שנפתח מתחת... יושבים
  // על הרקע של האפליקציה ולא על רקע של מרובע כלשהו") - גם שורת שלוש-הפעולות וגם התוכן-המורחב
  // (חיפוש-חופשי/שני-הפילטרים) יושבים ישירות על SkyBackground, בלי View/LinearGradient עוטף עם
  // רקע/border/radius/צל. discoveryPanel/discoveryPanelExpanded (הישנים, עם רקע-חם/LinearGradient)
  // הוסרו - נשאר View פשוט אחד (discoveryArea) עם מרווחים בלבד, זהה בשני המצבים - בדיוק כמו
  // ה"floating" הקודם שהיה קיים רק במצב-סגור, מוחל עכשיו גם על מצב-מורחב.
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
      {/* discoveryArea (2026-09-20, "no rectangle at all" - בקשת המשתמש המפורשת: אין יותר שום
          רקע/border/radius/צל סביב שורת-שלוש-הפעולות או סביב התוכן-המורחב, באף מצב - הכל יושב
          ישירות על SkyBackground. View פשוט אחד, זהה בשני המצבים (collapsed/expanded) - רק
          מרווחים (marginHorizontal/padding), בלי שום עיצוב-רקע. לא הופך את שלוש הפעולות לשלושה
          pills/cards נפרדים - heroSideAction/nearMeStandalone למטה נשארים בדיוק כמו שהיו, בלי
          רקע/מסגרת/radius משלהם. */}
      <View style={styles.discoveryArea}>
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
              searchMode === 'free' && styles.heroSideActionIconWrapActive,
            ]}
            >
              <Image
                source={require('../assets/home-search-orange.png')}
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
              searchMode === 'guided' && styles.heroSideActionIconWrapActive,
            ]}
            >
              <Image
                source={require('../assets/home-quick-choice-orange.png')}
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
          </Pressable>
        </View>
      </View>
      {/* תוכן-מורחב - מוצג רק כש-searchMode פעיל, בתוך אותו discoveryArea ממש - יושב ישירות על
          SkyBackground, בלי שום divider/border/רקע עוטף (2026-09-20, "no rectangle at all" -
          גם קו-ההפרדה העדין שהיה כאן קודם הוסר, לא רק הרקע). children מגיע מ-app/index.js ללא
          שינוי (input/dropdown-היסטוריה/PersonalPicker/GuidedSearchIntentControl/
          extraFiltersBlock/CTA) - רק המיקום-החזותי השתנה. מרווח (marginTop) בלבד מפריד בין שורת-
          הפעולות לתוכן - האלמנטים הפנימיים עצמם (תיבת-החיפוש/שורות-הפילטר) כבר נושאים רקע/border
          משלהם, אז אין צורך בקו-הפרדה נוסף. */}
      {searchMode ? (
        <View style={styles.discoveryAreaExpanded}>
          {children}
        </View>
      ) : null}
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
  // discoveryArea (2026-09-20, "no rectangle at all" - בקשת המשתמש המפורשת: "אני לא רוצה את
  // המרובע בכלל מסביב לשום דבר משלושת הכפתורים ולא מסביב למה שנפתח מתחת... יושבים על הרקע של
  // האפליקציה") - בלי backgroundColor/border/shadow/borderRadius בכלל, באף מצב (לא רק כשסגור) -
  // רק מרווחים, זהים למה שה"פאנל" הישן נשא (marginHorizontal:-10 וכו') כדי לשמר את הפריסה
  // הגיאומטרית הקיימת ("preserve the current geometric layout") בלי לזוז, רק בלי שום רקע-חזותי.
  discoveryArea: {
    marginHorizontal: -10, paddingTop: 10, paddingBottom: 12, paddingHorizontal: 16,
  },
  // discoveryAreaExpanded - תוכן-חיפוש-חופשי/בחירה-מהירה, יושב ישירות על SkyBackground כמו שורת
  // שלוש-הפעולות מעליו - בלי שום divider/רקע/border עוטף (הוסר גם קו-ההפרדה הדק שהיה כאן קודם).
  // מרווח (marginTop) בלבד בין שורת-הפעולות לתוכן.
  discoveryAreaExpanded: { marginTop: 10 },
  // שורת-הירו התלת-חלקית - flexDirection:'row' פיזי (לא d.row) בכוונה: האפליקציה מכבה forceRTL
  // לגמרי (app/_layout.js), אז 'row' תמיד ממקם את הילד הראשון בקצה הפיזי-שמאלי - חיפוש חופשי
  // משמאל, בחירה מהירה מימין, בסדר-JSX תואם.
  // heroSideCol.flex:1 - בקשת המשתמש המפורשת: "the radar must be geometrically centered in the
  // viewport... Hebrew label lengths are unequal - do not let text width push the radar sideways".
  // שתי עמודות-הצד flex:1 שוות-רוחב-מוחלט (לא תלויות-תוכן) עם alignItems:'center' פנימי, כך
  // שעמודת-המרכז (heroCenterCol, ברוחב-תוכן טבעי) יושבת תמיד בדיוק במרכז הגיאומטרי של השורה.
  // paddingHorizontal:0 (היה 8) - discoveryArea כבר נותן paddingHorizontal:16 משלו, אז
  // הריפוד הישן כאן היה מכפיל את המרווח בצד אחד בלבד ומזיז את המירכוז הגיאומטרי של הרדאר.
  heroRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 8, paddingHorizontal: 0 },
  // paddingTop:14 (היה 22, "small visual polish" round 2, 2026-09-20, בקשת המשתמש: "שני הכפתורים
  // בצדדיו צריכים להיות קצת יותר גבוה, גם הכיתוב וגם האייקונים") - מרים את כל התוכן של שתי
  // העמודות-הצדדיות (אייקון+טקסט יחד, ראו heroSideAction למטה) קצת יותר קרוב לראש השורה.
  heroSideCol: { flex: 1, alignItems: 'center', paddingTop: 14 },
  // לא pill/card ("NOT large pills, NOT cards, NOT competing with the radar visually") - רק
  // אייקון+טקסט, minHeight נדיב ל-touch target נוח.
  // gap:0 (היה 2, "small visual polish" round 4, 2026-09-20, בקשת המשתמש: "לקרב עוד יותר את
  // הכיתוב... לאייקונים שלהם") - חל על שני הצדדים, אותה פרופורציה בדיוק.
  heroSideAction: { alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 0, minHeight: 60, justifyContent: 'center' },
  heroSideActionPressed: { opacity: 0.7 },
  // heroSideActionIconWrap (2026-09-20, "discovery actions visual polish") - מיני-כפתור עגול
  // מוחזר בכוונה (בקשת המשתמש: "the two side actions currently feel more like floating decorative
  // illustrations than actual interactive controls... give them a subtle circular mini-button
  // treatment") - 46px (בטווח 44-48 המבוקש), לא עוד "רק אייקון+טקסט" בלי שום רמז-לחיצות. לבן
  // (colors.card, לא accentTintLight) + border עדין ב-inactive - נשאר "קליל" מול רקע-השמיים
  // (SkyBackground) בלי צל כלל ("minimal or no shadow"), עדיין קורא-בבירור כ"שבב לחיץ" בזכות
  // הניגוד-הפשוט מול הרקע הצבעוני מסביב. heroSideActionIconWrapActive למטה הוא ה-state הפעיל
  // היחיד - לא עוד heroSideActionIconWrapFaded מבוסס-opacity (הוסר: "prefer the circular control
  // + label color as the primary active state").
  heroSideActionIconWrap: {
    width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border,
  },
  heroSideActionIconWrapCompact: { width: 40, height: 40, borderRadius: 20 },
  // heroSideActionIconWrapActive - "when Free Search is active: its mini-circle receives a pale
  // TURU-blue treatment" - accentTintLight (מילוי) + accent (border), אותם טוקנים בדיוק שכבר
  // מייצגים "פעיל" בכל שאר האפליקציה (למשל modeBtnActive, components/LocationQuickPicker.js) -
  // לא paleta חדשה. חשוב עוד יותר עכשיו (2026-09-20, "visual correction: orange icon assets") -
  // האייקונים החדשים (home-search-orange.png/home-quick-choice-orange.png) הם עצמם כתומים-זהב
  // תמיד, גם במצב פעיל וגם לא (כתום = "גילוי", לא "פעיל" - ראו היררכיית-הצבעים בהודעת המשתמש) -
  // אין דרך (ואין כוונה) "לצבוע" תמונת-raster בזמן-ריצה, אז ה-state הפעיל היחיד שיכול לתקשר
  // "זה הבחירה שלך" הוא העיגול הכחול-חיוור מסביב + הטקסט הכחול מתחת, לא האייקון עצמו.
  heroSideActionIconWrapActive: { backgroundColor: colors.accentTintLight, borderColor: colors.accent },
  // heroSideActionIconImage (2026-09-20, "visual correction: orange icon assets" - בקשת המשתמש:
  // "noticeably larger/more expressive than the tiny current icons... start around a 44-48px
  // control/icon area") - 34/27 (היה 28/22) בתוך אותו עיגול 46/40px בדיוק (heroSideActionIconWrap
  // למעלה, לא נגוע) - שוליים של כ-6px מכל צד, מספיק כדי שהעיגול עדיין ניכר כ"מסגרת" סביב
  // האייקון, אבל האייקון עצמו תופס משמעותית יותר מהעיגול מאשר קודם (74% מהקוטר, היה 61%).
  heroSideActionIconImage: { width: 34, height: 34 },
  heroSideActionIconImageCompact: { width: 27, height: 27 },
  // heroSideActionText - 15/11.5 (ללא שינוי) - "הכיתוב 'בחירה מהירה' ו'חיפוש חופשי' צריכים
  // להיות מעט יותר קטנים" (בקשת-עבר).
  heroSideActionText: { fontFamily: fonts.bold, fontSize: 15, textAlign: 'center' },
  heroSideActionTextCompact: { fontSize: 11.5 },
  // ACTIVE: #007598 (colors.accent) - "TURU accent color", בדיוק כמו הרדאר המרכזי - זהות-צבע
  // אחת עקבית ל"פעיל" (עיגול+אייקון+טקסט, שלושתם יחד - "the visual relationship should
  // communicate: I tapped this control, and the panel below belongs to it").
  heroSideActionTextActive: { color: colors.accent },
  // INACTIVE (2026-09-20, "discovery actions visual polish" - בקשת המשתמש: "current side labels
  // are slightly too muted... increase readability/contrast modestly... should no longer feel
  // disabled") - textSecondary (#59656d, כהה יותר מ-textMuted #7a8185 הקודם) - עדיין ברור-משני
  // ביחס ל"קרוב אלי"/לצבע-הפעיל, אבל לא נראה מנוטרל.
  heroSideActionTextInactive: { color: colors.textSecondary },
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
  // marginTop:-12 (2026-09-20, "קרוב אלי צריך להיות קצת יותר גבוה וקרוב לכפתור הגדול") - מקרב את
  // הכיתוב לעיגול הרדאר הנראה בפועל: nearMeRadarWrapCompact (112px) גבוה יותר מהתוכן הנראה בפועל
  // בתוך ה-SVG (ההילה, RADAR_R_HALO, לא ממלאת את כל הקנבס - יש שוליים-שקופים מובנים למטה כדי
  // לתת מקום לטבעת ה-pulse בזמן טעינה), אז בלי הפיצוי הזה הכיתוב נראה "רחוק" מהעיגול הכחול.
  nearMeLabelText: { fontFamily: fonts.bold, fontSize: 15, color: colors.textSecondary, textAlign: 'center', marginTop: -12 },
  nearMeLabelTextCompact: { fontSize: 11.5 },
  nearMeErrorRow: { marginTop: 8, alignItems: 'center' },
  nearMeErrorText: { fontFamily: fonts.semiBold, fontSize: 12, color: colors.danger, textAlign: 'center' },
  nearMeErrorActions: { flexDirection: d.row, alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 4 },
  nearMeErrorLink: { fontFamily: fonts.bold, fontSize: 12, color: colors.accent },
  nearMeErrorDot: { fontSize: 12, color: colors.textMuted },
}));
