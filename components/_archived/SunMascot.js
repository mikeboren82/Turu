// ⛅ ARCHIVED (2026-09-19, בקשת המשתמש: "להוריד את השמש לחלוטין מהמסך הראשי, שמור אותה בצד
// בארכיון למקרה שארצה להחזיר אותה בהמשך") - הוסר מעמוד הבית הפעיל (app/index.js). הקובץ הזה
// עצמאי ומוכן-לשימוש (לא רק תיעוד) - כדי להחזיר את השמש:
//
//   1. import { SunMascot, sunMascotStyles } from '../components/_archived/SunMascot';
//   2. state: const [headerLayout, setHeaderLayout] = useState(null);
//   3. JSX (מייד אחרי <SkyBackground/>, מחוץ ל-ScrollView): <SunMascot headerLayout={headerLayout} />
//   4. <Header onMenuPress={() => {}} onHeaderLayout={setHeaderLayout} ... />
//      (onHeaderLayout הוא prop קיים וייעודי ל-Header - components/Header.js לא שונה, עדיין תומך בו)
//
// (הקוד עצמו - כולל ה-SVG וה-style - זהה byte-for-byte למה שהיה פעיל ב-app/index.js.)

import { StyleSheet, Platform } from 'react-native';
import Svg, { Circle, Line, Path, G } from 'react-native-svg';

// גובה+רוחב הכוכב/שמש נגזרים ממדידה אמיתית של שורת ה-Header (onHeaderLayout, ראו HomeScreen)
// במקום ערך top קבוע - ערך קבוע התאים בדיוק לדפדפן (שם אין status bar/insets) אבל לא תאם
// למכשיר אמיתי (הכפתור והשמש יצאו בגבהים שונים). fallback ל-46 עד שהמדידה הראשונה מגיעה.
export function SunMascot({ headerLayout }) {
  const top = headerLayout ? headerLayout.y + headerLayout.height / 2 - 28 : 46;
  return (
    <Svg width={56} height={56} viewBox="0 0 120 120" style={[sunMascotStyles.sunMascot, { top }]} pointerEvents="none">
      <G>
        {[...Array(10)].map((_, i) => {
          const angle = (i * 36 * Math.PI) / 180;
          const x1 = 60 + Math.cos(angle) * 40;
          const y1 = 60 + Math.sin(angle) * 40;
          const x2 = 60 + Math.cos(angle) * 50;
          const y2 = 60 + Math.sin(angle) * 50;
          return <Line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#ffc23d" strokeWidth={7} strokeLinecap="round" />;
        })}
      </G>
      <Circle cx="60" cy="60" r="36" fill="#ffcb52" />
      <Circle cx="46" cy="52" r="4.5" fill="#f8ab2e" opacity={0.5} />
      <Circle cx="76" cy="66" r="6" fill="#f8ab2e" opacity={0.4} />
      <Circle cx="46" cy="70" r="4.5" fill="#ff9fc7" opacity={0.55} />
      <Circle cx="78" cy="52" r="4.5" fill="#ff9fc7" opacity={0.55} />
      <Path d="M45 56 Q49 51 53 56" fill="none" stroke="#7a4a12" strokeWidth={3} strokeLinecap="round" />
      <Path d="M63 56 Q67 51 71 56" fill="none" stroke="#7a4a12" strokeWidth={3} strokeLinecap="round" />
      <Path d="M47 66 Q59 76 70 65" fill="none" stroke="#7a4a12" strokeWidth={3} strokeLinecap="round" />
      <Circle cx="86" cy="82" r="15" fill="none" stroke="#007598" strokeWidth={5} />
      <Line x1="96" y1="92" x2="106" y2="102" stroke="#007598" strokeWidth={6} strokeLinecap="round" />
    </Svg>
  );
}

export const sunMascotStyles = StyleSheet.create({
  sunMascot: {
    // 'fixed' בווב: הדף עצמו גולל (לא ה-ScrollView הפנימי בלבד), אז 'absolute' רגיל היה נגרר
    // עם התוכן במקום להישאר צמוד לפינת המסך. ב-native ה-ScrollView כן קוצץ את עצמו כראוי,
    // ו-'fixed' לא קיים ב-RN native - 'absolute' שם כבר נשאר במקום כמצופה.
    // Opposite the menu button, which stays top-right in both languages (Header is physical).
    position: Platform.OS === 'web' ? 'fixed' : 'absolute', top: 46, left: 10,
  },
});
