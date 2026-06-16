import { create } from 'zustand';
import type { ArticleFilter, ReaderThemeMode, ReadingMode } from '@/types';

type AppState = {
  filter: ArticleFilter;
  readingMode: ReadingMode;
  fontSize: number;
  lineHeightRatio: number;
  themeMode: ReaderThemeMode;
  setFilter: (filter: ArticleFilter) => void;
  setReadingMode: (mode: ReadingMode) => void;
  setFontSize: (fontSize: number) => void;
  setLineHeightRatio: (lineHeightRatio: number) => void;
  setThemeMode: (themeMode: ReaderThemeMode) => void;
};

export const useAppStore = create<AppState>((set) => ({
  filter: 'all',
  readingMode: 'original',
  fontSize: 17,
  lineHeightRatio: 1.65,
  themeMode: 'system',
  setFilter: (filter) => set({ filter }),
  setReadingMode: (readingMode) => set({ readingMode }),
  setFontSize: (fontSize) => set({ fontSize }),
  setLineHeightRatio: (lineHeightRatio) => set({ lineHeightRatio }),
  setThemeMode: (themeMode) => set({ themeMode }),
}));
