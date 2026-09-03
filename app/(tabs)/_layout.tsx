import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Platform, Pressable } from 'react-native';
import { t } from '@/i18n';
import { useAppStore } from '@/store/appStore';
import { useThemeColors } from '@/utils/theme';

const icon = (outline: keyof typeof Ionicons.glyphMap, filled: keyof typeof Ionicons.glyphMap) =>
  function TabIcon({ color, focused }: { color: string; size: number; focused: boolean }) {
    return <Ionicons name={focused ? filled : outline} size={21} color={color} />;
  };

export default function TabLayout() {
  const themeColors = useThemeColors();
  useAppStore((state) => state.languageMode);

  return (
    <Tabs
      tabBar={Platform.OS === 'web' ? () => null : undefined}
      screenOptions={{
        headerShown: false,
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
          fontWeight: '600',
          marginTop: 2,
        },
        tabBarButton: ({ ref, ...props }) => (
          <Pressable
            {...props}
            android_ripple={{ color: 'transparent' }}
            style={({ pressed }) => [props.style, pressed && { opacity: 0.76, transform: [{ scale: 0.99 }] }]}
          />
        ),
      }}
    >
      <Tabs.Screen name="index" options={{ href: null }} />
      <Tabs.Screen name="feeds" options={{ href: null }} />
      <Tabs.Screen name="all" options={{ title: t('all'), tabBarIcon: icon('albums-outline', 'albums') }} />
      <Tabs.Screen name="recent" options={{ title: t('recentReading'), tabBarIcon: icon('time-outline', 'time') }} />
      <Tabs.Screen name="saved" options={{ title: t('saved'), tabBarIcon: icon('bookmark-outline', 'bookmark') }} />
      <Tabs.Screen name="subscriptions" options={{ title: t('feeds'), tabBarIcon: icon('list-outline', 'list') }} />
      <Tabs.Screen name="settings" options={{ title: t('settings'), tabBarIcon: icon('settings-outline', 'settings') }} />
    </Tabs>
  );
}
