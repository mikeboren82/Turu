import { View, Image } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { colors, spacing } from '../constants/theme';
import { createStyles } from '../lib/i18n';

// PHASE 1 EXTRACTION (2026-09-19, "safe presentational extraction" - ראו הביקורת הארכיטקטונית) -
// הועבר byte-for-byte מ-app/index.js. props-בלבד (width, מחושב ב-HomeScreen מ-
// Math.min(windowWidth, CONTENT_MAX_WIDTH) - התקרה עצמה, CONTENT_MAX_WIDTH, נשארת ב-app/index.js
// כי גם styles.content שם תלוי בה).

// יחס הרוחב/גובה של איור הדשא (assets/grass-footer.png).
const GRASS_ASPECT_RATIO = 939 / 148;

// רוחב/גובה מחושבים במספרים מוחלטים (לא aspectRatio על ה-View + '100%' על ה-Image) - השילוב
// הזה ידוע כבעייתי ב-Yoga על אנדרואיד (נצפה בפועל: התמונה נחתכה/הוצגה רק בחלק מהרוחב על מכשיר
// אמיתי, למרות שברשת זה עבד מושלם) - width/height מפורשים בפיקסלים על שני האלמנטים עוקפים את
// זה לגמרי, בלי תלות בחישוב פנימי של aspectRatio+percent.
export default function GrassFooter({ width }) {
  const height = width / GRASS_ASPECT_RATIO;
  return (
    <View style={[styles.grassFooter, { width, height }]} pointerEvents="none">
      <Image
        source={require('../assets/grass-footer.png')}
        style={{ width, height }}
        resizeMode="stretch"
      />
      <LinearGradient
        colors={[colors.bg, colors.bg, 'transparent']}
        locations={[0, 0.05, 0.42]}
        style={[styles.grassFooterFade, { width, height }]}
      />
    </View>
  );
}

const styles = createStyles(() => ({
  grassFooter: {
    marginTop: 28, marginHorizontal: -spacing.xl,
  },
  grassFooterFade: { position: 'absolute', top: 0, left: 0 },
}));
