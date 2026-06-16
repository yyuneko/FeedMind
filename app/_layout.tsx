import { Stack } from 'expo-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { View } from 'react-native';
import { useBootstrap } from '@/hooks/useBootstrap';
import { colors } from '@/utils/theme';

export default function RootLayout() {
  const [client] = useState(() => new QueryClient());
  const ready = useBootstrap();

  if (!ready) return <View style={{ flex: 1, backgroundColor: colors.background }} />;

  return (
    <QueryClientProvider client={client}>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }} />
    </QueryClientProvider>
  );
}
