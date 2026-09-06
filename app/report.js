import { useState, useEffect } from 'react';
import { View, Text, StyleSheet, Pressable, ActivityIndicator } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { colors, fonts, radii, spacing } from '../constants/theme';
import { supabase } from '../lib/supabase';

const TITLES = {
  community_note: 'דיווח על הערה',
  chat_message: 'דיווח על הודעה',
  user: 'דיווח על משתמש',
};

const REASONS = [
  'תוכן פוגעני או מטריד',
  'ספאם או פרסומת',
  'מידע שגוי או מטעה',
  'תוכן לא הולם לילדים',
  'משהו אחר',
];

export default function ReportScreen() {
  const router = useRouter();
  const { targetType, targetId, preview } = useLocalSearchParams();
  const [userId, setUserId] = useState(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [reason, setReason] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!cancelled) {
        setUserId(session?.user?.id || null);
        setCheckingSession(false);
      }
    });
    return () => { cancelled = true; };
  }, []);

  const handleSubmit = async () => {
    if (!reason || !targetType || !targetId) return;
    setSubmitting(true);
    setError('');
    const { error: insertError } = await supabase.from('reports').insert({
      reporter_id: userId,
      target_type: String(targetType),
      target_id: String(targetId),
      reason,
    });
    setSubmitting(false);
    if (insertError) {
      setError(`שגיאה בשליחת הדיווח: ${insertError.message}`);
      return;
    }
    setSubmitted(true);
    setTimeout(() => router.back(), 1400);
  };

  const title = TITLES[String(targetType)] || 'דיווח';
  const invalidTarget = !targetType || !targetId;

  return (
    <View style={styles.screen}>
      <Pressable style={styles.scrim} onPress={() => router.back()} />
      <View style={styles.sheet}>
        <View style={styles.handle} />

        {checkingSession ? (
          <View style={styles.center}><ActivityIndicator color={colors.accent} /></View>
        ) : !userId ? (
          <>
            <Text style={styles.sheetTitle}>צריך להתחבר כדי לדווח</Text>
            <Pressable style={styles.loginBtn} onPress={() => router.replace('/login')}>
              <Text style={styles.primaryBtnText}>התחברות</Text>
            </Pressable>
            <Pressable onPress={() => router.back()}>
              <Text style={styles.cancelLink}>ביטול</Text>
            </Pressable>
          </>
        ) : invalidTarget ? (
          <Text style={styles.sheetTitle}>לא ברור מה מדווחים עליו</Text>
        ) : submitted ? (
          <View style={styles.center}>
            <Text style={styles.successText}>הדיווח נשלח, תודה! 🙏</Text>
          </View>
        ) : (
          <>
            <Text style={styles.sheetTitle}>{title}</Text>
            <Text style={styles.sheetSub}>הדיווח יישלח לצוות TuRu לבדיקה</Text>
            {preview ? (
              <View style={styles.reportedPreview}>
                <Text style={styles.reportedPreviewText}>{String(preview)}</Text>
              </View>
            ) : null}

            {REASONS.map((r) => (
              <Pressable key={r} style={styles.reasonOption} onPress={() => setReason(r)}>
                <View style={[styles.radio, reason === r && styles.radioChecked]}>
                  {reason === r && <View style={styles.radioDot} />}
                </View>
                <Text style={styles.reasonLabel}>{r}</Text>
              </Pressable>
            ))}

            {error ? <Text style={styles.errorText}>{error}</Text> : null}

            <Pressable
              style={[styles.primaryBtn, !reason && styles.primaryBtnDisabled]}
              onPress={handleSubmit}
              disabled={!reason || submitting}
            >
              {submitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryBtnText}>שליחת דיווח</Text>}
            </Pressable>
            <Pressable onPress={() => router.back()}>
              <Text style={styles.cancelLink}>ביטול</Text>
            </Pressable>
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(31,48,59,0.35)' },
  scrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  sheet: {
    backgroundColor: colors.bg, borderTopLeftRadius: radii.xl, borderTopRightRadius: radii.xl,
    padding: spacing.xl, paddingBottom: 32,
  },
  handle: { width: 40, height: 4, borderRadius: 999, backgroundColor: colors.border, alignSelf: 'center', marginBottom: 18 },

  center: { paddingVertical: 30, alignItems: 'center' },
  successText: { fontFamily: fonts.bold, fontSize: 15, color: colors.greenStrong },

  sheetTitle: { fontFamily: fonts.extraBold, fontSize: 17, color: colors.textPrimary, textAlign: 'right', marginBottom: 4 },
  sheetSub: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.textSecondary, textAlign: 'right', marginBottom: 14 },
  reportedPreview: { backgroundColor: colors.card, borderRadius: radii.sm, padding: 10, marginBottom: 16 },
  reportedPreviewText: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.textSecondary, textAlign: 'right' },

  reasonOption: {
    flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: colors.borderLight,
  },
  reasonLabel: { fontFamily: fonts.regular, fontSize: 14, color: colors.textPrimary },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 1.5, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  radioChecked: { borderColor: colors.accent },
  radioDot: { width: 11, height: 11, borderRadius: 6, backgroundColor: colors.accent },

  errorText: { fontFamily: fonts.semiBold, fontSize: 12.5, color: colors.danger, textAlign: 'center', marginTop: 12 },

  primaryBtn: { backgroundColor: colors.danger, borderRadius: radii.pill, paddingVertical: 14, alignItems: 'center', marginTop: 20 },
  loginBtn: { backgroundColor: colors.accent, borderRadius: radii.pill, paddingVertical: 14, alignItems: 'center', marginTop: 12 },
  primaryBtnDisabled: { opacity: 0.4 },
  primaryBtnText: { fontFamily: fonts.bold, fontSize: 15, color: '#fff' },
  cancelLink: { fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, textAlign: 'center', marginTop: 14 },
});
