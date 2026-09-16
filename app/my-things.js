import { useState, useEffect, useCallback, useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, TextInput, ActivityIndicator, Modal, Image, Platform } from 'react-native';
import { useRouter, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import DateTimePicker from '@react-native-community/datetimepicker';
import Header from '../components/Header';
import SkyBackground from '../components/SkyBackground';
import ActivitiesMap from '../components/ActivitiesMap';
import { ChevronDownIcon } from '../components/icons';
import { colors, fonts, radii, spacing } from '../constants/theme';
import { CATEGORY_OPTIONS, REGION_OPTIONS, AGE_OPTIONS } from '../constants/filterSchema';
import { supabase } from '../lib/supabase';
import { mapActivityRow } from '../lib/activities';
import { placeholderImageFor, placeholderBgColorFor } from '../lib/placeholderImages';
import { relativeDate } from '../lib/formatDate';
import { openNavigationTo } from '../lib/openNavigation';
import {
  toggleFavorite, toggleVisited, togglePlanned, setPlannedTargetDate,
  savePersonalNote, fetchAllPersonalNotes,
} from '../lib/interactions';

// "❤️ הדברים שלי" - עמוד מרכזי אחד שמאחד את "היעדים שלי" (שמורים/מתכננים/היינו כאן, 3 טבלאות
// עצמאיות קיימות) עם "ההערות שלי" (personal_notes הקיימת) תחת ניווט/UX משותף - בלי לערבב את
// שני המודלים מבחינת תוכן (הערה לא משנה סטטוס-יעד, יעד לא משנה תוכן-הערה). מחליף את
// app/destinations.js הישן (route זהה במהות, רק עם טאב רביעי) - אין שתי מערכות מקבילות.
const ACTIVITY_TABS = [
  { key: 'saved', label: '❤️ שמורים', table: 'favorites' },
  { key: 'planned', label: '📅 מתכננים', table: 'planned_activities' },
  { key: 'visited', label: '✅ היינו כאן', table: 'visited_activities' },
];
const ALL_TAB_KEYS = [...ACTIVITY_TABS.map((t) => t.key), 'notes'];
const TAB_LABELS = { saved: '❤️ שמורים', planned: '📅 מתכננים', visited: '✅ היינו כאן', notes: '📝 הערות שלי' };

const SORT_OPTIONS = [
  { id: 'new', label: 'החדשות ביותר' },
  { id: 'old', label: 'הישנות ביותר' },
  { id: 'name', label: 'לפי שם פעילות' },
];

const NESTED_ACTIVITY_FIELDS = `id, name, category, entity_type, placeholder_group, min_age, max_age, status,
  location:locations(id, name, city, region, address, lat, lng),
  activity_images(url)`;

function ageBandOverlaps(activity, band) {
  if (activity.min_age == null && activity.max_age == null) return true;
  const min = activity.min_age ?? 0;
  const max = activity.max_age ?? 120;
  return min <= band.max && max >= band.min;
}

function formatTargetDate(rec) {
  if (rec.target_label) return rec.target_label;
  if (rec.target_date) return new Date(rec.target_date).toLocaleDateString('he-IL');
  return null;
}

export default function MyThingsScreen() {
  const router = useRouter();
  const { tab } = useLocalSearchParams();
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState(null);
  const [notice, setNotice] = useState('');

  const [records, setRecords] = useState(new Map()); // activity_id -> {activity, inFavorites, inPlanned, inVisited, target_date, target_label, created_at}
  const [notes, setNotes] = useState([]); // מ-fetchAllPersonalNotes - מערך מלא (לא רק מפה), כדי שטאב "הערות שלי" יוכל להציג תמונה/מיקום/תאריך
  const [activeTab, setActiveTab] = useState(() => (ALL_TAB_KEYS.includes(tab) ? tab : 'saved'));
  const [viewMode, setViewMode] = useState('list');

  useEffect(() => {
    if (tab && ALL_TAB_KEYS.includes(tab) && tab !== activeTab) setActiveTab(tab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const [filterOpen, setFilterOpen] = useState(false);
  const [filterCategory, setFilterCategory] = useState([]);
  const [filterRegion, setFilterRegion] = useState([]);
  const [filterAge, setFilterAge] = useState([]);
  const [search, setSearch] = useState('');

  const [dateModalTarget, setDateModalTarget] = useState(null);
  const [dateModalValue, setDateModalValue] = useState(null);
  const [dateModalLabel, setDateModalLabel] = useState('');
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [savingDate, setSavingDate] = useState(false);

  const [noteModalTarget, setNoteModalTarget] = useState(null);
  const [noteModalDraft, setNoteModalDraft] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [noteDeleteTarget, setNoteDeleteTarget] = useState(null);
  const [deletingNote, setDeletingNote] = useState(false);
  const [noteSort, setNoteSort] = useState('new');
  const [noteSortMenuOpen, setNoteSortMenuOpen] = useState(false);

  // הרחבת-כרטיס inline (במקום תפריט "⋯" נפרד) - לחיצה על הכרטיס (מלבד שם הפעילות ושורת
  // הפעולות התמיד-גלויה) פותחת/סוגרת את פעולות התאריך/"היינו פה" הפחות-שכיחות.
  const [expandedId, setExpandedId] = useState(null);

  const showNotice = (text) => { setNotice(text); setTimeout(() => setNotice(''), 3000); };

  const load = useCallback(async () => {
    const { data: { session: currentSession } } = await supabase.auth.getSession();
    setSession(currentSession);
    if (!currentSession?.user?.id) { setLoading(false); return; }
    const userId = currentSession.user.id;

    try {
      const [favRes, planRes, visitRes, notesRes] = await Promise.all([
        supabase.from('favorites').select(`activity_id, created_at, activity:activities(${NESTED_ACTIVITY_FIELDS})`).eq('user_id', userId),
        supabase.from('planned_activities').select(`activity_id, created_at, target_date, target_label, activity:activities(${NESTED_ACTIVITY_FIELDS})`).eq('user_id', userId),
        supabase.from('visited_activities').select(`activity_id, created_at, activity:activities(${NESTED_ACTIVITY_FIELDS})`).eq('user_id', userId),
        fetchAllPersonalNotes(userId),
      ]);
      if (favRes.error) throw favRes.error;
      if (planRes.error) throw planRes.error;
      if (visitRes.error) throw visitRes.error;

      const merged = new Map();
      const ensure = (row) => {
        if (!row.activity) return null;
        if (!merged.has(row.activity_id)) {
          merged.set(row.activity_id, {
            activity: row.activity, inFavorites: false, inPlanned: false, inVisited: false,
            target_date: null, target_label: null, created_at: row.created_at,
          });
        }
        return merged.get(row.activity_id);
      };
      (favRes.data || []).forEach((r) => { const rec = ensure(r); if (rec) rec.inFavorites = true; });
      (planRes.data || []).forEach((r) => {
        const rec = ensure(r);
        if (rec) { rec.inPlanned = true; rec.target_date = r.target_date; rec.target_label = r.target_label; }
      });
      (visitRes.data || []).forEach((r) => { const rec = ensure(r); if (rec) rec.inVisited = true; });
      setRecords(merged);
      setNotes(notesRes);
    } catch (err) {
      showNotice(`שגיאה בטעינה: ${err.message}`);
    }
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const notesByActivity = useMemo(() => new Map(notes.map((n) => [n.activity_id, n.note])), [notes]);

  const tabKeyToFlag = { saved: 'inFavorites', planned: 'inPlanned', visited: 'inVisited' };

  const tabItems = useMemo(() => {
    const flag = tabKeyToFlag[activeTab];
    if (!flag) return [];
    return Array.from(records.values()).filter((r) => r[flag]);
  }, [records, activeTab]);

  const filteredSortedItems = useMemo(() => {
    let list = tabItems;
    if (filterCategory.length) list = list.filter((r) => filterCategory.includes(r.activity.category));
    if (filterRegion.length) list = list.filter((r) => filterRegion.includes(r.activity.location?.region));
    if (filterAge.length) {
      const bands = AGE_OPTIONS.filter((b) => filterAge.includes(b.id));
      list = list.filter((r) => bands.some((b) => ageBandOverlaps(r.activity, b)));
    }
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter((r) => {
        const name = r.activity.name || '';
        const city = r.activity.location?.city || r.activity.location?.name || '';
        const category = r.activity.category || '';
        const note = notesByActivity.get(r.activity.id) || '';
        return [name, city, category, note].some((v) => v.toLowerCase().includes(q));
      });
    }
    return [...list].sort((a, b) => {
      if (a.target_date && b.target_date) return new Date(a.target_date) - new Date(b.target_date);
      if (a.target_date) return -1;
      if (b.target_date) return 1;
      return new Date(b.created_at) - new Date(a.created_at);
    });
  }, [tabItems, filterCategory, filterRegion, filterAge, search, notesByActivity]);

  const mappedForMap = useMemo(() => filteredSortedItems.map((r) => mapActivityRow(r.activity)), [filteredSortedItems]);

  const sortedNotes = useMemo(() => {
    const list = [...notes];
    if (noteSort === 'old') return list.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    if (noteSort === 'name') return list.sort((a, b) => (a.activity?.name || '').localeCompare(b.activity?.name || '', 'he'));
    return list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }, [notes, noteSort]);

  // ---- פעולות: יעדים ----
  const removeFromTab = async (activityId) => {
    if (!session?.user?.id) return;
    const tabDef = ACTIVITY_TABS.find((t) => t.key === activeTab);
    try {
      if (tabDef.key === 'saved') await toggleFavorite(session.user.id, activityId, false);
      else if (tabDef.key === 'planned') await togglePlanned(session.user.id, activityId, false);
      else await toggleVisited(session.user.id, activityId, false);
      await load();
      showNotice('הוסר מהיעדים');
    } catch (err) {
      showNotice(`שגיאה בהסרה: ${err.message}`);
    }
    setExpandedId(null);
  };

  const markVisited = async (activityId, next) => {
    if (!session?.user?.id) return;
    try {
      await toggleVisited(session.user.id, activityId, next);
      await load();
      showNotice(next ? 'סומן "היינו כאן"' : 'הוסר מ"היינו כאן"');
    } catch (err) {
      showNotice(`שגיאה: ${err.message}`);
    }
    setExpandedId(null);
  };

  const openDateModal = (activityId, rec) => {
    setDateModalTarget(activityId);
    setDateModalValue(rec?.target_date ? new Date(rec.target_date) : null);
    setDateModalLabel(rec?.target_label || '');
    setExpandedId(null);
  };

  const saveDateModal = async () => {
    if (!dateModalTarget || !session?.user?.id) return;
    setSavingDate(true);
    try {
      await setPlannedTargetDate(session.user.id, dateModalTarget, {
        targetDate: dateModalValue ? dateModalValue.toISOString().slice(0, 10) : null,
        targetLabel: dateModalLabel.trim() || null,
      });
      setDateModalTarget(null);
      await load();
      showNotice('תאריך היעד נשמר');
    } catch (err) {
      showNotice(`שגיאה בשמירת התאריך: ${err.message}`);
    } finally {
      setSavingDate(false);
    }
  };

  const clearDateModal = async () => {
    if (!dateModalTarget || !session?.user?.id) return;
    setSavingDate(true);
    try {
      await setPlannedTargetDate(session.user.id, dateModalTarget, { targetDate: null, targetLabel: null });
      setDateModalTarget(null);
      await load();
    } catch (err) {
      showNotice(`שגיאה: ${err.message}`);
    } finally {
      setSavingDate(false);
    }
  };

  const findSimilar = (activity) => {
    router.push({
      pathname: '/activities',
      params: {
        homeFilters: JSON.stringify({
          category: activity.category ? [activity.category] : [],
          location: activity.location?.region
            ? { mode: 'region', region: [activity.location.region] }
            : { mode: null },
        }),
      },
    });
  };

  // ---- פעולות: הערות (משותף לטאב "הערות שלי" וגם לכפתור-ההערה התמיד-גלוי בטאבי היעדים) ----
  const openNoteModal = (activityId, activityName) => {
    const existing = notes.find((n) => n.activity_id === activityId);
    setNoteModalTarget(existing || { activity_id: activityId, activity: { name: activityName } });
    setNoteModalDraft(existing ? existing.note : '');
  };

  const saveNoteModal = async () => {
    if (!noteModalTarget || !session?.user?.id) return;
    setSavingNote(true);
    try {
      await savePersonalNote(session.user.id, noteModalTarget.activity_id, noteModalDraft);
      await load();
      setNoteModalTarget(null);
      showNotice('ההערה נשמרה');
    } catch (err) {
      showNotice(`שגיאה בשמירת ההערה: ${err.message}`);
    } finally {
      setSavingNote(false);
    }
  };

  const confirmDeleteNote = async () => {
    if (!noteDeleteTarget || !session?.user?.id) return;
    setDeletingNote(true);
    try {
      // מוחקת רק את ההערה עצמה (personal_notes) - לא נוגעת בפעילות/ביעד/בשמירה/בסימון ביקור.
      await savePersonalNote(session.user.id, noteDeleteTarget.activity_id, '');
      setNotes((prev) => prev.filter((n) => n.activity_id !== noteDeleteTarget.activity_id));
      setNoteDeleteTarget(null);
      showNotice('ההערה נמחקה');
    } catch (err) {
      showNotice(`שגיאה במחיקת ההערה: ${err.message}`);
    } finally {
      setDeletingNote(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.screen}>
        <SkyBackground />
        <View style={styles.content}>
          <Header showBack onMenuPress={() => {}} />
          <View style={styles.center}><ActivityIndicator color={colors.accent} /></View>
        </View>
      </View>
    );
  }

  const totalCount = tabItems.length;

  return (
    <View style={styles.screen}>
      <SkyBackground />
      <View style={styles.content}>
        <Header showBack onMenuPress={() => {}} />
        <ScrollView showsVerticalScrollIndicator={false}>
          <Text style={styles.title}>❤️ הדברים שלי</Text>
          <Text style={styles.subtitle}>כל מה ששמרתם, תכננתם וכתבתם לעצמכם.</Text>

          {notice ? <View style={styles.noticeBox}><Text style={styles.noticeText}>{notice}</Text></View> : null}

          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabsRow}>
            {ALL_TAB_KEYS.map((key) => (
              <Pressable
                key={key}
                style={[styles.tabBtn, activeTab === key && styles.tabBtnActive]}
                onPress={() => setActiveTab(key)}
              >
                <Text style={[styles.tabBtnText, activeTab === key && styles.tabBtnTextActive]}>{TAB_LABELS[key]}</Text>
              </Pressable>
            ))}
          </ScrollView>

          {activeTab === 'notes' ? (
            <>
              <View style={styles.notesHeadRow}>
                <Text style={styles.countText}>{notes.length > 0 ? `ההערות שלי (${notes.length})` : 'ההערות שלי'}</Text>
                <Text style={styles.privacyHint}>🔒 פרטי</Text>
              </View>
              <Text style={styles.sectionHint}>כל ההערות האישיות שלכם, מרוכזות במקום אחד.</Text>

              {notes.length > 0 && (
                <View style={styles.sortWrap}>
                  <Pressable style={styles.sortBtn} onPress={() => setNoteSortMenuOpen((v) => !v)}>
                    <Text style={styles.sortBtnText}>מיון: {SORT_OPTIONS.find((o) => o.id === noteSort)?.label} ▾</Text>
                  </Pressable>
                  {noteSortMenuOpen && (
                    <View style={styles.sortMenu}>
                      {SORT_OPTIONS.map((opt) => (
                        <Pressable
                          key={opt.id}
                          style={styles.sortMenuItem}
                          onPress={() => { setNoteSort(opt.id); setNoteSortMenuOpen(false); }}
                        >
                          <Text style={[styles.sortMenuItemText, noteSort === opt.id && styles.sortMenuItemTextActive]}>{opt.label}</Text>
                        </Pressable>
                      ))}
                    </View>
                  )}
                </View>
              )}

              {notes.length === 0 ? (
                <View style={styles.emptyBox}>
                  <Text style={styles.emptyEmoji}>📝</Text>
                  <Text style={styles.emptyTitle}>עדיין אין לכם הערות אישיות.</Text>
                  <Text style={styles.emptyText}>הוסיפו הערה מתוך עמוד פעילות כדי לזכור דברים חשובים לפעם הבאה.</Text>
                </View>
              ) : (
                sortedNotes.map((note) => {
                  const thumb = note.activity.activity_images?.[0]?.url;
                  const cityLabel = note.activity.location?.city || note.activity.location?.name || '';
                  return (
                    <View key={note.activity_id} style={styles.noteCard}>
                      <View style={styles.noteCardTop}>
                        {thumb ? (
                          <Image source={{ uri: thumb }} style={styles.noteThumb} />
                        ) : placeholderImageFor(note.activity.placeholder_group) ? (
                          <Image
                            source={placeholderImageFor(note.activity.placeholder_group)}
                            resizeMode="contain"
                            style={[styles.noteThumb, { backgroundColor: placeholderBgColorFor(note.activity.placeholder_group) }]}
                          />
                        ) : (
                          <View style={styles.noteThumbPlaceholder}><Text style={styles.noteThumbPlaceholderText}>🖼️</Text></View>
                        )}
                        <View style={styles.noteCardInfo}>
                          <Pressable onPress={() => router.push(`/activity/${note.activity_id}`)}>
                            <Text style={styles.noteActivityName} numberOfLines={1}>{note.activity.name}</Text>
                          </Pressable>
                          {!!cityLabel && <Text style={styles.noteActivityLocation}>📍 {cityLabel}</Text>}
                        </View>
                      </View>
                      <Text style={styles.noteCardText} numberOfLines={4}>{note.note}</Text>
                      <View style={styles.noteCardFooter}>
                        <Text style={styles.noteCardMeta}>נכתב {relativeDate(note.created_at)}</Text>
                        <View style={styles.noteCardActions}>
                          <Pressable onPress={() => openNoteModal(note.activity_id, note.activity.name)}>
                            <Text style={styles.noteActionText}>✏️ עריכה</Text>
                          </Pressable>
                          <Pressable onPress={() => setNoteDeleteTarget(note)}>
                            <Text style={[styles.noteActionText, styles.noteActionDanger]}>🗑️ מחיקה</Text>
                          </Pressable>
                        </View>
                      </View>
                    </View>
                  );
                })
              )}
            </>
          ) : (
            <>
              {totalCount > 4 && (
                <View style={styles.toolsRow}>
                  <Pressable style={styles.toolBtn} onPress={() => setFilterOpen((v) => !v)}>
                    <Text style={styles.toolBtnText}>🔍 סינון</Text>
                  </Pressable>
                  <Pressable style={styles.toolBtn} onPress={() => setViewMode((v) => (v === 'list' ? 'map' : 'list'))}>
                    <Text style={styles.toolBtnText}>{viewMode === 'list' ? '🗺️ מפה' : '📋 רשימה'}</Text>
                  </Pressable>
                </View>
              )}

              {filterOpen && (
                <View style={styles.filterBox}>
                  <Text style={styles.filterLabel}>🎯 קטגוריה</Text>
                  <View style={styles.chipRow}>
                    {CATEGORY_OPTIONS.map((c) => (
                      <Pressable
                        key={c.id}
                        style={[styles.chip, filterCategory.includes(c.id) && styles.chipActive]}
                        onPress={() => setFilterCategory((prev) => (prev.includes(c.id) ? prev.filter((x) => x !== c.id) : [...prev, c.id]))}
                      >
                        <Text style={[styles.chipText, filterCategory.includes(c.id) && styles.chipTextActive]}>{c.label}</Text>
                      </Pressable>
                    ))}
                  </View>
                  <Text style={styles.filterLabel}>📍 אזור</Text>
                  <View style={styles.chipRow}>
                    {REGION_OPTIONS.map((r) => (
                      <Pressable
                        key={r.id}
                        style={[styles.chip, filterRegion.includes(r.id) && styles.chipActive]}
                        onPress={() => setFilterRegion((prev) => (prev.includes(r.id) ? prev.filter((x) => x !== r.id) : [...prev, r.id]))}
                      >
                        <Text style={[styles.chipText, filterRegion.includes(r.id) && styles.chipTextActive]}>{r.label}</Text>
                      </Pressable>
                    ))}
                  </View>
                  <Text style={styles.filterLabel}>👶 גיל</Text>
                  <View style={styles.chipRow}>
                    {AGE_OPTIONS.map((a) => (
                      <Pressable
                        key={a.id}
                        style={[styles.chip, filterAge.includes(a.id) && styles.chipActive]}
                        onPress={() => setFilterAge((prev) => (prev.includes(a.id) ? prev.filter((x) => x !== a.id) : [...prev, a.id]))}
                      >
                        <Text style={[styles.chipText, filterAge.includes(a.id) && styles.chipTextActive]}>{a.label}</Text>
                      </Pressable>
                    ))}
                  </View>
                  {(filterCategory.length > 0 || filterRegion.length > 0 || filterAge.length > 0) && (
                    <Pressable onPress={() => { setFilterCategory([]); setFilterRegion([]); setFilterAge([]); }}>
                      <Text style={styles.clearFiltersText}>נקה סינון</Text>
                    </Pressable>
                  )}
                </View>
              )}

              {totalCount > 6 && (
                <TextInput
                  style={styles.searchInput}
                  value={search}
                  onChangeText={setSearch}
                  placeholder="🔍 חיפוש ביעדים שלי..."
                  placeholderTextColor={colors.textMuted}
                />
              )}

              <Text style={styles.countText}>{filteredSortedItems.length} יעדים</Text>

              {filteredSortedItems.length === 0 ? (
                <View style={styles.emptyBox}>
                  <Text style={styles.emptyEmoji}>📍</Text>
                  <Text style={styles.emptyTitle}>
                    {totalCount === 0 ? 'היעדים שלכם עוד מחכים כאן' : 'לא נמצאו יעדים מתאימים'}
                  </Text>
                  <Text style={styles.emptyText}>
                    {totalCount === 0
                      ? 'מצאתם פעילות שממש בא לכם לעשות? שמרו אותה, והיא תחכה לכם כאן.'
                      : 'נסו לשנות את הסינון או את מילות החיפוש.'}
                  </Text>
                  {totalCount === 0 && (
                    <Pressable style={styles.findBtn} onPress={() => router.push('/activities')}>
                      <Text style={styles.findBtnText}>מצאו פעילות 🔍</Text>
                    </Pressable>
                  )}
                </View>
              ) : viewMode === 'map' ? (
                <ActivitiesMap activities={mappedForMap} />
              ) : (
                filteredSortedItems.map((rec) => {
                  const a = rec.activity;
                  const unavailable = a.status !== 'approved';
                  const cityLabel = a.location?.city || a.location?.name || '';
                  const thumb = a.activity_images?.[0]?.url;
                  const note = notesByActivity.get(a.id);
                  const dateLabel = formatTargetDate(rec);
                  const isPastDue = rec.target_date && new Date(rec.target_date) < new Date(new Date().toDateString()) && !rec.inVisited;

                  if (unavailable) {
                    return (
                      <View key={a.id} style={styles.card}>
                        <Text style={styles.unavailableText}>⚠️ הפעילות אינה זמינה כרגע</Text>
                        <Pressable style={styles.similarBtn} onPress={() => findSimilar(a)}>
                          <Text style={styles.similarBtnText}>מצאו משהו דומה</Text>
                        </Pressable>
                      </View>
                    );
                  }

                  const expanded = expandedId === a.id;
                  const stop = (fn) => (e) => { e?.stopPropagation?.(); fn(); };

                  return (
                    <Pressable key={a.id} style={styles.card} onPress={() => setExpandedId(expanded ? null : a.id)}>
                      <View style={styles.cardTop}>
                        {thumb ? (
                          <Image source={{ uri: thumb }} style={styles.thumb} />
                        ) : placeholderImageFor(a.placeholder_group) ? (
                          <Image
                            source={placeholderImageFor(a.placeholder_group)}
                            resizeMode="contain"
                            style={[styles.thumb, { backgroundColor: placeholderBgColorFor(a.placeholder_group) }]}
                          />
                        ) : (
                          <LinearGradient colors={mapActivityRow(a).gradient} style={styles.thumb} />
                        )}
                        <View style={styles.cardInfo}>
                          <Pressable onPress={stop(() => router.push(`/activity/${a.id}`))}>
                            <Text style={styles.activityName} numberOfLines={1}>{a.name}</Text>
                          </Pressable>
                          <Text style={styles.activityMeta} numberOfLines={1}>
                            {[cityLabel && `📍 ${cityLabel}`, a.category && `🎯 ${a.category}`].filter(Boolean).join('  ')}
                          </Text>
                          <View style={styles.statusBadges}>
                            {rec.inFavorites && <Text style={styles.statusBadge}>❤️</Text>}
                            {rec.inPlanned && <Text style={styles.statusBadge}>📅</Text>}
                            {rec.inVisited && <Text style={styles.statusBadge}>✅</Text>}
                          </View>
                        </View>
                        <View style={{ transform: [{ rotate: expanded ? '180deg' : '0deg' }] }}>
                          <ChevronDownIcon size={14} color={colors.textMuted} />
                        </View>
                      </View>

                      {dateLabel && !isPastDue && <Text style={styles.dateLine}>📅 {dateLabel}</Text>}
                      {isPastDue && (
                        <View style={styles.pastDueBox}>
                          <Text style={styles.pastDueText}>📅 היה מתוכנן ל-{dateLabel} - עדיין רוצים להגיע?</Text>
                          <View style={styles.pastDueActions}>
                            <Pressable onPress={stop(() => openDateModal(a.id, rec))}><Text style={styles.pastDueLink}>עדכן תאריך</Text></Pressable>
                            <Pressable onPress={stop(() => markVisited(a.id, true))}><Text style={styles.pastDueLink}>סמן כהושלם</Text></Pressable>
                          </View>
                        </View>
                      )}

                      {note ? <Text style={styles.notePreview} numberOfLines={1}>📝 {note}</Text> : null}

                      {/* שורת פעולות תמיד-גלויה - כמו בטאב "📝 הערות שלי", בלי תפריט "⋯" נסתר.
                          פעולות פחות-שכיחות (תאריך/"היינו פה") עברו לאזור המתרחב מתחת. */}
                      <View style={styles.actionsRow}>
                        <Pressable
                          style={styles.navBtn}
                          onPress={stop(() => openNavigationTo({ title: a.name, locationName: a.location?.name, city: cityLabel, lat: a.location?.lat, lng: a.location?.lng }))}
                        >
                          <Text style={styles.navBtnText}>🗺️ ניווט</Text>
                        </Pressable>
                        <Pressable style={styles.navBtn} onPress={stop(() => openNoteModal(a.id, a.name))}>
                          <Text style={styles.navBtnText}>{note ? '✏️ עריכת הערה' : '📝 הוסף הערה'}</Text>
                        </Pressable>
                        <Pressable style={[styles.navBtn, styles.navBtnDanger]} onPress={stop(() => removeFromTab(a.id))}>
                          <Text style={[styles.navBtnText, styles.navBtnDangerText]}>🗑️ הסר מהיעדים</Text>
                        </Pressable>
                      </View>

                      {expanded && (
                        <View style={styles.expandedRow}>
                          <Pressable style={styles.expandedItem} onPress={stop(() => openDateModal(a.id, rec))}>
                            <Text style={styles.expandedItemText}>📅 {rec.target_date || rec.target_label ? 'שנה תאריך' : 'הוסף תאריך'}</Text>
                          </Pressable>
                          <Pressable style={styles.expandedItem} onPress={stop(() => markVisited(a.id, !rec.inVisited))}>
                            <Text style={styles.expandedItemText}>{rec.inVisited ? '↩️ בטל "היינו פה"' : '✅ היינו פה'}</Text>
                          </Pressable>
                        </View>
                      )}
                    </Pressable>
                  );
                })
              )}
            </>
          )}
        </ScrollView>
      </View>

      <Modal visible={!!dateModalTarget} transparent animationType="fade" onRequestClose={() => setDateModalTarget(null)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setDateModalTarget(null)}>
          <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.modalTitle}>תאריך יעד</Text>
            <Pressable style={styles.dateDisplayBtn} onPress={() => setShowDatePicker(true)}>
              <Text style={styles.dateDisplayText}>
                {dateModalValue ? dateModalValue.toLocaleDateString('he-IL') : 'בחרו תאריך (לא חובה)'}
              </Text>
            </Pressable>
            {showDatePicker && (
              <DateTimePicker
                value={dateModalValue || new Date()}
                mode="date"
                display={Platform.OS === 'ios' ? 'inline' : 'default'}
                onChange={(event, selected) => {
                  setShowDatePicker(Platform.OS === 'ios');
                  if (selected) setDateModalValue(selected);
                }}
              />
            )}
            <Text style={styles.fieldLabel}>או תיאור (למשל "חול המועד סוכות")</Text>
            <TextInput
              style={styles.textInput}
              value={dateModalLabel}
              onChangeText={setDateModalLabel}
              placeholder="תיאור המועד"
              placeholderTextColor={colors.textMuted}
            />
            <View style={styles.modalActionsRow}>
              <Pressable style={[styles.modalSaveBtn, savingDate && styles.modalBtnDisabled]} onPress={saveDateModal} disabled={savingDate}>
                <Text style={styles.modalSaveBtnText}>{savingDate ? 'שומר...' : 'שמירה'}</Text>
              </Pressable>
              <Pressable style={styles.modalCancelBtn} onPress={() => setDateModalTarget(null)}>
                <Text style={styles.modalCancelBtnText}>ביטול</Text>
              </Pressable>
            </View>
            <Pressable onPress={clearDateModal} disabled={savingDate}>
              <Text style={styles.clearDateText}>עדיין לא החלטתי (נקה תאריך)</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={!!noteModalTarget} transparent animationType="fade" onRequestClose={() => setNoteModalTarget(null)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setNoteModalTarget(null)}>
          <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.modalTitle}>הערה אישית</Text>
            <Text style={styles.fieldLabel}>{noteModalTarget?.activity?.name}</Text>
            <TextInput
              style={[styles.textInput, styles.noteTextarea]}
              value={noteModalDraft}
              onChangeText={setNoteModalDraft}
              multiline
              placeholder="כתבו כאן הערה פרטית..."
              placeholderTextColor={colors.textMuted}
            />
            <View style={styles.modalActionsRow}>
              <Pressable
                style={[styles.modalSaveBtn, savingNote && styles.modalBtnDisabled]}
                onPress={saveNoteModal}
                disabled={savingNote}
              >
                <Text style={styles.modalSaveBtnText}>{savingNote ? 'שומר...' : 'שמירת הערה'}</Text>
              </Pressable>
              <Pressable style={styles.modalCancelBtn} onPress={() => setNoteModalTarget(null)}>
                <Text style={styles.modalCancelBtnText}>ביטול</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={!!noteDeleteTarget} transparent animationType="fade" onRequestClose={() => setNoteDeleteTarget(null)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setNoteDeleteTarget(null)}>
          <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.modalTitle}>מחיקת ההערה?</Text>
            <Text style={styles.noteDeleteWarning}>לא ניתן לשחזר הערה שנמחקת.</Text>
            <View style={styles.modalActionsRow}>
              <Pressable
                style={[styles.modalSaveBtn, styles.modalDangerBtn, deletingNote && styles.modalBtnDisabled]}
                onPress={confirmDeleteNote}
                disabled={deletingNote}
              >
                <Text style={styles.modalSaveBtnText}>{deletingNote ? 'מוחק...' : 'מחיקה'}</Text>
              </Pressable>
              <Pressable style={styles.modalCancelBtn} onPress={() => setNoteDeleteTarget(null)}>
                <Text style={styles.modalCancelBtnText}>ביטול</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { flex: 1, padding: spacing.xl },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  title: { fontFamily: fonts.extraBold, fontSize: 20, color: colors.textPrimary, textAlign: 'right', marginTop: 8 },
  subtitle: { fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, textAlign: 'right', marginTop: 4, marginBottom: 16 },

  noticeBox: { backgroundColor: colors.accentTintLight, borderRadius: radii.md, padding: 10, marginBottom: 12 },
  noticeText: { fontFamily: fonts.semiBold, fontSize: 12.5, color: colors.accent, textAlign: 'center' },

  tabsRow: { flexDirection: 'row-reverse', gap: 8, marginBottom: 14, paddingBottom: 2 },
  tabBtn: { alignItems: 'center', paddingVertical: 9, paddingHorizontal: 16, borderRadius: radii.pill, borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.card },
  tabBtnActive: { borderColor: colors.accent, backgroundColor: colors.accentTintLight },
  tabBtnText: { fontFamily: fonts.bold, fontSize: 12.5, color: colors.textSecondary },
  tabBtnTextActive: { color: colors.accent },

  toolsRow: { flexDirection: 'row-reverse', gap: 8, marginBottom: 10 },
  toolBtn: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, borderRadius: radii.pill, paddingVertical: 8, paddingHorizontal: 14 },
  toolBtnText: { fontFamily: fonts.bold, fontSize: 12.5, color: colors.textSecondary },

  filterBox: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, padding: 12, marginBottom: 12 },
  filterLabel: { fontFamily: fonts.bold, fontSize: 12, color: colors.textSecondary, textAlign: 'right', marginBottom: 6, marginTop: 8 },
  chipRow: { flexDirection: 'row-reverse', flexWrap: 'wrap', gap: 6 },
  chip: { borderWidth: 1, borderColor: colors.border, borderRadius: radii.pill, paddingVertical: 6, paddingHorizontal: 12, backgroundColor: colors.bg },
  chipActive: { borderColor: colors.accent, backgroundColor: colors.accentTintLight },
  chipText: { fontFamily: fonts.semiBold, fontSize: 11.5, color: colors.textSecondary },
  chipTextActive: { color: colors.accent },
  clearFiltersText: { fontFamily: fonts.bold, fontSize: 12, color: colors.danger, textAlign: 'center', marginTop: 12 },

  searchInput: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, padding: 12, marginBottom: 10,
    fontFamily: fonts.regular, fontSize: 14, color: colors.textPrimary, backgroundColor: colors.card,
    textAlign: 'right', writingDirection: 'rtl',
  },
  countText: { fontFamily: fonts.semiBold, fontSize: 12.5, color: colors.textMuted, textAlign: 'right', marginBottom: 10 },

  notesHeadRow: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between' },
  privacyHint: { fontFamily: fonts.regular, fontSize: 11, color: colors.textMuted },
  sectionHint: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, textAlign: 'right', lineHeight: 17, marginTop: 4, marginBottom: 12 },

  sortWrap: { alignItems: 'flex-end', marginBottom: 12 },
  sortBtn: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, borderRadius: radii.pill, paddingVertical: 7, paddingHorizontal: 13 },
  sortBtnText: { fontFamily: fonts.semiBold, fontSize: 12, color: colors.textSecondary },
  sortMenu: {
    marginTop: 6, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md,
    overflow: 'hidden', minWidth: 160,
  },
  sortMenuItem: { paddingVertical: 10, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: colors.borderLight },
  sortMenuItemText: { fontFamily: fonts.semiBold, fontSize: 12.5, color: colors.textSecondary, textAlign: 'right' },
  sortMenuItemTextActive: { color: colors.accent, fontFamily: fonts.bold },

  emptyBox: { alignItems: 'center', backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderStyle: 'dashed', borderRadius: radii.lg, padding: 24, marginTop: 12 },
  emptyEmoji: { fontSize: 32, marginBottom: 8 },
  emptyTitle: { fontFamily: fonts.extraBold, fontSize: 15, color: colors.textPrimary, textAlign: 'center', marginBottom: 6 },
  emptyText: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.textSecondary, textAlign: 'center', lineHeight: 18, marginBottom: 14 },
  findBtn: { backgroundColor: colors.accent, borderRadius: radii.pill, paddingVertical: 12, paddingHorizontal: 22 },
  findBtnText: { fontFamily: fonts.bold, fontSize: 14, color: '#fff' },

  card: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, padding: 12, marginBottom: 10 },
  cardTop: { flexDirection: 'row-reverse', alignItems: 'flex-start', gap: 10 },
  thumb: { width: 56, height: 56, borderRadius: radii.md, backgroundColor: colors.borderLight },
  cardInfo: { flex: 1, minWidth: 0 },
  activityName: { fontFamily: fonts.bold, fontSize: 14.5, color: colors.textPrimary, textAlign: 'right' },
  activityMeta: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.textSecondary, textAlign: 'right', marginTop: 2 },
  statusBadges: { flexDirection: 'row-reverse', gap: 4, marginTop: 4 },
  statusBadge: { fontSize: 12 },

  dateLine: { fontFamily: fonts.semiBold, fontSize: 12, color: colors.accent, textAlign: 'right', marginTop: 8 },
  pastDueBox: { backgroundColor: colors.yellowTint, borderRadius: radii.md, padding: 10, marginTop: 8 },
  pastDueText: { fontFamily: fonts.semiBold, fontSize: 12, color: colors.textPrimary, textAlign: 'right' },
  pastDueActions: { flexDirection: 'row-reverse', gap: 14, marginTop: 6 },
  pastDueLink: { fontFamily: fonts.bold, fontSize: 12, color: colors.accent },

  notePreview: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, textAlign: 'right', marginTop: 8 },

  actionsRow: { flexDirection: 'row-reverse', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  navBtn: { borderWidth: 1, borderColor: colors.accent, borderRadius: radii.pill, paddingVertical: 7, paddingHorizontal: 14 },
  navBtnText: { fontFamily: fonts.bold, fontSize: 12, color: colors.accent },
  navBtnDanger: { borderColor: colors.danger },
  navBtnDangerText: { color: colors.danger },

  expandedRow: {
    flexDirection: 'row-reverse', flexWrap: 'wrap', gap: 4,
    marginTop: 10, borderTopWidth: 1, borderTopColor: colors.borderLight, paddingTop: 8,
  },
  expandedItem: { paddingVertical: 9 },
  expandedItemText: { fontFamily: fonts.semiBold, fontSize: 13, color: colors.textPrimary, textAlign: 'right' },

  unavailableText: { fontFamily: fonts.bold, fontSize: 13, color: colors.textSecondary, textAlign: 'center', marginBottom: 10 },
  similarBtn: { alignSelf: 'center', borderWidth: 1, borderColor: colors.accent, borderRadius: radii.pill, paddingVertical: 8, paddingHorizontal: 16 },
  similarBtnText: { fontFamily: fonts.bold, fontSize: 12.5, color: colors.accent },

  noteCard: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, padding: 12, marginBottom: 10 },
  noteCardTop: { flexDirection: 'row-reverse', alignItems: 'center', gap: 10, marginBottom: 8 },
  noteThumb: { width: 52, height: 52, borderRadius: radii.md, backgroundColor: colors.borderLight },
  noteThumbPlaceholder: { width: 52, height: 52, borderRadius: radii.md, backgroundColor: colors.accentTintLight, alignItems: 'center', justifyContent: 'center' },
  noteThumbPlaceholderText: { fontSize: 20 },
  noteCardInfo: { flex: 1, minWidth: 0 },
  noteActivityName: { fontFamily: fonts.bold, fontSize: 14, color: colors.textPrimary, textAlign: 'right' },
  noteActivityLocation: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.textSecondary, textAlign: 'right', marginTop: 2 },
  noteCardText: { fontFamily: fonts.regular, fontSize: 13, color: colors.textPrimary, textAlign: 'right', lineHeight: 18, marginBottom: 8 },
  noteCardFooter: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 },
  noteCardMeta: { fontFamily: fonts.regular, fontSize: 10.5, color: colors.textMuted },
  noteCardActions: { flexDirection: 'row-reverse', gap: 14 },
  noteActionText: { fontFamily: fonts.bold, fontSize: 12, color: colors.accent },
  noteActionDanger: { color: colors.danger },
  noteDeleteWarning: { fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, textAlign: 'center', marginBottom: 18 },

  modalBackdrop: { flex: 1, backgroundColor: 'rgba(20,30,35,0.4)', justifyContent: 'center', padding: spacing.xl },
  modalCard: { backgroundColor: colors.card, borderRadius: radii.xl, padding: spacing.xl },
  modalTitle: { fontFamily: fonts.extraBold, fontSize: 17, color: colors.textPrimary, textAlign: 'center', marginBottom: 16 },
  fieldLabel: { fontFamily: fonts.semiBold, fontSize: 12, color: colors.textSecondary, textAlign: 'right', marginBottom: 6 },
  textInput: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, padding: 12, marginBottom: 14,
    fontFamily: fonts.regular, fontSize: 14, color: colors.textPrimary, backgroundColor: colors.bg,
    textAlign: 'right', writingDirection: 'rtl',
  },
  noteTextarea: { minHeight: 90, textAlignVertical: 'top' },
  dateDisplayBtn: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, padding: 12, marginBottom: 14, backgroundColor: colors.bg,
  },
  dateDisplayText: { fontFamily: fonts.semiBold, fontSize: 14, color: colors.textPrimary, textAlign: 'center' },
  modalActionsRow: { flexDirection: 'row-reverse', gap: 10, marginBottom: 8 },
  modalCancelBtn: { flex: 1, alignItems: 'center', paddingVertical: 13, borderRadius: radii.pill, borderWidth: 1, borderColor: colors.border },
  modalCancelBtnText: { fontFamily: fonts.bold, fontSize: 14, color: colors.textSecondary },
  modalSaveBtn: { flex: 1, alignItems: 'center', paddingVertical: 13, borderRadius: radii.pill, backgroundColor: colors.accent },
  modalDangerBtn: { backgroundColor: colors.danger },
  modalBtnDisabled: { opacity: 0.5 },
  modalSaveBtnText: { fontFamily: fonts.bold, fontSize: 14, color: '#fff' },
  clearDateText: { fontFamily: fonts.semiBold, fontSize: 12.5, color: colors.textMuted, textAlign: 'center' },
});
