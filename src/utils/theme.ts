import type { ReaderThemeMode } from '@/types';

export const colors = {
  background: '#FFFFFF',
  page: '#F7F7F8',
  text: '#111111',
  secondary: '#737780',
  subtle: '#A2A7B0',
  border: '#E8E9EC',
  blue: '#176FEA',
  pill: '#F1F5FF',
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
