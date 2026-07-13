import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Pressable } from 'react-native';
import { t } from '@/i18n';
import { useAppStore } from '@/store/appStore';
import { useThemeColors } from '@/utils/theme';
import { useDesktopLayout } from '@/hooks/useDesktopLayout';

const icon = (outline: keyof typeof Ionicons.glyphMap, filled: keyof typeof Ionicons.glyphMap) =>
  function TabIcon({ color, focused }: { color: string; size: number; focused: boolean }) {
    return <Ionicons name={focused ? filled : outline} size={21} color={color} />;
  };

export default function TabLayout() {
  const themeColors = useThemeColors();
  const desktop = useDesktopLayout();
  useAppStore((state) => state.languageMode);

  return (
    <Tabs
      tabBar={desktop ? () => null : undefined}
      screenOptions={{
        headerShown: false,
        sceneStyle: desktop ? { backgroundColor: themeColors.page } : undefined,
        tabBarActiveTintColor: themeColors.text,
        tabBarInactiveTintColor: themeColors.secondary,
        tabBarStyle: {
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
}
