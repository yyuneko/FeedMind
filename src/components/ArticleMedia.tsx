import { Ionicons } from '@expo/vector-icons';
import { useVideoPlayer, VideoView } from 'expo-video';
import React, { useEffect, useMemo, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { t } from '@/i18n';
import { withAutomaticPlayback, type ArticleMediaSource } from '@/utils/articleMedia';

type ArticleMediaProps = {
  kind: 'video' | 'audio' | 'embed'; uri: string; sources?: ArticleMediaSource[]; poster?: string;
  width: number; sourceWidth?: number; sourceHeight?: number; trustedEmbed?: boolean; title?: string;
};
const mediaHeight = (width: number, sourceWidth?: number, sourceHeight?: number) => Math.max(180, Math.min(width * 1.5, Math.round(width * (sourceWidth && sourceHeight ? sourceHeight / sourceWidth : 9 / 16))));
const uniqueSources = (uri: string, sources: ArticleMediaSource[] = []) => Array.from(new Map([uri ? { uri } : null, ...sources].filter((item): item is ArticleMediaSource => Boolean(item?.uri)).map((item) => [item.uri, item])).values());
const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

const Failure = ({ uri, width }: { uri: string; width: number }) => <View style={[styles.failure, { width }]}><Text style={styles.failureText}>{t('mediaLoadFailed')}</Text><Pressable accessibilityRole="link" onPress={() => Linking.openURL(uri).catch(() => undefined)}><Text style={styles.failureLink}>{t('openInBrowser')}</Text></Pressable></View>;

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
  const items = uniqueSources(uri, sources); const [loaded, setLoaded] = useState(trustedEmbed); const [failed, setFailed] = useState(false);
  if (!items.length) return null;
  if (kind === 'audio') return <View style={[styles.container, { width, height: 58 }]}><ArticleAudio items={items} width={width} /></View>;
  const height = mediaHeight(width, sourceWidth, sourceHeight);
  if (kind === 'video') return <View style={[styles.container, { width, height }]}><ArticleVideo items={items} width={width} height={height} /></View>;
  if (!loaded) { let hostname = uri; try { hostname = new URL(uri).hostname; } catch {} return <View style={[styles.embedPrompt, { width, minHeight: 110 }]}><Ionicons name="code-slash-outline" size={24} color="#8a94a6" /><Text style={styles.embedTitle}>{title || hostname}</Text><Pressable accessibilityRole="button" style={styles.loadButton} onPress={() => setLoaded(true)}><Text style={styles.loadButtonText}>{t('loadEmbeddedContent')}</Text></Pressable></View>; }
  if (failed) return <Failure uri={uri} width={width} />;
  const automaticUri = trustedEmbed ? withAutomaticPlayback(uri) : uri; let initialOrigin = ''; try { initialOrigin = new URL(automaticUri).origin; } catch {}
  return <View style={[styles.container, { width, height }]}><WebView source={{ uri: automaticUri }} style={styles.webView} originWhitelist={['https://*', ...(trustedEmbed ? ['http://*'] : [])]} javaScriptEnabled domStorageEnabled mediaPlaybackRequiresUserAction={!trustedEmbed} allowsFullscreenVideo allowsInlineMediaPlayback scrollEnabled={false} setSupportMultipleWindows={false} onError={() => setFailed(true)} onShouldStartLoadWithRequest={(request) => { try { const target = new URL(request.url); if (target.protocol !== 'https:' && !(trustedEmbed && target.protocol === 'http:')) return false; if (!initialOrigin || target.origin === initialOrigin) return true; Linking.openURL(request.url).catch(() => undefined); } catch {} return false; }} /></View>;
}

const styles = StyleSheet.create({
  container: { alignSelf: 'center', marginVertical: 10, overflow: 'hidden', borderRadius: 8, backgroundColor: '#000' }, webView: { flex: 1, backgroundColor: '#000' }, video: { ...StyleSheet.absoluteFillObject },
  muteButton: { position: 'absolute', top: 10, right: 10, width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.62)' }, pressed: { opacity: 0.65 },
  embedPrompt: { alignSelf: 'center', marginVertical: 10, padding: 16, borderRadius: 8, backgroundColor: '#111827', alignItems: 'center', justifyContent: 'center', gap: 8 }, embedTitle: { color: '#d1d5db', textAlign: 'center' }, loadButton: { borderRadius: 6, backgroundColor: '#2563eb', paddingHorizontal: 14, paddingVertical: 8 }, loadButtonText: { color: '#fff', fontWeight: '600' },
  failure: { minHeight: 80, marginVertical: 10, padding: 14, borderRadius: 8, backgroundColor: '#111827', alignItems: 'center', justifyContent: 'center', gap: 6 }, failureText: { color: '#d1d5db' }, failureLink: { color: '#60a5fa', textDecorationLine: 'underline' },
});
