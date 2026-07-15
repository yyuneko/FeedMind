import React, { createElement, useMemo, useState } from 'react';
import { Linking, Pressable, Text, View } from 'react-native';
import { t } from '@/i18n';
import { withAutomaticPlayback, type ArticleMediaSource } from '@/utils/articleMedia';

type ArticleMediaProps = { kind: 'video' | 'audio' | 'embed'; uri: string; sources?: ArticleMediaSource[]; poster?: string; width: number; sourceWidth?: number; sourceHeight?: number; trustedEmbed?: boolean; title?: string };
const uniqueSources = (uri: string, sources: ArticleMediaSource[] = []) => Array.from(new Map([uri ? { uri } : null, ...sources].filter((item): item is ArticleMediaSource => Boolean(item?.uri)).map((item) => [item.uri, item])).values());
const mediaHeight = (width: number, sourceWidth?: number, sourceHeight?: number) => Math.max(180, Math.min(width * 1.5, Math.round(width * (sourceWidth && sourceHeight ? sourceHeight / sourceWidth : 9 / 16))));

export function ArticleMedia({ kind, uri, sources, poster, width, sourceWidth, sourceHeight, trustedEmbed = false, title }: ArticleMediaProps) {
  const [loaded, setLoaded] = useState(trustedEmbed); const [failed, setFailed] = useState(false); const items = useMemo(() => uniqueSources(uri, sources), [sources, uri]);
  if (!items.length) return null;
  if (!loaded && kind === 'embed') { let hostname = uri; try { hostname = new URL(uri).hostname; } catch {} return createElement('div', { style: { ...styles.prompt, width } }, createElement('div', { style: styles.promptTitle }, title || hostname), createElement('button', { type: 'button', onClick: () => setLoaded(true), style: styles.button }, t('loadEmbeddedContent'))); }
  if (failed) return <View style={[styles.failure, { width }]}><Text style={styles.failureText}>{t('mediaLoadFailed')}</Text><Pressable accessibilityRole="link" onPress={() => Linking.openURL(uri).catch(() => undefined)}><Text style={styles.failureLink}>{t('openInBrowser')}</Text></Pressable></View>;
  const height = kind === 'audio' ? 58 : mediaHeight(width, sourceWidth, sourceHeight);
  const children = kind === 'embed' ? undefined : items.map((item) => createElement('source', { key: item.uri, src: item.uri, type: item.type }));
  const media = kind === 'video'
    ? createElement('video', { poster, controls: true, autoPlay: true, loop: true, muted: true, playsInline: true, preload: 'auto', onError: () => setFailed(true), style: styles.media }, children)
    : kind === 'audio'
      ? createElement('audio', { controls: true, preload: 'metadata', onError: () => setFailed(true), style: styles.media }, children)
      : createElement('iframe', { src: trustedEmbed ? withAutomaticPlayback(uri) : uri, title: title || 'Embedded article content', allow: trustedEmbed ? 'autoplay; encrypted-media; picture-in-picture' : 'fullscreen; picture-in-picture', allowFullScreen: true, sandbox: 'allow-scripts allow-same-origin allow-forms allow-presentation', referrerPolicy: 'no-referrer', onError: () => setFailed(true), style: styles.media });
  return <View style={[styles.container, { width, height }]}>{media}</View>;
}

const styles: Record<string, any> = { container: { alignSelf: 'center', marginVertical: 10, overflow: 'hidden', borderRadius: 8, backgroundColor: '#000' }, media: { width: '100%', height: '100%', borderWidth: 0, backgroundColor: '#000' }, prompt: { boxSizing: 'border-box', minHeight: 110, margin: '10px auto', padding: 16, borderRadius: 8, backgroundColor: '#111827', color: '#d1d5db', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8 }, promptTitle: { textAlign: 'center' }, button: { border: 0, borderRadius: 6, backgroundColor: '#2563eb', color: '#fff', padding: '8px 14px', cursor: 'pointer' }, failure: { minHeight: 80, marginVertical: 10, padding: 14, borderRadius: 8, backgroundColor: '#111827', alignItems: 'center', justifyContent: 'center', gap: 6 }, failureText: { color: '#d1d5db' }, failureLink: { color: '#60a5fa', textDecorationLine: 'underline' } };
