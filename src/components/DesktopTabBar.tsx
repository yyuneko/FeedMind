import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { t } from '@/i18n';
import { useLocalSearchParams, usePathname } from 'expo-router';
import { useAppStore } from '@/store/appStore';
import { parseSelectionScope, useNavigationStore } from '@/store/navigationStore';
import { radius, spacing, typography, useThemeColors, zIndex } from '@/utils/theme';

export const DESKTOP_SIDEBAR_WIDTH = 208;

const items: Record<string, { label: () => string; icon: keyof typeof Ionicons.glyphMap; activeIcon: keyof typeof Ionicons.glyphMap }> = {
  index: { label: () => t('today'), icon: 'calendar-outline', activeIcon: 'calendar' },
  feeds: { label: () => t('feeds'), icon: 'list-outline', activeIcon: 'list' },
  saved: { label: () => t('saved'), icon: 'bookmark-outline', activeIcon: 'bookmark' },
  settings: { label: () => t('settings'), icon: 'settings-outline', activeIcon: 'settings' },
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
      <View style={styles.logoRow}><Image source={require('../../assets/favicon.png')} style={styles.logo} contentFit="cover" /><Text style={[styles.brandName, { color: theme.text }]}>FeedMind</Text></View>
      <View style={styles.navigation}>
        {state.routes.filter((route) => items[route.name]).map((route) => {
          const item = items[route.name];
          const focused = fallbackRoute ? route.name === fallbackRoute : state.index === state.routes.indexOf(route);
          return <Pressable key={route.key} accessibilityRole="tab" accessibilityState={{ selected: focused }} onPress={() => navigation.navigate(route.name)} style={({ hovered, pressed, focused: keyboardFocused }: any) => [styles.navItem, focused && { backgroundColor: theme.selected }, hovered && !focused && { backgroundColor: theme.hover }, pressed && { backgroundColor: theme.pressed }, keyboardFocused && { borderColor: theme.blue, borderWidth: 2 }]}>
            {focused && <View style={[styles.selectionMarker, { backgroundColor: theme.blue }]} />}
            <Ionicons name={focused ? item.activeIcon : item.icon} size={18} color={focused ? theme.blue : theme.secondary} />
            <Text style={[styles.navLabel, { color: focused ? theme.blue : theme.text }]}>{item.label()}</Text>
          </Pressable>;
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  sidebar: { position: 'absolute', left: 0, top: 0, bottom: 0, width: DESKTOP_SIDEBAR_WIDTH, zIndex: zIndex.navigation, borderRightWidth: StyleSheet.hairlineWidth, paddingHorizontal: spacing.xl, paddingTop: spacing.xl },
  logoRow: { height: 52, flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.md },
  logo: { width: 24, height: 24, borderRadius: radius.small, marginRight: spacing.lg },
  brandName: { ...typography.navigationTitle },
  navigation: { marginTop: spacing.xxl, gap: spacing.xs },
  navItem: { height: 44, borderRadius: radius.control, flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg },
  selectionMarker: { position: 'absolute', left: 0, width: 3, height: 20, borderRadius: 2 },
  navLabel: { ...typography.body, fontWeight: '500', marginLeft: spacing.lg },
});
