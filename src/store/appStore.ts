import { create } from 'zustand';
import { setI18nLanguageMode } from '@/i18n';
import type { ArticleFilter, LanguageMode, ReaderFont, ReaderThemeMode, ReadingMode } from '@/types';

type AppState = {
  filter: ArticleFilter;
  readingMode: ReadingMode;
  fontSize: number;
  lineHeightRatio: number;
  readerFont: ReaderFont;
  themeMode: ReaderThemeMode;
  languageMode: LanguageMode;
  selectedPromptId?: string;
  setFilter: (filter: ArticleFilter) => void;
  setReadingMode: (mode: ReadingMode) => void;
  setFontSize: (fontSize: number) => void;
  setLineHeightRatio: (lineHeightRatio: number) => void;
  setReaderFont: (readerFont: ReaderFont) => void;
  setThemeMode: (themeMode: ReaderThemeMode) => void;
  setLanguageMode: (languageMode: LanguageMode) => void;
  setSelectedPromptId: (id: string) => void;
};

export const useAppStore = create<AppState>((set) => ({
  filter: 'all',
  readingMode: 'original',
  fontSize: 17,
  lineHeightRatio: 1.65,
  readerFont: 'system',
  themeMode: 'system',
  languageMode: 'system',
  setFilter: (filter) => set({ filter }),
  setReadingMode: (readingMode) => set({ readingMode }),
  setFontSize: (fontSize) => set({ fontSize }),
  setLineHeightRatio: (lineHeightRatio) => set({ lineHeightRatio }),
  setReaderFont: (readerFont) => set({ readerFont }),
  setThemeMode: (themeMode) => set({ themeMode }),
  setLanguageMode: (languageMode) => {
    setI18nLanguageMode(languageMode);
    set({ languageMode });
  },
  setSelectedPromptId: (selectedPromptId) => set({ selectedPromptId }),
}));
