import { Stack } from 'expo-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useBootstrap } from '@/hooks/useBootstrap';
import { colors, useThemeColors } from '@/utils/theme';
import { useAuthStore } from '@/auth/authStore';
import { AuthScreen } from '@/screens/AuthScreen';

export default function RootLayout() {
  const [client] = useState(() => new QueryClient());
  const ready = useBootstrap();
  const themeColors = useThemeColors();
  const user = useAuthStore((state) => state.user);

  useEffect(() => { client.clear(); }, [client, user]);

  if (!ready) return <View style={{ flex: 1, backgroundColor: colors.background }} />;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <QueryClientProvider client={client}>
        <StatusBar style={themeColors.background === colors.background ? 'dark' : 'light'} />
        {user ? <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: themeColors.background } }} /> : <AuthScreen />}
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}
