import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, View } from 'react-native';
import { DesktopSidebar } from '@/components/DesktopSidebar';
import { t } from '@/i18n';
import { useAppStore } from '@/store/appStore';
import { useIsDesktop } from '@/utils/responsive';
import { useThemeColors } from '@/utils/theme';

const icon = (outline: keyof typeof Ionicons.glyphMap, filled: keyof typeof Ionicons.glyphMap) =>
  function TabIcon({ color, focused }: { color: string; size: number; focused: boolean }) {
    return <Ionicons name={focused ? filled : outline} size={21} color={color} />;
  };

export default function TabLayout() {
  const themeColors = useThemeColors();
  const isDesktop = useIsDesktop();
  useAppStore((state) => state.languageMode);

  const tabs = (
    <Tabs
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: themeColors.background },
        tabBarActiveTintColor: themeColors.text,
        tabBarInactiveTintColor: themeColors.secondary,
        tabBarStyle: isDesktop ? styles.hiddenTabBar : {
          height: 68,
          paddingTop: 7,
          borderTopColor: themeColors.border,
          backgroundColor: themeColors.background,
        },
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: '700',
          marginTop: 2,
        },
        tabBarButton: ({ ref, ...props }) => (
          <Pressable
            {...props}
            android_ripple={{ color: 'transparent' }}
            style={({ pressed }) => [props.style, pressed && { opacity: 0.9 }]}
          />
        ),
      }}
    >
      <Tabs.Screen name="index" options={{ title: t('today'), tabBarIcon: icon('today-outline', 'today') }} />
      <Tabs.Screen name="feeds" options={{ title: t('feeds'), tabBarIcon: icon('list-outline', 'list') }} />
      <Tabs.Screen name="saved" options={{ title: t('saved'), tabBarIcon: icon('bookmark-outline', 'bookmark') }} />
      <Tabs.Screen name="settings" options={{ title: t('settings'), tabBarIcon: icon('settings-outline', 'settings') }} />
    </Tabs>
  );

  if (!isDesktop) return tabs;

  return (
    <View style={[styles.desktopShell, { backgroundColor: themeColors.background }]}>
      <DesktopSidebar />
      <View style={styles.desktopContent}>{tabs}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  desktopShell: {
    flex: 1,
    flexDirection: 'row',
  },
  desktopContent: {
    flex: 1,
    minWidth: 0,
  },
  hiddenTabBar: {
    display: 'none',
  },
});