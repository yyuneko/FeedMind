import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { Alert, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { t } from '@/i18n';
import { useLocalSearchParams, usePathname } from 'expo-router';
import { useAppStore } from '@/store/appStore';
import { parseSelectionScope, useNavigationStore } from '@/store/navigationStore';
import { useThemeColors } from '@/utils/theme';

const REPOSITORY_URL = 'https://github.com/yyuneko/FeedMind';

const items: Record<string, { label: () => string; icon: keyof typeof Ionicons.glyphMap }> = {
  index: { label: () => t('today'), icon: 'calendar-outline' },
  feeds: { label: () => t('feeds'), icon: 'list-outline' },
  saved: { label: () => t('saved'), icon: 'bookmark-outline' },
  settings: { label: () => t('settings'), icon: 'settings-outline' },
};

type TabBarProps = { state: { index: number; routes: Array<{ key: string; name: string }> }; navigation: { navigate: (name: string) => void } };

export function DesktopTabBar({ state, navigation }: TabBarProps) {
  const theme = useThemeColors();
  const pathname = usePathname();
  const { id, origin } = useLocalSearchParams<{ id?: string; origin?: string }>();
  const routeOrigin = parseSelectionScope(origin);
  const articleOrigin = useNavigationStore((value) => routeOrigin ?? (id ? value.articleOrigins[id] ?? value.articleOrigin : value.articleOrigin));
  const fallbackRoute = pathname === '/article/category'
    ? 'feeds'
    : pathname.startsWith('/article/')
      ? articleOrigin === 'saved' ? 'saved' : articleOrigin === 'feeds' || articleOrigin === 'category' ? 'feeds' : 'index'
      : null;
  useAppStore((value) => value.languageMode);
  return (
    <View style={[styles.sidebar, { backgroundColor: theme.card, borderRightColor: theme.border }]}>
      <View style={styles.windowDots}><View style={[styles.windowDot, { backgroundColor: '#FF5F57' }]} /><View style={[styles.windowDot, { backgroundColor: '#FFBD2E' }]} /><View style={[styles.windowDot, { backgroundColor: '#28C840' }]} /></View>
      <View style={styles.logoRow}><Image source={require('../../assets/favicon.png')} style={styles.logo} contentFit="cover" /><Text style={[styles.brandName, { color: theme.text }]}>FeedMind</Text></View>
      <View style={styles.navigation}>
        {state.routes.filter((route) => items[route.name]).map((route) => {
          const item = items[route.name];
          const focused = fallbackRoute ? route.name === fallbackRoute : state.index === state.routes.indexOf(route);
          return <Pressable key={route.key} onPress={() => navigation.navigate(route.name)} style={({ hovered, pressed }) => [styles.navItem, focused && { backgroundColor: theme.pill }, (hovered || pressed) && !focused && { backgroundColor: theme.page }]}>
            <Ionicons name={item.icon} size={18} color={focused ? theme.blue : theme.secondary} />
            <Text style={[styles.navLabel, { color: focused ? theme.blue : theme.text }]}>{item.label()}</Text>
          </Pressable>;
        })}
      </View>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel="FeedMind GitHub"
        onPress={() => Linking.openURL(REPOSITORY_URL).catch(() => Alert.alert(t('linkOpenFailed')))}
        style={({ hovered, pressed }) => [
          styles.brandCard,
          { borderColor: theme.border, backgroundColor: theme.card },
          (hovered || pressed) && styles.brandCardActive,
        ]}
      >
        <View style={styles.brandCardTitle}>
          <View style={[styles.miniLogo, { backgroundColor: theme.text }]}>
            <Ionicons name="logo-github" color={theme.card} size={14} />
          </View>
          <Text style={[styles.cardTitle, { color: theme.text }]}>FeedMind</Text>
        </View>
        <Text style={[styles.cardSubtitle, { color: theme.secondary }]}>{t('aiPoweredRssReader')}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  sidebar: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 220, zIndex: 10, borderRightWidth: StyleSheet.hairlineWidth, paddingHorizontal: 22 },
  windowDots: { height: 42, flexDirection: 'row', alignItems: 'center', gap: 7 }, windowDot: { width: 10, height: 10, borderRadius: 5 },
  logoRow: { height: 56, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8 }, logo: { width: 25, height: 25, borderRadius: 6, marginRight: 12 }, brandName: { fontSize: 17, fontWeight: '800' },
  navigation: { marginTop: 24, gap: 8 }, navItem: { height: 46, borderRadius: 9, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14 }, navLabel: { fontSize: 15, fontWeight: '700', marginLeft: 14 },
  brandCard: { position: 'absolute', left: 16, right: 16, bottom: 24, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 14 }, brandCardActive: { opacity: 0.75 }, brandCardTitle: { flexDirection: 'row', alignItems: 'center' }, miniLogo: { width: 24, height: 24, borderRadius: 7, alignItems: 'center', justifyContent: 'center', marginRight: 10 }, cardTitle: { fontSize: 14, fontWeight: '800' }, cardSubtitle: { fontSize: 12, marginTop: 8 },
});
