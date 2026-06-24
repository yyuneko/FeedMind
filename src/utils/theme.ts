import type { ReaderThemeMode } from '@/types';
import { useColorScheme } from 'react-native';
import { useAppStore } from '@/store/appStore';

export const colors = {
  background: '#FFFFFF',
  page: '#F8F9FB',
  text: '#111827',
  secondary: '#667085',
  subtle: '#9AA3B2',
  border: '#E9ECF2',
  blue: '#0A84FF',
  pill: '#F4F7FF',
  card: '#FFFFFF',
};

export const spacing = {
  screenX: 22,
};

const darkColors = {
  background: '#101112',
  page: '#191B1F',
  text: '#F2F3F5',
  secondary: '#B0B4BC',
  subtle: '#7F858F',
  border: '#2A2D33',
  blue: '#6DA2FF',
  pill: '#1D2A3D',
  card: '#17191D',
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
