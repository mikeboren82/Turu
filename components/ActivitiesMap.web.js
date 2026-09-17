// מפה אמיתית ל-Web (Expo Web/react-native-web) - מחליפה את הודעת ה"-זמין רק בנייד" הישנה.
// Leaflet + OpenStreetMap: ללא מפתח/סוד בקוד הלקוח (סעיף בבקשה: "אל תכניס סודות") - תשומת-לב
// לספק (OSM attribution) מגיעה מובנית מ-<TileLayer attribution>. קובץ זה נטען אך ורק בבאנדל
// ה-Web (הסיומת .web.js), אז leaflet/react-leaflet לעולם לא נכנסים לבאנדל native - אין סיכון
// לשבור את iOS/Android (components/ActivitiesMap.js הרגיל, עם react-native-maps, ממשיך כמו
// שהיה, ללא שינוי). ה-props (activities, deviceCoords) זהים לגמרי לגרסה הנייטיבית.
import { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Pressable, Image, ScrollView } from 'react-native';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useRouter } from 'expo-router';
import { colors, fonts, radii } from '../constants/theme';
import { ChevronLeftIcon } from './icons';
import { placeholderImageFor, placeholderBgColorFor } from '../lib/placeholderImages';
import { useI18n, createStyles } from '../lib/i18n';
import { categoryLabel } from '../lib/i18n/format';

const ISRAEL_CENTER = [31.4, 34.9];
const DEFAULT_ZOOM = 7.5;
const SINGLE_POINT_ZOOM = 14;

// אייקון-סיכה מצויר (CSS דרך divIcon), לא תמונת-ברירת-המחדל של Leaflet - הימנעות מודעת מהבאג
// המוכר-היטב "leaflet + bundler = נתיב-תמונת-ברירת-מחדל שבור" (marker-icon.png לא נפתר נכון
// תחת Metro/webpack ללא הגדרה ידנית), בלי תלות חדשה/asset נוסף. צבע זהה לגמרי לזה שכבר קיים
// במפת-הנייד (colors.accent/colors.coralStrong לפי selected) - אותה שפה חזותית בשתי הפלטפורמות.
function pinIcon(color, selected) {
  const size = selected ? 34 : 26;
  return L.divIcon({
    className: 'turu-map-pin',
    html: `<div style="width:${size}px;height:${size}px;border-radius:50% 50% 50% 0;background:${color};transform:rotate(-45deg);border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.35);"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size],
    popupAnchor: [0, -(size + 6)],
  });
}

// נקודת "המיקום שלי" - עיגול כחול פשוט, שונה בבירור מסיכות הפעילויות. תוספת ויזואלית בלבד אם
// יש deviceCoords - המפה עצמה עובדת זהה בלעדיו (סעיף בבקשה: "מיקום המשתמש הוא תוספת, לא תנאי").
const USER_DOT_ICON = L.divIcon({
  className: 'turu-map-user-dot',
  html: '<div style="width:16px;height:16px;border-radius:50%;background:#1a73e8;border:3px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,0.25);"></div>',
  iconSize: [16, 16],
  iconAnchor: [8, 8],
});

// מקבצים לפי קואורדינטה מעוגלת (~1 מטר דיוק) - כמה פעילויות באותה נקודה בדיוק (אותו מבנה/כתובת)
// מקבלות סיכה אחת עם פופ-אפ שמציג רשימה, במקום סיכות חופפות שרק העליונה ביניהן לחיצה (סעיף
// בבקשה: "טיפול בפעילות בודדת ובכמה פעילויות באותה נקודה") - לא ספריית clustering חדשה.
function groupByCoord(activities) {
  const groups = new Map();
  for (const a of activities) {
    const key = `${a.lat.toFixed(5)},${a.lng.toFixed(5)}`;
    if (!groups.has(key)) groups.set(key, { lat: a.lat, lng: a.lng, items: [] });
    groups.get(key).items.push(a);
  }
  return [...groups.values()];
}

// מתאים את התצוגה ההתחלתית לתוצאות (סעיף בבקשה) - פעם אחת ב-mount בלבד, לא reactive על כל שינוי
// סינון: זהה בכוונה ל-initialRegion של המפה הנייטיבית (components/ActivitiesMap.js) - שם gם
// "initial" (לא controlled) כבר ההתנהגות הקיימת/המאושרת, לא משהו חדש שממציאים כאן רק ל-Web.
function FitOnMount({ groups, deviceCoords }) {
  const map = useMap();
  useEffect(() => {
    if (groups.length === 1) {
      map.setView([groups[0].lat, groups[0].lng], SINGLE_POINT_ZOOM);
      return;
    }
    if (groups.length > 1) {
      const bounds = L.latLngBounds(groups.map((g) => [g.lat, g.lng]));
      map.fitBounds(bounds, { padding: [36, 36], maxZoom: 15 });
      return;
    }
    // groups.length === 0: אין שום פעילות עם קואורדינטות - נופלים ל-deviceCoords (בונוס, לא
    // תנאי) ואז לתצוגת-כל-הארץ, בדיוק כמו regionFor() במפה הנייטיבית.
    if (deviceCoords) {
      map.setView([deviceCoords.latitude, deviceCoords.longitude], 12);
    } else {
      map.setView(ISRAEL_CENTER, DEFAULT_ZOOM);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

// תוכן-הפופ-אפ לנקודה עם פעילות אחת - כרטיס-תקציר תמונה+כותרת+קטגוריה/גיל/מחיר וחץ-פתיחה, אותו
// תוכן בדיוק כמו previewCard במפה הנייטיבית (לא עיצוב מקביל).
function SingleActivityPreview({ activity, onOpen }) {
  const { t, dir } = useI18n();
  return (
    <Pressable style={styles.previewCard} onPress={onOpen}>
      {activity.imageUrl ? (
        <Image source={{ uri: activity.imageUrl }} style={styles.previewImage} />
      ) : placeholderImageFor(activity.placeholderGroup) ? (
        <Image
          source={placeholderImageFor(activity.placeholderGroup)}
          resizeMode="contain"
          style={[styles.previewImage, { backgroundColor: placeholderBgColorFor(activity.placeholderGroup) }]}
        />
      ) : (
        <View style={[styles.previewImage, { backgroundColor: colors.borderLight }]} />
      )}
      <View style={styles.previewBody}>
        <Text style={styles.previewTitle} numberOfLines={1}>{activity.title}</Text>
        <Text style={styles.previewMeta} numberOfLines={1}>{categoryLabel(activity.type)} · {activity.ageRange} · {activity.price}</Text>
      </View>
      <View style={{ transform: [{ rotate: dir.forwardRotate }] }}><ChevronLeftIcon /></View>
    </Pressable>
  );
}

// כמה פעילויות באותה נקודה - רשימה קומפקטת (לא clustering) עם גלילה אם צריך; כל שורה פותחת את
// עמוד הפעילות שלה. maxHeight קטן מכוון (לא "עוד כרטיס-תוצאות" בתוך הפופ-אפ).
function MultiActivityPreview({ activities, router }) {
  const { t } = useI18n();
  return (
    <View style={styles.multiWrap}>
      <Text style={styles.multiTitle}>{t('activities.map.multipleAt', { count: activities.length })}</Text>
      <ScrollView style={styles.multiList} nestedScrollEnabled>
        {activities.map((a) => (
          <Pressable key={a.id} style={styles.multiRow} onPress={() => router.push(`/activity/${a.id}`)}>
            <Text style={styles.multiRowTitle} numberOfLines={1}>{a.title}</Text>
            <Text style={styles.multiRowMeta} numberOfLines={1}>{categoryLabel(a.type)}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

export default function ActivitiesMap({ activities, deviceCoords }) {
  const router = useRouter();
  const { t } = useI18n();
  const [selectedKey, setSelectedKey] = useState(null);

  const withCoords = useMemo(() => activities.filter((a) => a.lat != null && a.lng != null), [activities]);
  const groups = useMemo(() => groupByCoord(withCoords), [withCoords]);
  // חישוב חד-פעמי (לא useMemo תלוי-activities בכוונה, ראו FitOnMount) - רק כדי לתת ל-MapContainer
  // center/zoom התחלתיים תקינים (חובה ב-react-leaflet) לפני ש-FitOnMount מתקן אותם ב-mount.
  const initialCenter = groups[0] ? [groups[0].lat, groups[0].lng] : (deviceCoords ? [deviceCoords.latitude, deviceCoords.longitude] : ISRAEL_CENTER);

  return (
    <View style={styles.wrap}>
      <MapContainer
        center={initialCenter}
        zoom={groups.length > 0 ? SINGLE_POINT_ZOOM : DEFAULT_ZOOM}
        style={styles.map}
        scrollWheelZoom
      >
        {/* אריחי OpenStreetMap - ללא מפתח API, attribution חובה מוצג אוטומטית ע"י Leaflet
            (פינה תחתונה של המפה) - "שמירה על ייחוס נדרש לספק המפות" מהבקשה. */}
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        />
        <FitOnMount groups={groups} deviceCoords={deviceCoords} />

        {deviceCoords ? <Marker position={[deviceCoords.latitude, deviceCoords.longitude]} icon={USER_DOT_ICON} /> : null}

        {groups.map((g) => {
          const key = `${g.lat.toFixed(5)},${g.lng.toFixed(5)}`;
          const isSelected = selectedKey === key;
          return (
            <Marker
              key={key}
              position={[g.lat, g.lng]}
              icon={pinIcon(isSelected ? colors.coralStrong : colors.accent, isSelected)}
              eventHandlers={{
                click: () => setSelectedKey(key),
                popupclose: () => setSelectedKey((prev) => (prev === key ? null : prev)),
              }}
            >
              <Popup>
                {g.items.length === 1 ? (
                  <SingleActivityPreview activity={g.items[0]} onOpen={() => router.push(`/activity/${g.items[0].id}`)} />
                ) : (
                  <MultiActivityPreview activities={g.items} router={router} />
                )}
              </Popup>
            </Marker>
          );
        })}
      </MapContainer>

      {/* תוצאות קיימות, אבל אף אחת מהן עם מיקום ידוע - אותו טקסט/עיצוב בדיוק כמו המפה הנייטיבית
          (activities.map.emptyOverlay), לא הודעה מקבילה חדשה. */}
      {withCoords.length === 0 ? (
        <View style={styles.emptyOverlay} pointerEvents="none">
          <Text style={styles.emptyText}>{t('activities.map.emptyOverlay')}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = createStyles((d) => ({
  wrap: { height: 480, borderRadius: radii.lg, overflow: 'hidden', position: 'relative', backgroundColor: colors.card },
  map: { height: 480, width: '100%' },
  emptyOverlay: {
    position: 'absolute', top: 14, left: 14, right: 14,
    backgroundColor: 'rgba(255,255,255,0.95)', borderRadius: radii.md, padding: 10, zIndex: 1000,
  },
  emptyText: { fontFamily: fonts.semiBold, fontSize: 12.5, color: colors.textSecondary, textAlign: 'center' },
  // תוכן-פופ-אפ (Leaflet מריץ אותו בתוך container משלו, לא ה-ScrollView הרגיל של המסך) - רוחב
  // קבוע סביר לפופ-אפ, לא צמוד ל-RTL/LTR של שאר המסך (הפופ-אפ עצמו ממוקם ע"י Leaflet).
  previewCard: {
    flexDirection: 'row', alignItems: 'center', gap: 10, width: 240, padding: 2,
  },
  previewImage: { width: 48, height: 48, borderRadius: radii.md },
  previewBody: { flex: 1, minWidth: 0 },
  previewTitle: { fontFamily: fonts.extraBold, fontSize: 13.5, color: colors.textPrimary, textAlign: d.textAlign },
  previewMeta: { fontFamily: fonts.regular, fontSize: 11, color: colors.textSecondary, textAlign: d.textAlign, marginTop: 2 },
  multiWrap: { width: 220 },
  multiTitle: { fontFamily: fonts.bold, fontSize: 12.5, color: colors.textPrimary, textAlign: d.textAlign, marginBottom: 6 },
  multiList: { maxHeight: 160 },
  multiRow: { paddingVertical: 6, borderTopWidth: 1, borderTopColor: colors.borderLight },
  multiRowTitle: { fontFamily: fonts.bold, fontSize: 12.5, color: colors.accent, textAlign: d.textAlign },
  multiRowMeta: { fontFamily: fonts.regular, fontSize: 11, color: colors.textMuted, textAlign: d.textAlign, marginTop: 1 },
}));
