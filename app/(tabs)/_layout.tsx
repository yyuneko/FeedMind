import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useThemeColors } from '@/utils/theme';

const icon = (outline: keyof typeof Ionicons.glyphMap, filled: keyof typeof Ionicons.glyphMap) =>
  function TabIcon({ color, focused }: { color: string; size: number; focused: boolean }) {
    return <Ionicons name={focused ? filled : outline} size={21} color={color} />;
  };

export default function TabLayout() {
  const themeColors = useThemeColors();

  return (
    <Tabs
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
          fontWeight: '700',
          marginTop: 2,
        },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Today', tabBarIcon: icon('today-outline', 'today') }} />
      <Tabs.Screen name="feeds" options={{ title: 'Feeds', tabBarIcon: icon('list-outline', 'list') }} />
      <Tabs.Screen name="saved" options={{ title: 'Saved', tabBarIcon: icon('bookmark-outline', 'bookmark') }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings', tabBarIcon: icon('settings-outline', 'settings') }} />
    </Tabs>
  );
}
