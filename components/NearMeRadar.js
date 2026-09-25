import { useEffect, useRef } from 'react';
import { Animated, Easing } from 'react-native';
import Svg, { Circle, Path, G, Defs, LinearGradient, Stop, Text as SvgText, TextPath } from 'react-native-svg';
import { LocationPinIcon } from './icons';
import { fonts } from '../constants/theme';
import { useI18n } from '../lib/i18n';

// LOGO_BLUE_TOP/BOTTOM (2026-09-23, בקשת המשתמש: "תבדוק מה הצבע המדויק של האותיות בלוגו עם
// הגרדיאנט ותדאג שבדיוק אותו הצבע יהיה בכפתור הגדול") - נמדדו ישירות מהפיקסלים של
// assets/logo-turu-gradient-transparent.png (אותה שיטה בדיוק כמו colors.logoOrange ב-
// constants/theme.js - מדידת-פיקסלים אמיתית, לא ניחוש): סרקנו את כל שורות ה-"תורי" הכחולות
// (לא כולל "TURU" הקטן מתחת, שהוא מופע-גרדיאנט נפרד), ומיצענו את 6% השורות העליונות/תחתונות
// בנפרד. התוצאה: הגרדיאנט של הלוגו הרבה יותר חי/רווי מ-RADAR_GRADIENT_LIGHT הישן (#0894be) -
// עובר מתכלת-טורקיז בהיר למעלה לכחול עמוק יותר למטה, לא מ"כחול TURU" מרוכך לכחול-בהיר-מרוכך.
// קבועים מקומיים (לא ב-theme.js) בכוונה - השינוי מוגבל ל"כפתור הגדול" (הדיסקית המרכזית של
// NearMeRadar) בלבד, לא ל-colors.accent הכללי שמשמש בעשרות מקומות אחרים באפליקציה.
const LOGO_BLUE_TOP = '#03b9da';
const LOGO_BLUE_BOTTOM = '#01499b';

// PHASE 1 EXTRACTION (2026-09-19, "safe presentational extraction" - ראו הביקורת הארכיטקטונית):
// הועבר byte-for-byte מ-app/index.js, בלי שום שינוי בגיאומטריה/פרופס/state-ownership - קומפוננטה
// טהורה-לחלוטין (loading/color/showLabel כ-props בלבד, בלי fetch/navigation/business logic משלה)
// שהייתה כבר מבודדת ומוכנה-לחלוטין לעצמאות (כל הקבועים למטה משמשים אך ורק אותה).
//
// --- 📍 NearMeRadar (2026-09-19/20, בקשת המשתמש: "TURU ORBIT / DISCOVERY BUTTON", לא מכשיר-
// רדאר) - סבב-עידון שני אחרי משוב: "נראה כמו מכשיר-רדאר/מטרה, המרכז הכהה שולט מדי, הטבעות
// הדקות מרגישות טכניות, הטקסט קטן/מנותק, 'לחצו לגלות' מיותר, הסימונים נראים כמו מד/שמש, אייקון-
// המיקום קטן מדי". גיאומטריה קבועה (לא magic numbers ב-JSX): דיסקית מרכזית (RADAR_R_CIRCLE,
// קוטר 76px - בתוך הטווח 72-84 מהבקשה, קטן מהגרסה הקודמת), הילה-אור רכה מסביבה (RADAR_R_HALO -
// לא עוד טבעת-קו, ממלאת ומקשרת בעדינות בין הדיסקית לאורביט), ושתי "שכבות-אורביט" משמעותיות
// בלבד (לא כמה טבעות-רדאר זהות): הפנימית קצת יותר נוכחת, החיצונית עדינה מאוד - קוטר-אורביט
// מלא 116px (בתוך 110-125 מהבקשה). בלי סימוני-טיק בכלל (הוסרו לגמרי - נראו כמו מד/שמש). 2-3
// "נקודות-גילוי" זעירות באורביט, בזוויות/רדיוסים לא-סימטריים בכוונה (לא רשת מכנית - "playful
// asymmetry" מהלוגו). קשת-הטקסט ("מה קורה סביבי?", TextPath אמיתי) גדולה וקרובה יותר לאורביט -
// חלק מהאובייקט, לא כיתוב צף. הצבע: colors.accent הקיים בלבד - אותו טוקן שכבר מייצג את הכחול-
// טורקיז של האות ת' הראשונה בלוגו (אומת מול פיקסלי הלוגו בפועל, לא ניחוש/הערכה) - לא צבע כהה
// גנרי, לא גרדיאנט אקראי.
const RADAR_CX = 90;
const RADAR_CY = 90;
const RADAR_R_CIRCLE = 38; // קוטר 76px
const RADAR_R_HALO = 47; // הילה רכה (fill, לא stroke) - "קשר חזק יותר בין המרכז לאורביט"
const RADAR_R_ORBIT_OUTER = 58; // קוטר-אורביט מלא 116px - עדיין קובע את pulseRadius/גובה-הקנבס,
// גם אחרי שהטבעת-הפנימית (RADAR_R_ORBIT_INNER, הוסרה 2026-09-20 - ראו ההערה למטה) כבר לא מצוירת.
const RADAR_R_TEXT = 73;
const RADAR_TEXT_HALF_ANGLE = 58; // קשת רחבה (116°) - אותיות גדולות בלי להידחס
const radarPoint = (r, angleDeg) => {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: RADAR_CX + r * Math.cos(rad), y: RADAR_CY - r * Math.sin(rad) };
};
// קשת הטקסט - מ-(180-(90-חצי-זווית))° (שמאל) ל-(90-חצי-זווית)° (ימין), עוברת דרך 90° (למעלה,
// האפקס) - "0 1" (large-arc=0, sweep=1) מצייר את הקשת הקצרה שמתקפלת כלפי מעלה.
const radarTextArcStart = radarPoint(RADAR_R_TEXT, 180 - (90 - RADAR_TEXT_HALF_ANGLE));
const radarTextArcEnd = radarPoint(RADAR_R_TEXT, 90 - RADAR_TEXT_HALF_ANGLE);
const RADAR_TEXT_ARC_PATH = `M ${radarTextArcStart.x} ${radarTextArcStart.y} A ${RADAR_R_TEXT} ${RADAR_R_TEXT} 0 0 1 ${radarTextArcEnd.x} ${radarTextArcEnd.y}`;
// שינוי-פרמטר יחיד בכוונה (RADAR_SVG_W בלבד), לא recompute של כל רדיוס-פנימי בנפרד: viewBox
// נשאר "0 0 180 <גובה>" בדיוק כמו תמיד, אז שינוי ה-width בלבד מגדיל/מקטין את כל התוכן הפנימי
// (דיסקית/הילה/טבעות/נקודות/פין) פרופורציונלית ובאופן אחיד, בלי לגעת באף קבוע-רדיוס/זווית
// בנפרד - מבטל כליל סיכון ל"קליפינג" או הזזת-נקודות שהיה נובע מהגדלת/הקטנת-רדיוסים ידנית.
// 158 (היה 134, "small visual polish" round 2, 2026-09-20, בקשת המשתמש: "הכפתור הגדול צריך
// להיות יותר גדול" - חזרה לגודל המוכר/מאושר הקודם) - פרמטר יחיד (ראו ההערה למעלה) אז כל
// הגיאומטריה הפנימית (דיסקית/הילה/טבעות/נקודות) גדלה פרופורציונלית יחד, בלי שינוי ביחסים
// הפנימיים - עדיין מעוגל ומרוכז בדיוק כמו קודם. קוטר-האורביט החיצוני בפועל
// (RADAR_R_ORBIT_OUTER*2=116 בתוך viewBox 180 רוחב) = RADAR_SVG_W * (116/180) ≈ 101.9px.
// 174 (היה 158, "Home Screen Visual Redesign" round 2, 2026-09-22, בקשת המשתמש: "large center
// primary circle" + "do not shrink its importance") - פרמטר יחיד (ראו ההערה למעלה), כל הגיאומטריה
// הפנימית גדלה פרופורציונלית יחד.
const RADAR_SVG_W = 174;
const RADAR_SVG_H = 160;
// גובה-קנבס קומפקטי (2026-09-20, בקשת המשתמש: הרדאר עצמו הוא הגיבור המרכזי בשורת-הירו החדשה,
// בלי קשת-הטקסט "מה קורה סביבי?" סביבו - שלוש התוויות הסמוכות (חיפוש חופשי/בחירה מהירה + כיתוב-
// מרחק מתחת) כבר מספרות את הסיפור). מרכז אנכי חדש (RADAR_COMPACT_CY) ממורכז סביב האורביט בלבד,
// בלי לגעת בקבועי-הגיאומטריה המקוריים (RADAR_CX/CY וכו') - כל התוכן הלא-טקסטואלי עובר ב-<G
// transform> אחד בזמן-רינדור, לא סט-קבועים כפול.
const RADAR_COMPACT_CY = RADAR_R_ORBIT_OUTER + 6;
const RADAR_COMPACT_H = RADAR_COMPACT_CY * 2;
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

// pulse עדין-אחד-בכל-פעם (לא הבזק/סיבוב) בזמן איתור GPS - טבעת-אורביט "נושמת" החוצה ומתפוגגת,
// לופ איטי (1.7s) כל עוד loading===true; מפסיק/מתאפס לגמרי כש-loading הופך false (לא ממשיך
// "לרפרף" ברקע). useNativeDriver:false כי מונפשים r/opacity של צורת-SVG (לא transform/opacity
// של View רגיל - הדרייבר הנייטיבי לא תומך ב-r).
// showLabel (2026-09-20, בקשת המשתמש: "TURU home reference mockup") - false בשורת-הירו החדשה:
// מדלג על ה-Defs/Path/TextPath של קשת-הטקסט לגמרי (לא רק מסתיר ב-opacity:0 - חוסך גם את
// ה-canvas הגבוה יותר שהיא דרשה), ומרכז את שאר התוכן (טבעות/נקודות/הילה/דיסקית/פין) אנכית
// מחדש דרך <G transform> יחיד סביב RADAR_COMPACT_CY. אין שינוי בקבועי-הגיאומטריה המשותפים
// עצמם - showLabel רק בוחר איזה cy/canvas-height להשתמש בהם.
export default function NearMeRadar({ loading, color, showLabel = true }) {
  const { t } = useI18n();
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!loading) { pulse.setValue(0); return undefined; }
    const loop = Animated.loop(
      Animated.timing(pulse, { toValue: 1, duration: 1700, easing: Easing.out(Easing.ease), useNativeDriver: false })
    );
    loop.start();
    return () => { loop.stop(); pulse.setValue(0); };
  }, [loading, pulse]);
  const pulseRadius = pulse.interpolate({ inputRange: [0, 1], outputRange: [RADAR_R_ORBIT_OUTER, RADAR_R_ORBIT_OUTER + 16] });
  const pulseOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.4, 0] });
  const svgHeight = showLabel ? RADAR_SVG_H : RADAR_SVG_W * (RADAR_COMPACT_H / 180);
  const recenter = showLabel ? undefined : `translate(0, ${RADAR_COMPACT_CY - RADAR_CY})`;

  const dial = (
    <G transform={recenter}>
      {loading ? <AnimatedCircle cx={RADAR_CX} cy={RADAR_CY} r={pulseRadius} fill="none" stroke={color} strokeWidth={1.5} opacity={pulseOpacity} /> : null}
      {/* טבעת-האורביט החיצונית (r=RADAR_R_ORBIT_OUTER) הוסרה (2026-09-20, "visual polish: free
          search + quick choice" - בקשת המשתמש: "reduce the visual prominence of the decorative
          radar rings... preferably remove one unnecessary ring") - הייתה הכי-עדינה מלכתחילה
          (opacity 0.18), חופפת חזותית לטבעת-הפנימית+להילה. RADAR_R_ORBIT_OUTER עצמו נשאר קבוע-
          גיאומטריה בשימוש (ה-pulse/svgHeight) - רק הצורה-הסטטית-עצמה לא מצוירת יותר.
          "נקודות-הגילוי" הוסרו גם הן (2026-09-20, בקשת המשתמש: "יש 3 נקודות קטנות מסביב לכפתור
          המרכזי, לא רואה בהם צורך" - RADAR_DOTS הוסר לגמרי, ראו git history).
          טבעת-האורביט הפנימית (r=51, הקבוע RADAR_R_ORBIT_INNER עצמו הוסר - לא נשאר בשימוש
          בשום מקום אחר, בניגוד ל-OUTER למעלה) הוסרה גם היא (2026-09-20, "discovery actions
          visual polish" - בקשת המשתמש: "the current concentric rings are somewhat visually
          busy... remove one redundant ring") - הילה-האור (RADAR_R_HALO, fill רך) כבר נותנת
          בעצמה את "הקשר בין המרכז לאורביט" שהטבעת-הדקה ניסתה להוסיף, אז שתיהן יחד קראו "טבעתי"
          יותר מהנדרש. נשארים: הילה (fill רך) + דיסקית-מרכז מלאה + אייקון-המיקום - "keep: central
          blue circle, location icon, strong central positioning". */}
      {/* טבעת דקה וברורה (stroke) במקום הילה רכה ומטושטשת (fill) - "Home Screen Visual Redesign"
          round 2 (2026-09-22, בקשת המשתמש: "cleaner outer ring... reduce exaggerated depth...
          less spherical/puffy"). fill רך תמיד קורא כ"זוהר/נפח" (עומק מלאכותי); קו דק וחד סביב
          ההילה נותן בדיוק את "הקשר בין המרכז לאורביט" שההילה נתנה, אבל בשפה שטוחה ומודרנית. */}
      <Circle cx={RADAR_CX} cy={RADAR_CY} r={RADAR_R_HALO} fill="none" stroke={color} strokeWidth={2.5} opacity={0.28} />
      {/* fill="url(#nearMeDiscGradient)" - גרדיאנט תואם-לוגו, לא צבע אחיד - ראו LOGO_BLUE_TOP/
          BOTTOM למעלה וה-Defs ב-JSX החיצוני להגדרת ה-gradient עצמו. */}
      <Circle cx={RADAR_CX} cy={RADAR_CY} r={RADAR_R_CIRCLE} fill="url(#nearMeDiscGradient)" />
      {/* אותו LocationPinIcon בדיוק כמו בכל שאר האפליקציה (למשל LocationQuickPicker) - לא צורת-פין
          חדשה מצוירת ידנית, רק גדול יותר (32, היה 24 - "too small relative to the disc"). נשאר
          מוצג גם בזמן טעינה (סעיף 10 בבקשה: "animate the ORBIT rather than replacing the
          component" - לא מוחלף ב-spinner, ה-pulse מסביב הוא סימון-הטעינה היחיד).
          color: "#ffffff" (היה colors.logoOrange, 2026-09-20, "visual refinement: Near Me color
          treatment" - בקשת המשתמש: "Remove the orange from the central Near Me control... make
          the pin white or a very pale blue/white - whichever has the best contrast") - לבן מלא
          נבחר: הניגוד הכי-חד מול הדיסקית הכחולה-גרדיאנטית מתחתיו, בלי שום כתום במרכז יותר -
          הכתום היחיד במסך הבית עכשיו הוא אך ורק שני האייקונים הצדדיים. שינוי-פרופ' יחיד (רק
          color) - שום שינוי בגיאומטריה/גודל/מבנה של הרדאר עצמו. */}
      <G transform={`translate(${RADAR_CX - 16}, ${RADAR_CY - 16})`}>
        <LocationPinIcon size={32} color="#ffffff" />
      </G>
    </G>
  );

  return (
    // דקורטיבי-בלבד: הכפתור המכיל (Pressable) כבר accessibilityLabel אחד ל-screen reader - הטקסט/
    // נקודות/טבעות כאן לא אמורים להיחשף כאלמנטים נפרדים משלהם. importantForAccessibility/
    // accessibilityElementsHidden חייבים לשבת על ה-View העוטף (nearMeRadarWrap, ב-JSX החיצוני) -
    // לא כאן על <Svg> עצמו: ב-react-native-web הם props לא-מוכרים שדולפים ל-DOM כ-attributes
    // לא-חוקיים (console warnings) על <svg> גולמי, בניגוד ל-View אמיתי שכן יודע לפרש אותם.
    <Svg width={RADAR_SVG_W} height={svgHeight} viewBox={`0 0 180 ${showLabel ? 170 : RADAR_COMPACT_H}`} pointerEvents="none">
      {/* Defs (2026-09-20, "visual refinement: Near Me color treatment") - הועבר להיות תמיד-קיים
          (לא רק כש-showLabel), כי הדיסקית-המרכזית (fill="url(#nearMeDiscGradient)" למעלה) צריכה
          את ה-gradient הזה גם במצב הקומפקטי (showLabel=false, השימוש היחיד בפועל ב-HomeHero.js) -
          הטקסט-קשת (nearMeRadarTextPath) עדיין מותנה-showLabel כמו קודם, רק ה-Defs העוטף אותו לא.
          x1/y1/x2/y2 (0,0)->(0,1) - גרדיאנט אנכי פשוט, לא אלכסוני/רדיאלי שהיה יכול להיראות
          "glossy". כיוון הופך (2026-09-23, "תבדוק... בדיוק אותו הצבע") - בהיר-טורקיז למעלה,
          כחול-עמוק למטה, זהה לכיוון הגרדיאנט האמיתי באותיות הלוגו עצמו (ראו LOGO_BLUE_TOP/BOTTOM
          למעלה) - לא רק אותם שני צבעים, גם אותו כיוון. */}
      <Defs>
        <LinearGradient id="nearMeDiscGradient" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={LOGO_BLUE_TOP} />
          <Stop offset="1" stopColor={LOGO_BLUE_BOTTOM} />
        </LinearGradient>
        {showLabel ? <Path id="nearMeRadarTextPath" d={RADAR_TEXT_ARC_PATH} fill="none" /> : null}
      </Defs>
      {showLabel ? (
        <>
          {dial}
          <SvgText fill={color} fontSize={16} fontFamily={fonts.semiBold} textAnchor="middle">
            <TextPath href="#nearMeRadarTextPath" startOffset="50%">
              {t('home.nearMe.radarLabel')}
            </TextPath>
          </SvgText>
        </>
      ) : dial}
    </Svg>
  );
}
