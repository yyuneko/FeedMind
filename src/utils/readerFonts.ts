import * as Font from 'expo-font';
import { useEffect, useState } from 'react';
import { Literata_400Regular } from '@expo-google-fonts/literata/400Regular';
import { Literata_700Bold } from '@expo-google-fonts/literata/700Bold';
import { NotoSerifSC_400Regular } from '@expo-google-fonts/noto-serif-sc/400Regular';
import { NotoSerifSC_700Bold } from '@expo-google-fonts/noto-serif-sc/700Bold';
import { SourceSerif4_400Regular } from '@expo-google-fonts/source-serif-4/400Regular';
import { SourceSerif4_700Bold } from '@expo-google-fonts/source-serif-4/700Bold';
import type { ReaderFont } from '@/types';

type FontLoadState = 'idle' | 'loading' | 'ready' | 'failed';
type FontFamilies = { regular?: string; bold?: string };

const fontAssets = {
  FeedMindSourceHanSerifRegular: NotoSerifSC_400Regular,
  FeedMindSourceHanSerifBold: NotoSerifSC_700Bold,
  FeedMindLiterataRegular: Literata_400Regular,
  FeedMindLiterataBold: Literata_700Bold,
  FeedMindSourceSerif4Regular: SourceSerif4_400Regular,
  FeedMindSourceSerif4Bold: SourceSerif4_700Bold,
};

const loadedFamilies: Record<Exclude<ReaderFont, 'system'>, Required<FontFamilies>> = {
  'source-han-serif': { regular: 'FeedMindSourceHanSerifRegular', bold: 'FeedMindSourceHanSerifBold' },
  literata: { regular: 'FeedMindLiterataRegular', bold: 'FeedMindLiterataBold' },
  'source-serif-4': { regular: 'FeedMindSourceSerif4Regular', bold: 'FeedMindSourceSerif4Bold' },
};

let loadState: FontLoadState = 'idle';
let loadPromise: Promise<void> | undefined;
const listeners = new Set<() => void>();

const notify = () => listeners.forEach((listener) => listener());

export const loadReaderFonts = () => {
  if (loadPromise) return loadPromise;
  loadState = 'loading';
  loadPromise = Font.loadAsync(fontAssets)
    .then(() => { loadState = 'ready'; })
    .catch(() => { loadState = 'failed'; })
    .finally(notify);
  return loadPromise;
};

export const useReaderFontFamilies = (font: ReaderFont): FontFamilies => {
  const [, refresh] = useState(0);

  useEffect(() => {
    const listener = () => refresh((value) => value + 1);
    listeners.add(listener);
    loadReaderFonts();
    return () => { listeners.delete(listener); };
  }, []);

  return font !== 'system' && loadState === 'ready' ? loadedFamilies[font] : {};
};
