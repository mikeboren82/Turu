import { View, Text, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useToast, dismissToast } from '../lib/toast';
import { useI18n, createStyles } from '../lib/i18n';
import { colors, fonts, radii, spacing } from '../constants/theme';

// רכיב-תצוגה יחיד להודעות lib/toast.js - מרונדר פעם אחת ב-app/_layout.js, מעל <BottomNav/>
// (לא בתוך מסך ספציפי), כדי שאותה הודעה תעבוד מכל מקום ותישאר גלויה גם אחרי ניווט. לא-חוסם
// (position:absolute, pointerEvents:box-none על העטיפה) - אין Modal/backdrop, אין overlay
// שתופס את כל המסך; accessibilityLiveRegion כדי שקוראי-מסך יכריזו עליה אוטומטית.
export default function ToastHost() {
  const toast = useToast();
  const { t, dir } = useI18n();
  const insets = useSafeAreaInsets();
  if (!toast) return null;
  return (
    <View style={[styles.wrap, { bottom: 55 + Math.max(insets.bottom, 10) }]} pointerEvents="box-none">
      <View
        style={styles.toast}
        accessibilityRole="alert"
        accessibilityLiveRegion="polite"
        importantForAccessibility="yes"
      >
        <Text style={styles.text} numberOfLines={2}>{toast.message}</Text>
        {toast.actionLabel ? (
          <Pressable
            onPress={() => { toast.onAction?.(); dismissToast(); }}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={toast.actionLabel}
          >
            <Text style={styles.actionText}>{toast.actionLabel}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = createStyles((d) => ({
  wrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center', zIndex: 999, paddingHorizontal: spacing.lg },
  toast: {
    flexDirection: d.row, alignItems: 'center', gap: 14, maxWidth: 420, width: '100%',
    backgroundColor: colors.ink, borderRadius: radii.lg, paddingVertical: 12, paddingHorizontal: 16,
    shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 6,
  },
  text: { flex: 1, fontFamily: fonts.semiBold, fontSize: 13.5, color: '#fff', textAlign: d.textAlign },
  actionText: { fontFamily: fonts.extraBold, fontSize: 13.5, color: colors.accentTint },
}));
