import { router, Stack, usePathname } from 'expo-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useBootstrap } from '@/hooks/useBootstrap';
import { colors, useThemeColors } from '@/utils/theme';
import { useAuthStore } from '@/auth/authStore';
import { AuthScreen } from '@/screens/AuthScreen';
import { DesktopTabBar } from '@/components/DesktopTabBar';
import { useDesktopLayout } from '@/hooks/useDesktopLayout';

const desktopRoutes = [
  { key: 'index', name: 'index' },
  { key: 'feeds', name: 'feeds' },
  { key: 'saved', name: 'saved' },
  { key: 'settings', name: 'settings' },
];

export default function RootLayout() {
  const [client] = useState(() => new QueryClient());
  const ready = useBootstrap();
  const themeColors = useThemeColors();
  const user = useAuthStore((state) => state.user);
  const desktop = useDesktopLayout();
  const pathname = usePathname();
  const activeTab = pathname === '/feeds' ? 'feeds' : pathname === '/saved' ? 'saved' : pathname === '/settings' ? 'settings' : 'index';
  const desktopState = { index: desktopRoutes.findIndex((route) => route.name === activeTab), routes: desktopRoutes };
  const desktopNavigation = {
    navigate: (name: string) => {
      if (name === 'feeds') router.push('/feeds');
      else if (name === 'saved') router.push('/saved');
      else if (name === 'settings') router.push('/settings');
      else router.push('/');
    },
  };

  useEffect(() => { client.clear(); }, [client, user]);

  if (!ready) return <View style={{ flex: 1, backgroundColor: colors.background }} />;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <QueryClientProvider client={client}>
        <StatusBar style={themeColors.background === colors.background ? 'dark' : 'light'} />
        {user ? (
          <View style={{ flex: 1 }}>
            {desktop ? <DesktopTabBar state={desktopState} navigation={desktopNavigation} /> : null}
            <View style={{ flex: 1, marginLeft: desktop ? 220 : 0 }}>
              <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: themeColors.background } }} />
            </View>
          </View>
        ) : <AuthScreen />}
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}
