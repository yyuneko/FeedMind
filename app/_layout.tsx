import { Stack, usePathname } from 'expo-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { Platform, View, useWindowDimensions } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useBootstrap } from '@/hooks/useBootstrap';
import { colors, motion, useReducedMotion, useThemeColors } from '@/utils/theme';
import { useAuthStore } from '@/auth/authStore';
import { AuthScreen } from '@/screens/AuthScreen';
import { MobileDownloadLanding } from '@/components/MobileDownloadLanding';
import { WebLibraryDialogs } from '@/components/WebLibraryDialogs';
import { WEB_SIDEBAR_WIDTH, WebSidebar } from '@/components/WebSidebar';
import { ThinkingModeProvider } from '@/components/ThinkingModeOverlay';

const WEB_MIN_WIDTH = 1100;

export default function RootLayout() {
  const pathname = usePathname();
  const { width } = useWindowDimensions();
  const [viewportReady, setViewportReady] = useState(Platform.OS !== 'web');

  useEffect(() => {
    if (Platform.OS === 'web') setViewportReady(true);
  }, []);

  if (Platform.OS === 'web' && pathname === '/download') return <MobileDownloadLanding />;
  if (!viewportReady) return <View style={{ flex: 1, backgroundColor: colors.background }} />;
  if (Platform.OS === 'web' && width < WEB_MIN_WIDTH) return <MobileDownloadLanding />;
  return <ApplicationRoot />;
}

function ApplicationRoot() {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: {
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
  } } }));
  const ready = useBootstrap();
  const themeColors = useThemeColors();
  const user = useAuthStore((state) => state.user);
  const reducedMotion = useReducedMotion();
  const web = Platform.OS === 'web';

  useEffect(() => { client.clear(); }, [client, user]);
  useEffect(() => {
    if (!web || typeof document === 'undefined') return;
    const style = document.createElement('style');
    style.dataset.feedmindScrollbars = 'true';
    style.textContent = `
      [data-scrollbar="feedmind"] {
        scrollbar-width: thin;
        scrollbar-color: ${themeColors.border} transparent;
      }
      [data-scrollbar="feedmind"]::-webkit-scrollbar {
        width: 4px;
        height: 4px;
      }
      [data-scrollbar="feedmind"]::-webkit-scrollbar-track {
        background: transparent;
      }
      [data-scrollbar="feedmind"]::-webkit-scrollbar-thumb {
        min-height: 32px;
        border-radius: 999px;
        background: ${themeColors.border};
      }
      [data-scrollbar="feedmind"]::-webkit-scrollbar-thumb:hover {
        background: ${themeColors.borderStrong};
      }
      [data-scrollbar="feedmind"]::-webkit-scrollbar-button {
        display: none;
        width: 0;
        height: 0;
      }
      [data-scrollbar="feedmind"]::-webkit-scrollbar-corner {
        background: transparent;
      }
    `;
    document.head.appendChild(style);
    return () => style.remove();
  }, [themeColors.border, themeColors.borderStrong, web]);
  if (!ready) return <View style={{ flex: 1, backgroundColor: colors.background }} />;

  return <GestureHandlerRootView style={{ flex: 1 }}>
    <QueryClientProvider client={client}>
      <StatusBar style={themeColors.background === colors.background ? 'dark' : 'light'} />
      <ThinkingModeProvider>
        {user ? <View style={{ flex: 1 }}>
          {web ? <WebSidebar /> : null}
          <View style={{ flex: 1, marginLeft: web ? WEB_SIDEBAR_WIDTH : 0 }}>
            <Stack screenOptions={{ headerShown: false, animation: web || reducedMotion ? 'none' : 'slide_from_right', animationDuration: reducedMotion ? 0 : motion.duration.page, contentStyle: { backgroundColor: themeColors.background } }} />
          </View>
          {web ? <WebLibraryDialogs /> : null}
        </View> : <AuthScreen />}
      </ThinkingModeProvider>
    </QueryClientProvider>
  </GestureHandlerRootView>;
}
