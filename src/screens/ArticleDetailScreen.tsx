import * as Clipboard from 'expo-clipboard';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, LayoutAnimation, Linking, Modal, NativeScrollEvent, NativeSyntheticEvent, Platform, Pressable, ScrollView, StyleSheet, Text, UIManager, View, useColorScheme, useWindowDimensions } from 'react-native';
import RenderHtml from 'react-native-render-html';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ActionPill } from '@/components/ActionPill';
import { IconButton } from '@/components/IconButton';
import { QueryState } from '@/components/QueryState';
import { articleRepo, promptRepo, settingsRepo, translationRepo } from '@/db/repositories';
import { t } from '@/i18n';
import { fetchArticleContentHtml } from '@/services/rss';
import { scheduleSync } from '@/services/sync';
import { translateArticle } from '@/services/translate';
import { useAppStore } from '@/store/appStore';
import type { Prompt, ReadingMode } from '@/types';
import { htmlBlocksToText, htmlToBlocks, isTranslationAligned, normalizeParagraphs, parseTranslationContent, splitParagraphs, stripHtml } from '@/utils/html';
import { colors, getReaderColors } from '@/utils/theme';
import { formatArticleDate } from '@/utils/time';
import { screenStyles } from './screenStyles';

const progressKey = (id: string) => `readerProgress:${id}`;
const readingModes: ReadingMode[] = ['original', 'translation', 'bilingual'];
const readingModeTextKeys: Record<ReadingMode, 'original' | 'translation' | 'bilingual'> = {
  original: 'original',
  translation: 'translation',
  bilingual: 'bilingual',
};
const readingModeIcons = {
  original: 'document-text-outline',
  translation: 'language-outline',
  bilingual: 'documents-outline',
} as const;
const configureTransition = () => {
  LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
};

export function ArticleDetailScreen() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const queryClient = useQueryClient();
  const width = useWindowDimensions().width;
  const systemDark = useColorScheme() === 'dark';
  const { readingMode, setReadingMode, fontSize, lineHeightRatio, themeMode, selectedPromptId } = useAppStore();
  const readerColors = getReaderColors(themeMode, systemDark);
  const contentWidth = width - 32;
  const scrollRef = useRef<ScrollView>(null);
  const abortRef = useRef<AbortController | null>(null);
  const autoTranslateKeyRef = useRef('');
  const readMarkedRef = useRef(false);
  const restoredRef = useRef(false);
  const saveAtRef = useRef(0);
  const repairTriedRef = useRef(false);
  const titleTapAtRef = useRef(0);
  const headerCollapsedRef = useRef(false);
  const [previewUri, setPreviewUri] = useState('');
  const [repairingContent, setRepairingContent] = useState(false);
  const [repairFailed, setRepairFailed] = useState(false);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  const [titleHeight, setTitleHeight] = useState(0);
  const [isHeaderCollapsed, setIsHeaderCollapsed] = useState(false);
  const [menuVisible, setMenuVisible] = useState(false);

  const updateHeaderCollapsed = useCallback((collapsed: boolean) => {
    if (headerCollapsedRef.current === collapsed) return;
    headerCollapsedRef.current = collapsed;
    configureTransition();
    setIsHeaderCollapsed(collapsed);
  }, []);

  useEffect(() => {
    if (Platform.OS === 'android') UIManager.setLayoutAnimationEnabledExperimental?.(true);
  }, []);

  const article = useQuery({
    queryKey: ['article', id],
    queryFn: () => articleRepo.get(id),
  });
  const prompts = useQuery<Prompt[]>({ queryKey: ['prompts'], queryFn: promptRepo.list });
  const selectedPrompt = prompts.data?.find((item: Prompt) => item.id === selectedPromptId);
  const defaultPrompt = selectedPrompt ?? prompts.data?.find((item: Prompt) => item.isDefault) ?? prompts.data?.[0];
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
    autoTranslateKeyRef.current = '';
    headerCollapsedRef.current = false;
    setIsHeaderCollapsed(false);
    setMenuVisible(false);
    setRepairFailed(false);
  }, [id]);

  useEffect(() => {
    if (!article.data || restoredRef.current || !contentHeight || !viewportHeight || !titleHeight) return;
    restoredRef.current = true;
    settingsRepo.get(progressKey(id)).then((value) => {
      if (!value) return;
      const next = JSON.parse(value) as { y?: number };
      const y = Math.max(0, next.y ?? 0);
      updateHeaderCollapsed(y >= titleHeight);
      scrollRef.current?.scrollTo({ y, animated: false });
    }).catch(() => undefined);
  }, [article.data, contentHeight, id, titleHeight, updateHeaderCollapsed, viewportHeight]);

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
      if (!item || !defaultPrompt) throw new Error(t('promptRequired'));
      abortRef.current = new AbortController();
      try {
        return await translateArticle({
          articleId: item.id,
          title: item.title,
          content: translationSource.join('\n\n'),
          promptId: defaultPrompt.id,
          prompt: defaultPrompt.content,
          signal: abortRef.current.signal,
        });
      } finally {
        abortRef.current = null;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['translation'] });
    },
    onError: (error) => {
      if (error instanceof Error && error.name === 'AbortError') return;
      Alert.alert(t('translateFailed'), error instanceof Error ? error.message : t('checkConfig'));
    },
  });
  const item = article.data;
  const translated = translation.data?.content ?? '';
  const originalBlocks = useMemo(() => (item ? htmlToBlocks(item.contentHtml) : []), [item]);
  const translationSource = useMemo(() => (item ? htmlBlocksToText(item.contentHtml) : []), [item]);
  const parsedTranslation = useMemo(() => parseTranslationContent(translated), [translated]);
  const translatedTitle = parsedTranslation.title.trim();
  const articleTitle = readingMode === 'original' ? item?.title ?? '' : translatedTitle || (item?.title ?? '');
  const translationAligned = !parsedTranslation.original.length || isTranslationAligned(translationSource, parsedTranslation.original);
  const isTranslationLoading = readingMode !== 'original' && (translation.isFetching || translate.isPending);
  const translationParts = useMemo(
    () => (translationAligned ? normalizeParagraphs(parsedTranslation.translate, translationSource.length) : []),
    [parsedTranslation.translate, translationAligned, translationSource.length],
  );
  const hasReadableBody = Boolean(item?.contentText.trim()) && item?.contentText.trim() !== item?.title.trim();
  const lineHeight = Math.round(fontSize * lineHeightRatio);
  const htmlBaseStyle = useMemo(() => ({
    color: readerColors.text,
    fontSize,
    lineHeight,
  }), [fontSize, lineHeight, readerColors.text]);
  const tagsStyles = useMemo(() => ({
    body: { color: readerColors.text, backgroundColor: readerColors.background },
    p: { marginBottom: 16, textIndent: `${fontSize * 2}px` },
    a: { color: readerColors.blue, textDecorationLine: 'underline' as const },
    mark: { backgroundColor: '#FFF2A8', color: readerColors.text },
    blockquote: { borderLeftWidth: 3, borderLeftColor: readerColors.border, paddingLeft: 12, color: readerColors.secondary },
    pre: { backgroundColor: readerColors.page, borderRadius: 8, padding: 12, marginVertical: 12 },
    code: { fontFamily: 'Menlo', backgroundColor: readerColors.page },
    table: { backgroundColor: readerColors.background },
    th: { borderWidth: StyleSheet.hairlineWidth, borderColor: readerColors.border, padding: 8 },
    td: { borderWidth: StyleSheet.hairlineWidth, borderColor: readerColors.border, padding: 8 },
  }), [fontSize, readerColors]);
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
        if (href) Linking.openURL(href).catch(() => Alert.alert(t('linkOpenFailed'), href));
      },
      onLongPress: (_event: unknown, href: string) => {
        if (!href) return;
        Clipboard.setStringAsync(href).then(() => Alert.alert(t('copiedLink'))).catch(() => Alert.alert(t('copyFailed')));
      },
    },
  }), []);
  const source = useMemo(() => ({ html: item?.contentHtml ?? '' }), [item?.contentHtml]);
  const changeReadingMode = () => {
    const next = readingModes[(readingModes.indexOf(readingMode) + 1) % readingModes.length];
    autoTranslateKeyRef.current = '';
    setReadingMode(next);
  };

  useEffect(() => {
    if (!isHeaderCollapsed && menuVisible) {
      configureTransition();
      setMenuVisible(false);
    }
  }, [isHeaderCollapsed, menuVisible]);

  useEffect(() => {
    if (readingMode === 'original' || translation.isFetching || (translated && translationAligned) || translate.isPending || !item || !defaultPrompt) return;
    const key = `${id}:${defaultPrompt.id}:${readingMode}:${translated && !translationAligned ? 'mismatch' : translate.isError ? 'retry' : 'empty'}`;
    if (autoTranslateKeyRef.current === key) return;
    autoTranslateKeyRef.current = key;
    translate.mutate();
  }, [defaultPrompt, id, item, readingMode, translate, translated, translation.isFetching, translationAligned]);

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
        if (!text || text.trim() === item.title.trim()) throw new Error(t('noText'));
        await articleRepo.updateContent(item.id, html, text);
        await queryClient.invalidateQueries({ queryKey: ['article', id] });
        await queryClient.invalidateQueries({ queryKey: ['articles'] });
      })
      .catch(() => setRepairFailed(true))
      .finally(() => setRepairingContent(false));
  }, [hasReadableBody, id, item, queryClient]);

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement, contentSize } = event.nativeEvent;
    updateHeaderCollapsed(titleHeight > 0 && contentOffset.y >= titleHeight);
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
  const openOriginal = () => {
    if (!item?.url) return;
    Linking.openURL(item.url).catch(() => Alert.alert(t('linkOpenFailed'), item.url!));
  };
  const copyOriginalUrl = () => {
    if (!item?.url) return;
    Clipboard.setStringAsync(item.url).then(() => Alert.alert(t('copiedLink'))).catch(() => Alert.alert(t('copyFailed')));
  };
  const runMenuAction = (action: () => void) => {
    configureTransition();
    setMenuVisible(false);
    action();
  };
  const toggleMenu = () => {
    configureTransition();
    setMenuVisible((visible) => !visible);
  };
  const closeMenu = () => {
    configureTransition();
    setMenuVisible(false);
  };
  const handlePinnedTitlePress = () => {
    const now = Date.now();
    if (now - titleTapAtRef.current < 300) {
      scrollRef.current?.scrollTo({ y: 0, animated: true });
      titleTapAtRef.current = 0;
      updateHeaderCollapsed(false);
      return;
    }
    titleTapAtRef.current = now;
  };

  if (article.isLoading) {
    return <SafeAreaView style={[screenStyles.safe, { backgroundColor: readerColors.background }]}><QueryState title={t('articlesLoading')} textColor={readerColors.text} secondaryColor={readerColors.secondary} /></SafeAreaView>;
  }

  if (article.isError) {
    return <SafeAreaView style={[screenStyles.safe, { backgroundColor: readerColors.background }]}><QueryState title={t('articleLoadFailed')} message={article.error instanceof Error ? article.error.message : t('soonRetry')} actionLabel={t('retry')} onAction={() => article.refetch()} textColor={readerColors.text} secondaryColor={readerColors.secondary} /></SafeAreaView>;
  }

  if (!item) {
    return <SafeAreaView style={[screenStyles.safe, { backgroundColor: readerColors.background }]}><QueryState title={t('articleMissing')} message={t('articleNotFoundMessage')} actionLabel={t('back')} onAction={() => router.back()} textColor={readerColors.text} secondaryColor={readerColors.secondary} /></SafeAreaView>;
  }

  return (
    <SafeAreaView style={[screenStyles.safe, { backgroundColor: readerColors.background }]}>
      <View style={[screenStyles.header, { paddingHorizontal: 16 }]}>
        <IconButton name="chevron-back" onPress={() => router.back()} />
        <View style={{ flex: 1 }} />
        {isHeaderCollapsed && (
          <Pressable style={({ pressed }) => [styles.pinnedTitle, pressed && styles.pressed]} onPress={handlePinnedTitlePress}>
            <Text numberOfLines={1} style={[styles.pinnedTitleText, { color: readerColors.text }]}>{articleTitle}</Text>
          </Pressable>
        )}
        {isHeaderCollapsed ? (
          <IconButton name="ellipsis-horizontal" onPress={toggleMenu} />
        ) : (
          <View style={styles.headerActions}>
            <IconButton name={item.isStarred ? 'star' : 'star-outline'} onPress={() => toggleStar.mutate()} />
            {!!item.url && (
              <Pressable style={({ pressed }) => [styles.openOriginalButton, pressed && styles.pressed]} onPress={openOriginal} hitSlop={8}>
                <Ionicons name="earth" size={18} color={readerColors.text} />
              </Pressable>
            )}
          </View>
        )}
      </View>
      {menuVisible && (
        <>
          <Pressable style={styles.menuBackdrop} onPress={closeMenu} />
          <View style={[styles.dropdownMenu, { backgroundColor: readerColors.background, borderColor: readerColors.border }]}>
            {!!item.url && (
              <>
                <MenuItem icon="open-outline" label={t('openOriginal')} color={readerColors.text} onPress={() => runMenuAction(openOriginal)} />
                <MenuItem icon="copy-outline" label={t('copyLink')} color={readerColors.text} onPress={() => runMenuAction(copyOriginalUrl)} />
              </>
            )}
            <MenuItem
              icon={item.isStarred ? 'star' : 'star-outline'}
              label={item.isStarred ? t('saved') : t('collect')}
              color={readerColors.text}
              onPress={() => runMenuAction(() => toggleStar.mutate())}
            />
            <MenuItem
              icon={readingModeIcons[readingMode]}
              label={t(readingModeTextKeys[readingMode])}
              color={readerColors.text}
              onPress={() => runMenuAction(changeReadingMode)}
            />
          </View>
        </>
      )}
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={styles.scroll}
        onLayout={(event) => setViewportHeight(event.nativeEvent.layout.height)}
        onContentSizeChange={(_width, height) => setContentHeight(height)}
        onScroll={onScroll}
        scrollEventThrottle={16}
      >
        <View style={styles.titleRow} onLayout={(event) => setTitleHeight(event.nativeEvent.layout.height)}>
          <View style={styles.dot} />
          <Text style={[styles.title, { color: readerColors.text }]}>{articleTitle}</Text>
          {!isHeaderCollapsed && (
            <Pressable style={({ pressed }) => [styles.modeButton, { borderColor: readerColors.border }, pressed && styles.pressed]} onPress={changeReadingMode}>
              <Ionicons name="swap-horizontal-outline" size={14} color={readerColors.text} />
              <Ionicons name={readingModeIcons[readingMode]} size={20} color={readerColors.text} />
            </Pressable>
          )}
        </View>
        <Text style={[styles.meta, { color: readerColors.secondary }]}>
          {item.feedTitle || 'Feed'} · {formatArticleDate(item.publishedAt || item.createdAt)}
        </Text>
        <View style={styles.articleBody}>
          {readingMode === 'original' && (
            hasReadableBody ? (
              <RenderHtml
                contentWidth={contentWidth}
                source={source}
                baseStyle={htmlBaseStyle}
                defaultTextProps={{ selectable: true }}
                tagsStyles={tagsStyles}
                renderers={renderers}
                renderersProps={renderersProps}
              />
            ) : (
              <QueryState
                title={repairingContent ? t('repairBodyLoading') : repairFailed ? t('repairBodyFailed') : t('noText')}
                message={t('repairBodyMessage')}
                actionLabel={t('retry')}
                onAction={() => {
                  repairTriedRef.current = false;
                  setRepairFailed(false);
                  article.refetch();
                }}
                textColor={readerColors.text}
                secondaryColor={readerColors.secondary}
              />
            )
          )}
          {readingMode === 'translation' && (
            <TranslationContent
              content={translationParts.length ? translationParts : splitParagraphs(isTranslationLoading ? t('translationLoadingDots') : t('noAlignedTranslation'))}
              fontSize={fontSize}
              lineHeight={lineHeight}
              textColor={readerColors.text}
            />
          )}
          {readingMode === 'bilingual' && (
            <Bilingual
              originalBlocks={originalBlocks}
              translationParts={translationParts}
              isTranslationLoading={isTranslationLoading}
              fontSize={fontSize}
              lineHeight={lineHeight}
              colors={readerColors}
              contentWidth={contentWidth}
              htmlBaseStyle={htmlBaseStyle}
              tagsStyles={tagsStyles}
              renderers={renderers}
              renderersProps={renderersProps}
              loadingText={t('translationLoadingDots')}
            />
          )}
          {isTranslationLoading && (
            <View style={styles.translateState}>
              <ActivityIndicator color={readerColors.blue} />
              <Text style={[styles.translateText, { color: readerColors.secondary }]}>{t('translationLoading')}</Text>
            </View>
          )}
          {translate.isError && !(translate.error instanceof Error && translate.error.name === 'AbortError') && (
            <QueryState title={t('translateFailed')} message={translate.error instanceof Error ? translate.error.message : t('soonRetry')} actionLabel={t('retry')} onAction={() => translate.mutate()} textColor={readerColors.text} secondaryColor={readerColors.secondary} />
          )}
        </View>
      </ScrollView>
      <View style={[styles.actions, { backgroundColor: readerColors.background }]}>
        {translate.isPending ? (
          <ActionPill icon="close-circle-outline" label={t('cancel')} onPress={cancelTranslate} />
        ) : (
          <ActionPill icon="language-outline" label={t('translate')} onPress={() => translate.mutate()} />
        )}
        <ActionPill icon="sparkles-outline" label={t('explain')} onPress={() => Alert.alert(t('mvpTitle'), t('mvpTranslateOnly'))} />
        <ActionPill icon="checkbox-outline" label={t('prompt')} onPress={() => router.push({ pathname: '/prompts', params: { mode: 'select' } })} />
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

const MenuItem = ({ icon, label, color, onPress }: { icon: keyof typeof Ionicons.glyphMap; label: string; color: string; onPress: () => void }) => (
  <Pressable style={({ pressed }) => [styles.menuItem, pressed && styles.pressed]} onPress={onPress}>
    <Ionicons name={icon} size={18} color={color} />
    <Text style={[styles.menuItemText, { color }]}>{label}</Text>
  </Pressable>
);

const TranslationContent = ({ content, fontSize, lineHeight, textColor }: { content: string[]; fontSize: number; lineHeight: number; textColor: string }) => (
  <View>
    {content.map((item, index) => (
      <Text key={`${index}-${item}`} selectable style={[styles.translated, { color: textColor, fontSize, lineHeight, textIndent: `${fontSize * 2}px` }]}>{item}</Text>
    ))}
  </View>
);

const Bilingual = ({
  originalBlocks,
  translationParts,
  isTranslationLoading,
  fontSize,
  lineHeight,
  colors,
  contentWidth,
  htmlBaseStyle,
  tagsStyles,
  renderers,
  renderersProps,
  loadingText,
}: {
  originalBlocks: string[];
  translationParts: string[];
  isTranslationLoading: boolean;
  fontSize: number;
  lineHeight: number;
  colors: ReturnType<typeof getReaderColors>;
  contentWidth: number;
  htmlBaseStyle: Record<string, string | number>;
  tagsStyles: Record<string, any>;
  renderers: Record<string, any>;
  renderersProps: Record<string, any>;
  loadingText: string;
}) => {
  let translationIndex = 0;
  const originalFontSize = Math.max(12, fontSize - 2);
  const originalLineHeight = Math.round((lineHeight / fontSize) * originalFontSize);
  const originalTagsStyles = {
    ...tagsStyles,
    body: { ...tagsStyles.body, backgroundColor: colors.page },
    p: { ...tagsStyles.p, textIndent: `${originalFontSize * 2}px` },
  };
  return (
    <View>
      {originalBlocks.map((item, index) => {
        const hasText = Boolean(stripHtml(item));
        const translation = hasText ? translationParts[translationIndex++] : '';
        return (
          <View key={`${index}-${item}`} style={styles.bilingualBlock}>
            <View style={[styles.bilingualOriginal, { backgroundColor: colors.page }]}>
              <RenderHtml
                contentWidth={contentWidth}
                source={{ html: item }}
                baseStyle={{ ...htmlBaseStyle, color: colors.secondary, fontSize: originalFontSize, lineHeight: originalLineHeight }}
                defaultTextProps={{ selectable: true }}
                tagsStyles={originalTagsStyles}
                renderers={renderers}
                renderersProps={renderersProps}
              />
            </View>
            {!!translation && <Text selectable style={[styles.bilingualTranslation, { color: colors.text, fontSize, lineHeight, textIndent: `${fontSize * 2}px` }]}>{translation}</Text>}
            {!translation && hasText && isTranslationLoading && <Text style={[styles.bilingualTranslation, { color: colors.secondary, fontSize, lineHeight, textIndent: `${fontSize * 2}px` }]}>{loadingText}</Text>}
          </View>
        );
      })}
    </View>
  );
};

const styles = StyleSheet.create({
  scroll: {
    paddingHorizontal: 22,
    paddingBottom: 88,
  },
  menuBackdrop: {
    position: 'absolute',
    top: 62,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 10,
  },
  dropdownMenu: {
    position: 'absolute',
    top: 54,
    right: 16,
    minWidth: 148,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingVertical: 6,
    zIndex: 11,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.12,
    shadowRadius: 14,
    elevation: 8,
  },
  menuItem: {
    height: 40,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
  },
  menuItemText: {
    marginLeft: 10,
    fontSize: 14,
    fontWeight: '700',
  },
  pressed: {
    opacity: 0.55,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: colors.blue,
    marginTop: 8,
    marginRight: 12,
  },
  title: {
    flex: 1,
    fontSize: 16,
    lineHeight: 22,
    fontWeight: '800',
  },
  pinnedTitle: {
    position: 'absolute',
    left: 64,
    right: 64,
    top: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pinnedTitleText: {
    fontSize: 16,
    lineHeight: 22,
    fontWeight: '800',
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  openOriginalButton: {
    height: 34,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
  },
  openOriginalText: {
    marginLeft: 4,
    fontSize: 13,
    fontWeight: '700',
  },
  meta: {
    fontSize: 12,
    marginTop: 12,
    marginBottom: 28,
    paddingLeft: 19,
  },
  articleBody: {
    paddingTop: 2,
  },
  modeButton: {
    height: 32,
    minWidth: 50,
    paddingHorizontal: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 8,
  },
  translated: {
    marginBottom: 24,
  },
  bilingualBlock: {
    marginBottom: 24,
  },
  bilingualOriginal: {
    marginBottom: 8,
    padding: 10,
    borderRadius: 8,
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
    bottom: 0,
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
