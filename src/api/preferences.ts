import { apiRequest } from './client';
import type { LanguageMode, ReaderThemeMode } from '@/types';
export type UserPreferences = { languageMode: LanguageMode; themeMode: ReaderThemeMode; fontSize: number; lineHeightRatio: number; version: number };
let cached: UserPreferences | null = null;
export const getPreferences = async () => { const x = await apiRequest<{ items: UserPreferences[] }>('/preferences'); cached = x.items[0] ?? null; return cached; };
export const updatePreferences = async (patch: Partial<Omit<UserPreferences, 'version'>>) => { const current = cached ?? await getPreferences(); if (!current) throw new Error('Preferences are unavailable'); const next = { ...current, ...patch }; const x = await apiRequest<{ items: UserPreferences[] }>('/preferences', { method: 'PATCH', body: JSON.stringify({ LanguageMode: next.languageMode, ThemeMode: next.themeMode, FontSize: next.fontSize, LineHeightRatio: next.lineHeightRatio, Version: current.version }) }); cached = x.items[0] ?? { ...next, version: current.version + 1 }; return cached; };
export const clearPreferencesCache = () => { cached = null; };
