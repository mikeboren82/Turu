import { useMemo, useState } from 'react';
import { View, Text, Pressable, Image } from 'react-native';
import MapView, { Marker } from 'react-native-maps';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { colors, fonts, radii } from '../constants/theme';
import { ChevronLeftIcon } from './icons';
import { placeholderImageFor, placeholderBgColorFor } from '../lib/placeholderImages';
import { useI18n, createStyles } from '../lib/i18n';
import { categoryLabel } from '../lib/i18n/format';

const ISRAEL_CENTER = { latitude: 31.4, longitude: 34.9 };

function regionFor(withCoords, deviceCoords) {
  if (deviceCoords) {
    return { latitude: deviceCoords.latitude, longitude: deviceCoords.longitude, latitudeDelta: 0.2, longitudeDelta: 0.2 };
  }
  if (withCoords.length === 0) {
    return { ...ISRAEL_CENTER, latitudeDelta: 3.5, longitudeDelta: 3.5 };
  }
  const lats = withCoords.map((a) => a.lat);
  const lngs = withCoords.map((a) => a.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  return {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLng + maxLng) / 2,
    latitudeDelta: Math.max(maxLat - minLat, 0.05) * 1.4,
    longitudeDelta: Math.max(maxLng - minLng, 0.05) * 1.4,
  };
}

export default function ActivitiesMap({ activities, deviceCoords }) {
  const router = useRouter();
  const { t, dir } = useI18n();
  const [selectedId, setSelectedId] = useState(null);

  const withCoords = useMemo(() => activities.filter((a) => a.lat != null && a.lng != null), [activities]);
  const region = useMemo(() => regionFor(withCoords, deviceCoords), [withCoords, deviceCoords]);
  const selected = withCoords.find((a) => a.id === selectedId) || null;

  return (
    <View style={styles.wrap}>
      <MapView style={styles.map} initialRegion={region} onPress={() => setSelectedId(null)}>
        {withCoords.map((a) => (
          <Marker
            key={a.id}
            coordinate={{ latitude: a.lat, longitude: a.lng }}
            pinColor={selectedId === a.id ? colors.coralStrong : colors.accent}
            onPress={(e) => { e.stopPropagation?.(); setSelectedId(a.id); }}
          />
        ))}
      </MapView>

      {withCoords.length === 0 ? (
        <View style={styles.emptyOverlay}>
          <Text style={styles.emptyText}>{t('activities.map.emptyOverlay')}</Text>
        </View>
      ) : null}

      {selected ? (
        <Pressable style={styles.previewCard} onPress={() => router.push(`/activity/${selected.id}`)}>
          {selected.imageUrl ? (
            <Image source={{ uri: selected.imageUrl }} style={styles.previewImage} />
          ) : placeholderImageFor(selected.placeholderGroup) ? (
            <Image
              source={placeholderImageFor(selected.placeholderGroup)}
              resizeMode="contain"
              style={[styles.previewImage, { backgroundColor: placeholderBgColorFor(selected.placeholderGroup) }]}
            />
          ) : (
            <LinearGradient colors={selected.gradient} style={styles.previewImage} />
          )}
          <View style={styles.previewBody}>
            <Text style={styles.previewTitle} numberOfLines={1}>{selected.title}</Text>
            <Text style={styles.previewMeta} numberOfLines={1}>{categoryLabel(selected.type)} · {selected.ageRange} · {selected.price}</Text>
          </View>
          <View style={{ transform: [{ rotate: dir.forwardRotate }] }}><ChevronLeftIcon /></View>
          <Pressable style={styles.previewClose} onPress={(e) => { e.stopPropagation?.(); setSelectedId(null); }} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('common.actions.close')}>
            <Text style={styles.previewCloseText}>✕</Text>
          </Pressable>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = createStyles((d) => ({
  wrap: { height: 480, borderRadius: radii.lg, overflow: 'hidden', position: 'relative', backgroundColor: colors.card },
  map: { flex: 1 },
  emptyOverlay: {
    position: 'absolute', top: 14, left: 14, right: 14,
    backgroundColor: 'rgba(255,255,255,0.95)', borderRadius: radii.md, padding: 10,
  },
  emptyText: { fontFamily: fonts.semiBold, fontSize: 12.5, color: colors.textSecondary, textAlign: 'center' },
  previewCard: {
    position: 'absolute', bottom: 12, left: 12, right: 12,
    flexDirection: d.row, alignItems: 'center', gap: 10,
    backgroundColor: colors.card, borderRadius: radii.lg, borderWidth: 1, borderColor: colors.border,
    padding: 10, shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 6,
  },
  previewImage: { width: 54, height: 54, borderRadius: radii.md, backgroundColor: colors.borderLight },
  previewBody: { flex: 1 },
  previewTitle: { fontFamily: fonts.extraBold, fontSize: 14, color: colors.textPrimary, textAlign: d.textAlign },
  previewMeta: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.textSecondary, textAlign: d.textAlign, marginTop: 2 },
  previewClose: {
    position: 'absolute', top: -8, [d.end]: -8, width: 24, height: 24, borderRadius: 12,
    backgroundColor: colors.textMuted, alignItems: 'center', justifyContent: 'center',
  },
  previewCloseText: { color: '#fff', fontSize: 12, fontFamily: fonts.bold },
}));
