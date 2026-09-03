import { Image } from 'expo-image';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StyleSheet, Text, View } from 'react-native';
import { radius, spacing, typography, useThemeColors } from '@/utils/theme';
import { t } from '@/i18n';

export function MobileDownloadLanding() {
  const colors = useThemeColors();
  return <SafeAreaView style={[styles.page, { backgroundColor: colors.background }]}>
    <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Image source={require('../../assets/favicon.png')} style={styles.logo} contentFit="cover" />
      <Text style={[styles.brand, { color: colors.text }]}>FeedMind</Text>
      <Text style={[styles.title, { color: colors.text }]}>{t('mobileAppRecommended')}</Text>
      <Text style={[styles.message, { color: colors.secondary }]}>{t('mobileDownloadPlaceholder')}</Text>
      <View style={styles.actions}>
        <View style={[styles.disabledButton, { backgroundColor: colors.page }]}><Text style={{ color: colors.subtle }}>{t('androidComingSoon')}</Text></View>
        <View style={[styles.disabledButton, { backgroundColor: colors.page }]}><Text style={{ color: colors.subtle }}>{t('iosComingSoon')}</Text></View>
      </View>
    </View>
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  page: { flex: 1, minWidth: 320, alignItems: 'center', justifyContent: 'center', padding: spacing.section },
  card: { width: '100%', maxWidth: 520, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.panel, padding: 40, alignItems: 'center' },
  logo: { width: 52, height: 52, borderRadius: radius.control },
  brand: { ...typography.pageTitle, marginTop: spacing.lg },
  title: { fontSize: 22, lineHeight: 30, fontWeight: '700', marginTop: spacing.section, textAlign: 'center' },
  message: { ...typography.body, marginTop: spacing.lg, textAlign: 'center', maxWidth: 380 },
  actions: { width: '100%', marginTop: spacing.section, gap: spacing.md },
  disabledButton: { height: 46, borderRadius: radius.control, alignItems: 'center', justifyContent: 'center' },
});
