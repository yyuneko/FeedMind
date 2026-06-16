import * as Clipboard from 'expo-clipboard';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Animated, Linking, Modal, NativeScrollEvent, NativeSyntheticEvent, Pressable, ScrollView, StyleSheet, Text, View, useColorScheme, useWindowDimensions } from 'react-native';
import RenderHtml from 'react-native-render-html';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ActionPill } from '@/components/ActionPill';
import { IconButton } from '@/components/IconButton';
import { QueryState } from '@/components/QueryState';
import { SegmentedTabs } from '@/components/SegmentedTabs';
import { articleRepo, promptRepo, settingsRepo, translationRepo } from '@/db/repositories';
import { fetchArticleContentHtml } from '@/services/rss';
import { scheduleSync } from '@/services/sync';
import { translateArticle } from '@/services/translate';
import { useAppStore } from '@/store/appStore';
import type { Prompt, ReadingMode } from '@/types';
import { splitParagraphs, stripHtml } from '@/utils/html';
import { getReaderColors } from '@/utils/theme';
import { formatArticleDate } from '@/utils/time';
import { screenStyles } from './screenStyles';

const progressKey = (id: string) => `readerProgress:${id}`;
const readingModes: ReadingMode[] = ['original', 'translation', 'bilingual'];

export function ArticleDetailScreen() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const queryClient = useQueryClient();
  const width = useWindowDimensions().width;
  const systemDark = useColorScheme() === 'dark';
  const { readingMode, setReadingMode, fontSize, lineHeightRatio, themeMode } = useAppStore();
  const readerColors = getReaderColors(themeMode, systemDark);
  const contentWidth = width - 32;
  const scrollRef = useRef<ScrollView>(null);
  const pagerRef = useRef<ScrollView>(null);
  const pagerScrollX = useRef(new Animated.Value(readingModes.indexOf(readingMode) * contentWidth)).current;
  const abortRef = useRef<AbortController | null>(null);
  const readMarkedRef = useRef(false);
  const restoredRef = useRef(false);
  const saveAtRef = useRef(0);
  const repairTriedRef = useRef(false);
  const pagerSyncedRef = useRef(false);
  const [previewUri, setPreviewUri] = useState('');
  const [repairingContent, setRepairingContent] = useState(false);
  const [repairFailed, setRepairFailed] = useState(false);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);

  const article = useQuery({
    queryKey: ['article', id],
    queryFn: () => articleRepo.get(id),
  });
  const prompts = useQuery<Prompt[]>({ queryKey: ['prompts'], queryFn: promptRepo.list });
  const defaultPrompt = prompts.data?.find((item: Prompt) => item.isDefault) ?? prompts.data?.[0];
  const translation = useQuery({
    queryKey: ['translation', id, defaultPrompt?.id],
    enabled: Boolean(defaultPrompt?.id),
    queryFn: () => translationRepo.get(id, defaultPrompt!.id),
  });

  const markRead = useCallback(async () => {
    const item = article.data;
    if (!item || item.isRead || readMarkedRef.current) return;
    readMarkedRef.current = true;
    await articleRepo.setRead(id, true);
    scheduleSync();
    queryClient.invalidateQueries({ queryKey: ['article', id] });
    queryClient.invalidateQueries({ queryKey: ['articles'] });
  }, [article.data, id, queryClient]);

  useEffect(() => {
    readMarkedRef.current = Boolean(article.data?.isRead);
    if (!article.data || article.data.isRead) return undefined;
    const timer = setTimeout(() => {
      markRead().catch(() => undefined);
    }, 3000);
    return () => clearTimeout(timer);
  }, [article.data, markRead]);

  useEffect(() => {
    restoredRef.current = false;
    repairTriedRef.current = false;
    setRepairFailed(false);
  }, [id]);

  useEffect(() => {
    if (!article.data || restoredRef.current || !contentHeight || !viewportHeight) return;
    restoredRef.current = true;
    settingsRepo.get(progressKey(id)).then((value) => {
      if (!value) return;
      const next = JSON.parse(value) as { y?: number };
      scrollRef.current?.scrollTo({ y: Math.max(0, next.y ?? 0), animated: false });
    }).catch(() => undefined);
  }, [article.data, contentHeight, id, viewportHeight]);

  const toggleStar = useMutation({
    mutationFn: async () => {
      const item = await articleRepo.get(id);
      if (item) await articleRepo.setStarred(id, !item.isStarred);
    },
    onSuccess: () => {
      scheduleSync();
      queryClient.invalidateQueries({ queryKey: ['article', id] });
      queryClient.invalidateQueries({ queryKey: ['articles'] });
    },
  });
  const translate = useMutation({
    mutationFn: async () => {
      const item = article.data;
      if (!item || !defaultPrompt) throw new Error('请先创建 Prompt');
      abortRef.current = new AbortController();
      try {
        return await translateArticle({
          articleId: item.id,
          title: item.title,
          content: item.contentText,
          promptId: defaultPrompt.id,
          prompt: defaultPrompt.content,
          signal: abortRef.current.signal,
        });
      } finally {
        abortRef.current = null;
      }
    },
    onSuccess: () => {
      setReadingMode('translation');
      queryClient.invalidateQueries({ queryKey: ['translation'] });
    },
    onError: (error) => {
      if (error instanceof Error && error.name === 'AbortError') return;
      Alert.alert('翻译失败', error instanceof Error ? error.message : '请检查配置');
    },
  });
  const item = article.data;
  const translated = translation.data?.content ?? '';
  const hasReadableBody = Boolean(item?.contentText.trim()) && item?.contentText.trim() !== item?.title.trim();
  const lineHeight = Math.round(fontSize * lineHeightRatio);
  const htmlBaseStyle = useMemo(() => ({
    color: readerColors.text,
    fontSize,
    lineHeight,
  }), [fontSize, lineHeight, readerColors.text]);
  const tagsStyles = useMemo(() => ({
    body: { color: readerColors.text, backgroundColor: readerColors.background },
    p: { marginBottom: 16 },
    a: { color: readerColors.blue, textDecorationLine: 'underline' as const },
    blockquote: { borderLeftWidth: 3, borderLeftColor: readerColors.border, paddingLeft: 12, color: readerColors.secondary },
    pre: { backgroundColor: readerColors.page, borderRadius: 8, padding: 12, marginVertical: 12 },
    code: { fontFamily: 'Menlo', backgroundColor: readerColors.page },
    table: { backgroundColor: readerColors.background },
    th: { borderWidth: StyleSheet.hairlineWidth, borderColor: readerColors.border, padding: 8 },
    td: { borderWidth: StyleSheet.hairlineWidth, borderColor: readerColors.border, padding: 8 },
  }), [readerColors]);
  const renderers = useMemo(() => ({
    img: ({ tnode }: any) => (
      <ArticleImage
        uri={String(tnode.attributes.src ?? '')}
        width={contentWidth}
        onPress={setPreviewUri}
      />
    ),
    pre: ({ TDefaultRenderer, ...props }: any) => (
      <ScrollView horizontal showsHorizontalScrollIndicator>
        <View style={{ minWidth: contentWidth }}>
          <TDefaultRenderer {...props} />
        </View>
      </ScrollView>
    ),
    table: ({ TDefaultRenderer, ...props }: any) => (
      <ScrollView horizontal showsHorizontalScrollIndicator>
        <TDefaultRenderer {...props} />
      </ScrollView>
    ),
  }), [contentWidth]);
  const renderersProps = useMemo(() => ({
    a: {
      onPress: (_event: unknown, href: string) => {
        if (href) Linking.openURL(href).catch(() => Alert.alert('链接打开失败', href));
      },
      onLongPress: (_event: unknown, href: string) => {
        if (!href) return;
        Clipboard.setStringAsync(href).then(() => Alert.alert('已复制链接')).catch(() => Alert.alert('复制失败'));
      },
    },
  }), []);
  const source = useMemo(() => ({ html: item?.contentHtml ?? '' }), [item?.contentHtml]);
  const scrollPagerTo = useCallback((mode: ReadingMode, animated = true) => {
    const index = readingModes.indexOf(mode);
    if (!animated) pagerScrollX.setValue(index * contentWidth);
    pagerRef.current?.scrollTo({ x: index * contentWidth, animated });
  }, [contentWidth, pagerScrollX]);
  const changeReadingMode = (mode: ReadingMode) => {
    setReadingMode(mode);
    scrollPagerTo(mode);
  };
  const onPagerMomentumEnd = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const index = Math.round(event.nativeEvent.contentOffset.x / contentWidth);
    const next = readingModes[index];
    if (next && next !== readingMode) setReadingMode(next);
  };

  useEffect(() => {
    scrollPagerTo(readingMode, pagerSyncedRef.current);
    pagerSyncedRef.current = true;
  }, [readingMode, scrollPagerTo]);

  useEffect(() => {
    if (!item || hasReadableBody || repairTriedRef.current) return;
    repairTriedRef.current = true;
    setRepairFailed(false);
    setRepairingContent(true);
    if (!item.url) {
      setRepairingContent(false);
      setRepairFailed(true);
      return;
    }
    fetchArticleContentHtml(item.url)
      .then(async (html) => {
        const text = stripHtml(html);
        if (!text || text.trim() === item.title.trim()) throw new Error('正文为空');
        await articleRepo.updateContent(item.id, html, text);
        await queryClient.invalidateQueries({ queryKey: ['article', id] });
        await queryClient.invalidateQueries({ queryKey: ['articles'] });
      })
      .catch(() => setRepairFailed(true))
      .finally(() => setRepairingContent(false));
  }, [hasReadableBody, id, item, queryClient]);

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement, contentSize } = event.nativeEvent;
    const maxY = Math.max(1, contentSize.height - layoutMeasurement.height);
    const ratio = contentOffset.y / maxY;
    if (ratio >= 0.3) markRead().catch(() => undefined);
    const now = Date.now();
    if (now - saveAtRef.current < 1000) return;
    saveAtRef.current = now;
    settingsRepo.set(progressKey(id), JSON.stringify({ y: contentOffset.y, ratio })).catch(() => undefined);
  };

  const cancelTranslate = () => {
    abortRef.current?.abort();
    translate.reset();
  };

  if (article.isLoading) {
    return <SafeAreaView style={[screenStyles.safe, { backgroundColor: readerColors.background }]}><QueryState title="正在加载文章" textColor={readerColors.text} secondaryColor={readerColors.secondary} /></SafeAreaView>;
  }

  if (article.isError) {
    return <SafeAreaView style={[screenStyles.safe, { backgroundColor: readerColors.background }]}><QueryState title="文章加载失败" message={article.error instanceof Error ? article.error.message : '请稍后重试'} actionLabel="重试" onAction={() => article.refetch()} textColor={readerColors.text} secondaryColor={readerColors.secondary} /></SafeAreaView>;
  }

  if (!item) {
    return <SafeAreaView style={[screenStyles.safe, { backgroundColor: readerColors.background }]}><QueryState title="文章不存在" message="这篇文章可能已被删除。" actionLabel="返回" onAction={() => router.back()} textColor={readerColors.text} secondaryColor={readerColors.secondary} /></SafeAreaView>;
  }

  return (
    <SafeAreaView style={[screenStyles.safe, { backgroundColor: readerColors.background }]}>
      <View style={[screenStyles.header, { paddingHorizontal: 16 }]}>
        <IconButton name="chevron-back" onPress={() => router.back()} />
        <View style={{ flex: 1 }} />
        <IconButton name={item.isStarred ? 'star' : 'star-outline'} onPress={() => toggleStar.mutate()} />
      </View>
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={styles.scroll}
        onLayout={(event) => setViewportHeight(event.nativeEvent.layout.height)}
        onContentSizeChange={(_width, height) => setContentHeight(height)}
        onScroll={onScroll}
        scrollEventThrottle={250}
      >
        <Text style={[styles.title, { color: readerColors.text }]}>{item.title}</Text>
        <Text style={[styles.meta, { color: readerColors.secondary }]}>
          {item.feedTitle || 'Feed'} · {formatArticleDate(item.publishedAt || item.createdAt)}
        </Text>
        <SegmentedTabs<ReadingMode>
          value={readingMode}
          onChange={changeReadingMode}
          indicatorScrollX={pagerScrollX}
          indicatorPageWidth={contentWidth}
          items={[
            { label: 'Original', value: 'original' },
            { label: 'Translation', value: 'translation' },
            { label: 'Bilingual', value: 'bilingual' },
          ]}
        />
        <View style={styles.articleBody}>
          <Animated.ScrollView
            ref={pagerRef}
            horizontal
            pagingEnabled
            directionalLockEnabled
            showsHorizontalScrollIndicator={false}
            onScroll={Animated.event(
              [{ nativeEvent: { contentOffset: { x: pagerScrollX } } }],
              { useNativeDriver: false },
            )}
            scrollEventThrottle={16}
            onMomentumScrollEnd={onPagerMomentumEnd}
          >
            <View style={{ width: contentWidth }}>
              {hasReadableBody ? (
                <RenderHtml
                  contentWidth={contentWidth}
                  source={source}
                  baseStyle={htmlBaseStyle}
                  tagsStyles={tagsStyles}
                  renderers={renderers}
                  renderersProps={renderersProps}
                />
              ) : (
                <QueryState
                  title={repairingContent ? '正在刷新正文' : repairFailed ? '正文刷新失败' : '正文暂不可用'}
                  message="RSS 未提供正文，正在尝试从原文链接读取。"
                  actionLabel="重试"
                  onAction={() => {
                    repairTriedRef.current = false;
                    setRepairFailed(false);
                    article.refetch();
                  }}
                  textColor={readerColors.text}
                  secondaryColor={readerColors.secondary}
                />
              )}
            </View>
            <View style={{ width: contentWidth }}>
              <TranslationContent
                content={translated || (translate.isPending ? '正在翻译...' : '点击底部 Translate 生成译文。')}
                fontSize={fontSize}
                lineHeight={lineHeight}
                textColor={readerColors.text}
              />
            </View>
            <View style={{ width: contentWidth }}>
              <Bilingual
                original={item.contentText}
                translation={translated}
                fontSize={fontSize}
                lineHeight={lineHeight}
                colors={readerColors}
              />
            </View>
          </Animated.ScrollView>
          {translate.isPending && (
            <View style={styles.translateState}>
              <ActivityIndicator color={readerColors.blue} />
              <Text style={[styles.translateText, { color: readerColors.secondary }]}>正在翻译</Text>
            </View>
          )}
          {translate.isError && !(translate.error instanceof Error && translate.error.name === 'AbortError') && (
            <QueryState title="翻译失败" message={translate.error instanceof Error ? translate.error.message : '请稍后重试'} actionLabel="重试" onAction={() => translate.mutate()} textColor={readerColors.text} secondaryColor={readerColors.secondary} />
          )}
        </View>
      </ScrollView>
      <View style={styles.actions}>
        {translate.isPending ? (
          <ActionPill icon="close-circle-outline" label="Cancel" onPress={cancelTranslate} />
        ) : (
          <ActionPill icon="language-outline" label={translate.isError ? 'Retry' : 'Translate'} onPress={() => translate.mutate()} />
        )}
        <ActionPill icon="sparkles-outline" label="Explain" onPress={() => Alert.alert('MVP 暂未实现', '第一版只实现 AI 翻译。')} />
        <ActionPill icon="checkbox-outline" label="Prompt" onPress={() => router.push('/prompts')} />
      </View>
      <Modal visible={Boolean(previewUri)} transparent onRequestClose={() => setPreviewUri('')}>
        <Pressable style={styles.preview} onPress={() => setPreviewUri('')}>
          <Image source={{ uri: previewUri }} style={styles.previewImage} contentFit="contain" />
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const ArticleImage = ({ uri, width, onPress }: { uri: string; width: number; onPress: (uri: string) => void }) => {
  const [hidden, setHidden] = useState(false);
  if (!uri || hidden) return null;
  return (
    <Pressable onPress={() => onPress(uri)}>
      <Image
        source={{ uri }}
        style={{ width, height: Math.round(width * 0.56), marginVertical: 12, borderRadius: 8 }}
        contentFit="contain"
        transition={150}
        onError={() => setHidden(true)}
      />
    </Pressable>
  );
};

const TranslationContent = ({ content, fontSize, lineHeight, textColor }: { content: string; fontSize: number; lineHeight: number; textColor: string }) => (
  <View>
    {splitParagraphs(content).map((item, index) => (
      <Text key={`${index}-${item}`} style={[styles.translated, { color: textColor, fontSize, lineHeight }]}>{item}</Text>
    ))}
  </View>
);

const Bilingual = ({ original, translation, fontSize, lineHeight, colors }: { original: string; translation: string; fontSize: number; lineHeight: number; colors: ReturnType<typeof getReaderColors> }) => {
  const originalParts = splitParagraphs(original);
  const translatedParts = splitParagraphs(translation);
  return (
    <View>
      {originalParts.slice(0, Math.max(originalParts.length, translatedParts.length)).map((item, index) => (
        <View key={`${index}-${item}`} style={[styles.bilingualCard, { backgroundColor: colors.page }]}>
          {!!item && <Text style={[styles.bilingualOriginal, { color: colors.secondary }]}>{item}</Text>}
          {!!translatedParts[index] && <Text style={[styles.bilingualTranslation, { color: colors.text, fontSize, lineHeight }]}>{translatedParts[index]}</Text>}
        </View>
      ))}
    </View>
  );
};

const styles = StyleSheet.create({
  scroll: {
    paddingHorizontal: 16,
    paddingBottom: 88,
  },
  title: {
    fontSize: 24,
    lineHeight: 32,
    fontWeight: '800',
  },
  meta: {
    fontSize: 13,
    marginTop: 12,
    marginBottom: 22,
  },
  articleBody: {
    paddingTop: 24,
  },
  translated: {
    marginBottom: 24,
  },
  bilingualCard: {
    borderRadius: 8,
    padding: 14,
    marginBottom: 12,
  },
  bilingualOriginal: {
    fontSize: 13,
    lineHeight: 20,
    marginBottom: 8,
  },
  bilingualTranslation: {},
  translateState: {
    marginTop: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  translateText: {
    marginLeft: 8,
    fontSize: 13,
  },
  actions: {
    position: 'absolute',
    left: 18,
    right: 18,
    bottom: 18,
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
  },
  preview: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.92)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewImage: {
    width: '100%',
    height: '100%',
  },
});
