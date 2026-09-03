import { Ionicons } from '@expo/vector-icons';
import { useVideoPlayer, VideoView } from 'expo-video';
import React, { useEffect, useMemo, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { t } from '@/i18n';
import { withAutomaticPlayback, type ArticleMediaSource } from '@/utils/articleMedia';
import { radius, spacing, typography, useThemeColors } from '@/utils/theme';

type ArticleMediaProps = {
  kind: 'video' | 'audio' | 'embed'; uri: string; sources?: ArticleMediaSource[]; poster?: string;
  width: number; sourceWidth?: number; sourceHeight?: number; trustedEmbed?: boolean; title?: string;
};
const mediaHeight = (width: number, sourceWidth?: number, sourceHeight?: number) => Math.max(180, Math.min(width * 1.5, Math.round(width * (sourceWidth && sourceHeight ? sourceHeight / sourceWidth : 9 / 16))));
const uniqueSources = (uri: string, sources: ArticleMediaSource[] = []) => Array.from(new Map([uri ? { uri } : null, ...sources].filter((item): item is ArticleMediaSource => Boolean(item?.uri)).map((item) => [item.uri, item])).values());
const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

const Failure = ({ uri, width }: { uri: string; width: number }) => { const colors = useThemeColors(); return <View style={[styles.failure, { width, backgroundColor: colors.page }]}><Text style={{ color: colors.secondary }}>{t('mediaLoadFailed')}</Text><Pressable accessibilityRole="link" onPress={() => Linking.openURL(uri).catch(() => undefined)}><Text style={{ color: colors.blue, textDecorationLine: 'underline' }}>{t('openInBrowser')}</Text></Pressable></View>; };

const ArticleVideo = ({ items, width, height }: { items: ArticleMediaSource[]; width: number; height: number }) => {
  const [muted, setMuted] = useState(true); const [sourceIndex, setSourceIndex] = useState(0); const [failed, setFailed] = useState(false);
  const player = useVideoPlayer(items[0]?.uri ?? null, (value) => { value.loop = true; value.muted = true; value.play(); });
  useEffect(() => { const subscription = player.addListener('statusChange', ({ status }) => { if (status !== 'error') return; const next = sourceIndex + 1; if (next >= items.length) { setFailed(true); return; } setSourceIndex(next); player.replace(items[next].uri); player.muted = true; player.play(); }); return () => subscription.remove(); }, [items, player, sourceIndex]);
  if (failed) return <Failure uri={items[0]?.uri ?? ''} width={width} />;
  const toggleMuted = () => { const next = !muted; player.muted = next; setMuted(next); };
  return <View style={{ width, height }}><VideoView player={player} nativeControls allowsFullscreen contentFit="contain" style={styles.video} /><Pressable accessibilityRole="button" accessibilityLabel={muted ? '取消静音' : '静音'} hitSlop={8} onPress={toggleMuted} style={({ pressed }) => [styles.muteButton, pressed && styles.pressed]}><Ionicons name={muted ? 'volume-mute' : 'volume-high'} size={20} color="#fff" /></Pressable></View>;
};

const ArticleAudio = ({ items, width }: { items: ArticleMediaSource[]; width: number }) => {
  const [failed, setFailed] = useState(false);
  const html = useMemo(() => `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;background:#111}audio{width:100%;height:54px}</style><audio controls preload="metadata">${items.map((item) => `<source src="${escapeHtml(item.uri)}"${item.type ? ` type="${escapeHtml(item.type)}"` : ''}>`).join('')}</audio>`, [items]);
  if (failed) return <Failure uri={items[0]?.uri ?? ''} width={width} />;
  return <WebView source={{ html, baseUrl: 'about:blank' }} style={{ width, height: 58, backgroundColor: '#111' }} originWhitelist={['about:*', 'https://*', 'http://*']} javaScriptEnabled={false} scrollEnabled={false} mediaPlaybackRequiresUserAction onError={() => setFailed(true)} />;
};

export function ArticleMedia({ kind, uri, sources, width, sourceWidth, sourceHeight, trustedEmbed = false, title }: ArticleMediaProps) {
  const colors = useThemeColors();
  const items = uniqueSources(uri, sources); const [loaded, setLoaded] = useState(trustedEmbed); const [failed, setFailed] = useState(false);
  if (!items.length) return null;
  if (kind === 'audio') return <View style={[styles.container, { width, height: 58 }]}><ArticleAudio items={items} width={width} /></View>;
  const height = mediaHeight(width, sourceWidth, sourceHeight);
  if (kind === 'video') return <View style={[styles.container, { width, height }]}><ArticleVideo items={items} width={width} height={height} /></View>;
  if (!loaded) { let hostname = uri; try { hostname = new URL(uri).hostname; } catch {} return <View style={[styles.embedPrompt, { width, minHeight: 110, backgroundColor: colors.page }]}><Ionicons name="code-slash-outline" size={24} color={colors.secondary} /><Text style={[styles.embedTitle, { color: colors.text }]}>{title || hostname}</Text><Pressable accessibilityRole="button" style={[styles.loadButton, { backgroundColor: colors.blue }]} onPress={() => setLoaded(true)}><Text style={styles.loadButtonText}>{t('loadEmbeddedContent')}</Text></Pressable></View>; }
  if (failed) return <Failure uri={uri} width={width} />;
  const automaticUri = trustedEmbed ? withAutomaticPlayback(uri) : uri; let initialOrigin = ''; try { initialOrigin = new URL(automaticUri).origin; } catch {}
  return <View style={[styles.container, { width, height }]}><WebView source={{ uri: automaticUri }} style={styles.webView} originWhitelist={['https://*', ...(trustedEmbed ? ['http://*'] : [])]} javaScriptEnabled domStorageEnabled mediaPlaybackRequiresUserAction={!trustedEmbed} allowsFullscreenVideo allowsInlineMediaPlayback scrollEnabled={false} setSupportMultipleWindows={false} onError={() => setFailed(true)} onShouldStartLoadWithRequest={(request) => { try { const target = new URL(request.url); if (target.protocol !== 'https:' && !(trustedEmbed && target.protocol === 'http:')) return false; if (!initialOrigin || target.origin === initialOrigin) return true; Linking.openURL(request.url).catch(() => undefined); } catch {} return false; }} /></View>;
}

const styles = StyleSheet.create({
  container: { alignSelf: 'center', marginVertical: spacing.lg, overflow: 'hidden', borderRadius: radius.control, backgroundColor: '#000' }, webView: { flex: 1, backgroundColor: '#000' }, video: { ...StyleSheet.absoluteFillObject },
  muteButton: { position: 'absolute', top: 10, right: 10, width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.62)' }, pressed: { opacity: 0.65 },
  embedPrompt: { alignSelf: 'center', marginVertical: spacing.lg, padding: spacing.xl, borderRadius: radius.control, alignItems: 'center', justifyContent: 'center', gap: spacing.md }, embedTitle: { ...typography.secondaryBody, textAlign: 'center' }, loadButton: { minHeight: 44, borderRadius: radius.control, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center' }, loadButtonText: { color: '#fff', fontWeight: '600' },
  failure: { minHeight: 80, marginVertical: spacing.lg, padding: 14, borderRadius: radius.control, alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
});
