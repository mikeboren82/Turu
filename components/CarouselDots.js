import { View } from 'react-native';
import { colors } from '../constants/theme';
import { createStyles } from '../lib/i18n';

// TuRu - dot pagination for the Home discovery carousel (2026-09-26, Mobile UI Polish). Purely
// presentational: activeIndex is owned by the caller (app/index.js), driven by the carousel's own
// onMomentumScrollEnd via lib/homeCarousel#carouselActiveIndex - this component only draws it.
// Renders nothing for 0/1 item (a single card has nothing to paginate).
export default function CarouselDots({ count, activeIndex }) {
  if (!count || count <= 1) return null;
  const clampedActive = Math.min(Math.max(activeIndex || 0, 0), count - 1);
  return (
    <View style={styles.row} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {Array.from({ length: count }, (_, i) => (
        <View key={i} style={[styles.dot, i === clampedActive && styles.dotActive]} />
      ))}
    </View>
  );
}

const styles = createStyles(() => ({
  row: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 6, marginTop: 10 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.borderLight },
  dotActive: { width: 16, borderRadius: 3, backgroundColor: colors.accent },
}));
