import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '@/utils/theme';

const icon = (name: keyof typeof Ionicons.glyphMap) =>
  function TabIcon({ color, size }: { color: string; size: number }) {
    return <Ionicons name={name} size={size} color={color} />;
  };

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.text,
        tabBarInactiveTintColor: colors.secondary,
        tabBarStyle: {
          height: 68,
          paddingTop: 8,
          borderTopColor: colors.border,
          backgroundColor: colors.background,
        },
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: '700',
          marginTop: 2,
        },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Today', tabBarIcon: icon('today-outline') }} />
      <Tabs.Screen name="feeds" options={{ title: 'Feeds', tabBarIcon: icon('list-outline') }} />
      <Tabs.Screen name="saved" options={{ title: 'Saved', tabBarIcon: icon('bookmark-outline') }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings', tabBarIcon: icon('settings-outline') }} />
    </Tabs>
  );
}
