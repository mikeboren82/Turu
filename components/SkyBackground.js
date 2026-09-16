import { StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Circle, Rect, G } from 'react-native-svg';
import { colors } from '../constants/theme';

// רקע-השמיים העליון (גרדיאנט תכלת + עננים) - חולץ מ-app/index.js (עמוד הבית, המקור המקורי
// היחיד עד 2026-09-16) לרכיב משותף כדי שיופיע באותו מקום בדיוק בכל מסכי-התוכן הראשיים, בלי
// לשכפל את ה-SVG/גרדיאנט בכל קובץ מסך בנפרד. כולל רק את השמיים+עננים - לא את ה-SunMascot
// (תלוי במדידת ה-Header של עמוד הבית עצמו, ראו headerLayout שם - מאפיין ספציפי לעמוד הבית,
// לא חלק מ"רקע העננים" שהתבקש בכל מקום).
function Cloud({ x, y, scale = 1, opacity = 0.6 }) {
  return (
    <G transform={`translate(${x}, ${y}) scale(${scale})`} opacity={opacity}>
      <Rect x="4" y="14" width="52" height="20" rx="10" fill="#ffffff" />
      <Circle cx="14" cy="16" r="14" fill="#ffffff" />
      <Circle cx="31" cy="10" r="18" fill="#ffffff" />
      <Circle cx="48" cy="17" r="13" fill="#ffffff" />
    </G>
  );
}

export default function SkyBackground() {
  return (
    <>
      <LinearGradient colors={[colors.accentTint, colors.accentTintLight, colors.bg]} style={styles.topGradient} />
      <Svg width="100%" height={230} viewBox="0 0 375 230" style={styles.skyClouds} pointerEvents="none">
        <Cloud x={210} y={18} scale={1.3} opacity={0.5} />
        <Cloud x={40} y={70} scale={0.9} opacity={0.4} />
        <Cloud x={260} y={110} scale={0.7} opacity={0.35} />
      </Svg>
    </>
  );
}

const styles = StyleSheet.create({
  topGradient: {
    position: 'absolute', top: 0, left: 0, right: 0, height: 320,
  },
  skyClouds: {
    position: 'absolute', top: 0, left: 0, right: 0, height: 230,
  },
});
