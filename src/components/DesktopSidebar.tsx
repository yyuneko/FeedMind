import { Ionicons } from '@expo/vector-icons';
import { router, usePathname } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { t } from '@/i18n';
import { useAppStore } from '@/store/appStore';
import { useThemeColors } from '@/utils/theme';

const items = [
  { path: '/', label: 'today' as const, icon: 'today-outline' as const, activeIcon: 'today' as const },
  { path: '/feeds', label: 'feeds' as const, icon: 'list-outline' as const, activeIcon: 'list' as const },
  { path: '/saved', label: 'saved' as const, icon: 'bookmark-outline' as const, activeIcon: 'bookmark' as const },
  { path: '/settings', label: 'settings' as const, icon: 'settings-outline' as const, activeIcon: 'settings' as const },
];

export const DesktopSidebar = () => {
  const pathname = usePathname();
  const themeColors = useThemeColors();
  useAppStore((state) => state.languageMode);

  return (
    <View style={[styles.sidebar, { backgroundColor: themeColors.page, borderRightColor: themeColors.border }]}> 
      <View style={styles.brand}>
        <View style={[styles.logo, { backgroundColor: themeColors.text }]}>
          <Ionicons name="logo-rss" size={17} color={themeColors.background} />
        </View>
        <Text style={[styles.brandText, { color: themeColors.text }]}>FeedMind</Text>
      </View>

      <View style={styles.navigation}>
        {items.map((item) => {
          const active = item.path === '/' ? pathname === '/' : pathname.startsWith(item.path);
          return (
            <Pressable
              key={item.path}
              onPress={() => router.replace(item.path)}
              style={({ pressed }) => [
                styles.item,
                active && { backgroundColor: themeColors.card },
                pressed && styles.pressed,
              ]}
            >
              <Ionicons name={active ? item.activeIcon : item.icon} size={20} color={active ? themeColors.text : themeColors.secondary} />
              <Text style={[styles.label, { color: active ? themeColors.text : themeColors.secondary }, active && styles.activeLabel]}>
                {t(item.label)}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <Text style={[styles.footer, { color: themeColors.subtle }]}>AI RSS Reader</Text>
    </View>
  );
};

const styles = StyleSheet.create({
  sidebar: {
    width: 232,
    height: '100%',
    borderRightWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 18,
    paddingTop: 28,
    paddingBottom: 24,
  },
  brand: {
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
  },
  logo: {
    width: 30,
    height: 30,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  brandText: {
    marginLeft: 11,
    fontSize: 18,
    fontWeight: '800',
    letterSpacing: -0.3,
  },
  navigation: {
    flex: 1,
    marginTop: 30,
    gap: 6,
  },
  item: {
    height: 46,
    borderRadius: 10,
    paddingHorizontal: 13,
    flexDirection: 'row',
    alignItems: 'center',
  },
  label: {
    marginLeft: 13,
    fontSize: 14,
    fontWeight: '600',
  },
  activeLabel: {
    fontWeight: '800',
  },
  footer: {
    paddingHorizontal: 10,
    fontSize: 11,
    fontWeight: '600',
  },
  pressed: {
    opacity: 0.68,
  },
});