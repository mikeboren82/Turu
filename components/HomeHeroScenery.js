import { StyleSheet } from 'react-native';
import Svg, { Path, Ellipse, Circle, Defs, LinearGradient, RadialGradient, Stop, G } from 'react-native-svg';
import { colors } from '../constants/theme';

// TuRu - "Home Screen Visual Redesign" (2026-09-22). שלוש שכבות-גבעה: hillBack (מיד מתחת לשורת-
// הפעולות) חזר לצורת-הבזייה העדינה המקורית (בקשת המשתמש, round 4: "הגל הגדול שעשית למעלה לא
// מתאים, תחזיר למה שהיה"); hillMid/hillFront (round 3, "תעשה אותו טיפה יותר מעניין... הכל צריך
// להיות יותר עגול וגלי") בנויות מגל-סינוס אמיתי דרך wavePath() למטה - קו חלק ועגול לחלוטין, לא
// זוויתי, ויורדות נמוך עם דעיכה ארוכה ומתמשכת (gradientUnits="userSpaceOnUse" עם y1/y2 מוחלטים,
// לא objectBoundingBox שהיה תלוי ב-bbox של כל path בנפרד) - כך שאין שום "קו ישר" נתפס למטה: כל
// שכבה נמסה בהדרגה אמתית אל תוך התוכן שמתחתיה, לא נחתכת בקצה מלבני. כל שלוש השכבות (כולל hillBack
// שחזר לצורתו הישנה) משתמשות באותה טכניקת-גרדיאנט userSpaceOnUse - התיקון ל"קו ישר" נשאר בתוקף
// גם עבורה, רק הצורה עצמה חזרה למה שהייתה.
//
// שכבה משותפת עם SkyBackground.js (שמשמש ~20 מסכים אחרים, לא נגוע כאן - "top area consistent
// across screens"): הרכיב הזה הוא Home-בלבד, מצטייר מעליה, ומתרחב מטה מעבר לשורת-שלוש-הפעולות.
// עדיין SVG טהור (paths/gradients/circles) - בלי bitmap, בלי blur, בלי אנימציה.
const HERO_SCENERY_HEIGHT = 520;
const SHELF_CY = 300;

// גל-סינוס אמיתי דרך נקודות דגומות, מחובר בקטעי Q חלקים (quadratic, נקודת-בקרה = הדגימה עצמה,
// נקודת-קצה = אמצע-הדרך לדגימה הבאה) - טכניקה סטנדרטית לקו גלי-לגמרי-חלק בלי זוויות, בלי צורך
// בספריית-עקומות חיצונית. samples גבוה (14) => גל עשיר יותר ("more interesting"), לא רק גבעה אחת.
function wavePath({ baseline, amplitude, cycles, phase = 0, width = 375, height = HERO_SCENERY_HEIGHT, samples = 14 }) {
  const pts = [];
  for (let i = 0; i <= samples; i++) {
    const x = (width * i) / samples;
    const y = baseline + amplitude * Math.sin((i / samples) * Math.PI * 2 * cycles + phase);
    pts.push({ x, y });
  }
  let d = `M0,${height} L${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p = pts[i]; const n = pts[i + 1];
    const mx = ((p.x + n.x) / 2).toFixed(1); const my = ((p.y + n.y) / 2).toFixed(1);
    d += ` Q${p.x.toFixed(1)},${p.y.toFixed(1)} ${mx},${my}`;
  }
  const last = pts[pts.length - 1];
  d += ` L${last.x.toFixed(1)},${last.y.toFixed(1)} L${width},${height} Z`;
  return d;
}

function HopTrail() {
  // a tiny arc of shrinking dots suggesting a kangaroo hop - ONE playful accent, not a scene.
  // ONLY the biggest dot lives here now - fully behind the button, on purpose (the user confirmed
  // it needs no repositioning: "הנקודה הגדולה שיצאה מאחורי הכפתור - אין בה צורך"). The other three
  // (the visible trail) moved to HomeHero.js's hopDot1/2/3 (2026-09-23, בקשת המשתמש: "לדאוג
  // שהנקודות לא יזוזו עם המסך") - this HomeHeroScenery SVG is a fixed background OUTSIDE the
  // Home ScrollView, while the quick-choice button scrolls WITH the page content, so anything
  // drawn here drifts away from the button the moment the page scrolls. Anchoring the visible
  // trio directly to the button (real Views, same scrolling layout) is the only way to guarantee
  // they never separate from it - this single background dot stays here since it's meant to
  // stay hidden under the button regardless.
  const dots = [
    { x: 300, y: 210, r: 5 },
  ];
  return (
    <G opacity={0.55}>
      {dots.map((d, i) => (
        <Circle key={i} cx={d.x} cy={d.y} r={d.r} fill={colors.logoOrange} opacity={0.5} />
      ))}
    </G>
  );
}

export default function HomeHeroScenery() {
  // hillBack (2026-09-22, בקשת המשתמש: "הגל הגדול שעשית למעלה לא מתאים, תחזיר למה שהיה") - חזרה
  // לצורת-הגבעה העליונה המקורית (עקומת-בזייה עדינה, לא גל-סינוס עשיר) - רק ה-L הסוגר הותאם
  // לגובה-הקנבס החדש (520, היה 470). hillMid/hillFront (למטה) נשארו כמו שהם - "תשאיר את למטה
  // כמו שהוא עכשיו".
  const hillBack = 'M0,290 C60,256 120,312 190,286 C258,260 318,302 375,278 L375,520 L0,520 Z';
  const hillMid = wavePath({ baseline: 336, amplitude: 30, cycles: 1.6, phase: 1.6 });
  const hillFront = wavePath({ baseline: 400, amplitude: 34, cycles: 1.3, phase: 3.1 });

  return (
    <Svg
      width="100%"
      height={HERO_SCENERY_HEIGHT}
      viewBox={`0 0 375 ${HERO_SCENERY_HEIGHT}`}
      style={styles.wrap}
      pointerEvents="none"
      preserveAspectRatio="xMidYMin slice"
    >
      <Defs>
        {/* userSpaceOnUse (לא objectBoundingBox) - קואורדינטות-y מוחלטות, אז הדעיכה קבועה ותלויה
            רק במיקום בפועל על המסך, לא ב-bbox המקרי של כל path. כל שכבה דועכת על פני מרחק ארוך
            (150-180px), לא "כמעט-שקוף פתאום" - זו הדרך שבה נעלם ה"קו ישר" הנתפס. */}
        <LinearGradient id="hillBackGrad" x1="0" y1="240" x2="0" y2="420" gradientUnits="userSpaceOnUse">
          <Stop offset="0" stopColor={colors.heroHillTeal} stopOpacity="0.8" />
          <Stop offset="1" stopColor={colors.heroHillTeal} stopOpacity="0" />
        </LinearGradient>
        <LinearGradient id="hillMidGrad" x1="0" y1="300" x2="0" y2="480" gradientUnits="userSpaceOnUse">
          <Stop offset="0" stopColor={colors.heroHillMint} stopOpacity="0.85" />
          <Stop offset="1" stopColor={colors.heroHillMint} stopOpacity="0" />
        </LinearGradient>
        <LinearGradient id="hillFrontGrad" x1="0" y1="360" x2="0" y2="520" gradientUnits="userSpaceOnUse">
          <Stop offset="0" stopColor={colors.heroHillMint} stopOpacity="0.5" />
          <Stop offset="1" stopColor={colors.heroHillMint} stopOpacity="0" />
        </LinearGradient>
        {/* visible "shelf" behind the three-action cluster - unifies them into one composition */}
        <RadialGradient id="heroShelfGlow" cx="50%" cy="50%" r="50%">
          <Stop offset="0" stopColor={colors.accentTintLight} stopOpacity="1" />
          <Stop offset="0.6" stopColor={colors.accentTint} stopOpacity="0.55" />
          <Stop offset="1" stopColor={colors.accentTint} stopOpacity="0" />
        </RadialGradient>
      </Defs>

      {/* a couple of small drifting puffs bridging sky -> hills, extra visual interest */}
      <G opacity={0.4}>
        <Circle cx="150" cy="150" r="10" fill="#ffffff" />
        <Circle cx="245" cy="170" r="8" fill="#ffffff" />
      </G>

      {/* three real sine-wave hill layers - round and wavy, each melting gradually into the next
          (never a hard/flat edge anywhere) */}
      <Path d={hillBack} fill="url(#hillBackGrad)" />
      <Path d={hillMid} fill="url(#hillMidGrad)" />
      <Path d={hillFront} fill="url(#hillFrontGrad)" />

      {/* the shared "shelf" behind/under the button row - the one connecting visual */}
      <Ellipse cx="187.5" cy={SHELF_CY} rx="188" ry="102" fill="url(#heroShelfGlow)" />

      {/* one playful accent - a tiny kangaroo hop-trail, never more than this */}
      <HopTrail />

      {/* small rounded foliage blobs scattered near the lower hero - restrained, echoes the wave
          shapes above rather than sitting on a flat line */}
      <G opacity={0.5}>
        <Circle cx="34" cy="440" r="14" fill={colors.heroHillTeal} />
        <Circle cx="48" cy="448" r="10" fill={colors.heroHillMint} />
      </G>
      <G opacity={0.45}>
        <Circle cx="348" cy="425" r="12" fill={colors.heroHillMint} />
        <Circle cx="336" cy="435" r="8" fill={colors.heroHillTeal} />
      </G>
      <G opacity={0.35}>
        <Circle cx="190" cy="470" r="9" fill={colors.heroHillTeal} />
      </G>
    </Svg>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', top: 0, left: 0, right: 0 },
});
