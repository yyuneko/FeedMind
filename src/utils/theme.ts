import type { ReaderThemeMode } from '@/types';
import { useEffect, useState } from 'react';
import { AccessibilityInfo, Platform, useColorScheme } from 'react-native';
import { useAppStore } from '@/store/appStore';

const lightPalette = {
  background: '#FFFFFF',
  page: '#F5F5F7',
  text: '#1D1D1F',
  secondary: '#6E6E73',
  subtle: '#8E8E93',
  border: '#E5E5EA',
  borderStrong: '#D1D1D6',
  blue: '#007AFF',
  pill: '#F0F4FA',
  card: '#FFFFFF',
  hover: '#F5F5F7',
  pressed: '#EDEDF0',
  selected: '#EAF2FC',
  disabled: '#AEAEB2',
  destructive: '#D70015',
  success: '#248A3D',
  warning: '#B25000',
  scrimLight: 'rgba(0, 0, 0, 0.16)',
  scrim: 'rgba(0, 0, 0, 0.28)',
  scrimStrong: 'rgba(0, 0, 0, 0.42)',
  quote: '#F5F8FC',
  code: '#F5F5F7',
  mark: '#FFF0A6',
};

export const colors = lightPalette;

export const spacing = {
  xxs: 2, xs: 4, sm: 6, md: 8, lg: 12, xl: 16,
  xxl: 20, xxxl: 24, section: 32, large: 40, huge: 48,
  screenX: 20,
} as const;

export const radius = { small: 4, control: 8, panel: 12, sheet: 18, round: 999 } as const;

export const typography = {
  pageTitle: { fontSize: 24, lineHeight: 30, fontWeight: '700' as const },
  navigationTitle: { fontSize: 17, lineHeight: 22, fontWeight: '600' as const },
  sectionLabel: { fontSize: 13, lineHeight: 18, fontWeight: '600' as const },
  listTitle: { fontSize: 15, lineHeight: 21, fontWeight: '600' as const },
  body: { fontSize: 15, lineHeight: 22, fontWeight: '400' as const },
  secondaryBody: { fontSize: 14, lineHeight: 20, fontWeight: '400' as const },
  metadata: { fontSize: 12, lineHeight: 16, fontWeight: '400' as const },
  control: { fontSize: 13, lineHeight: 18, fontWeight: '600' as const },
  readerTitle: { fontSize: 28, lineHeight: 36, fontWeight: '700' as const },
} as const;

export const motion = {
  duration: { instant: 90, fast: 160, normal: 240, slow: 360, page: 420 },
  spring: {
    snappy: { damping: 20, stiffness: 360, mass: 0.7 },
    smooth: { damping: 24, stiffness: 240, mass: 0.9 },
    page: { damping: 28, stiffness: 190, mass: 1 },
  },
} as const;

export const zIndex = { navigation: 10, sticky: 20, popover: 40, sheet: 60, dialog: 80, viewer: 90, ai: 100 } as const;
export const breakpoints = { tablet: 768, desktop: 900, wide: 1100 } as const;

const darkColors: typeof lightPalette = {
  background: '#111113', page: '#1C1C1E', text: '#F5F5F7', secondary: '#AEAEB2', subtle: '#8E8E93',
  border: '#2C2C2E', borderStrong: '#3A3A3C', blue: '#5E9DFF', pill: '#202A38', card: '#171719',
  hover: '#222225', pressed: '#2C2C2E', selected: '#1E3048', disabled: '#636366', destructive: '#FF453A',
  success: '#30D158', warning: '#FF9F0A', scrimLight: 'rgba(0, 0, 0, 0.24)', scrim: 'rgba(0, 0, 0, 0.42)',
  scrimStrong: 'rgba(0, 0, 0, 0.58)', quote: '#18212C', code: '#202124', mark: '#6B5714',
};

export const getReaderColors = (themeMode: ReaderThemeMode, systemDark: boolean) => {
  if (themeMode === 'dark' || (themeMode === 'system' && systemDark)) return darkColors;
  return colors;
};

export const useThemeColors = () => {
  const systemDark = useColorScheme() === 'dark';
  const themeMode = useAppStore((state) => state.themeMode);
  return getReaderColors(themeMode, systemDark);
};

export const useReducedMotion = () => {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let active = true;
    AccessibilityInfo.isReduceMotionEnabled().then((value) => active && setReduced(value)).catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    const media = Platform.OS === 'web' && typeof window !== 'undefined' ? window.matchMedia?.('(prefers-reduced-motion: reduce)') : undefined;
    const onMediaChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    if (media) {
      setReduced(media.matches);
      media.addEventListener?.('change', onMediaChange);
    }
    return () => {
      active = false;
      subscription.remove();
      media?.removeEventListener?.('change', onMediaChange);
    };
  }, []);
  return reduced;
};
