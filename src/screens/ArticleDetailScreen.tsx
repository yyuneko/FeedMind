import * as Clipboard from 'expo-clipboard';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, LayoutAnimation, Linking, NativeScrollEvent, NativeSyntheticEvent, PanResponder, Platform, Pressable, ScrollView, StyleSheet, Text, UIManager, View, useColorScheme, useWindowDimensions } from 'react-native';
import ImageView from '@/components/ImageViewer';
import RenderHtml, { type MixedStyleDeclaration } from 'react-native-render-html';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ActionPill } from '@/components/ActionPill';
import { IconButton } from '@/components/IconButton';
import { QueryState } from '@/components/QueryState';
import { articleRepo, promptRepo } from '@/api/repositories';
import { settingsRepo, translationRepo } from '@/db/repositories';
import { t } from '@/i18n';
import { translateArticle } from '@/services/translate';
import { useAppStore } from '@/store/appStore';
import type { Prompt, ReadingMode } from '@/types';
import { sanitizeArticleHtml, stripHtml } from '@/utils/html';
import { applyTranslationPlan, createTranslationPlan, hashText, isStoredTranslationValid, parseStoredTranslation, removeImagesFromHtml, splitTopLevelHtml } from '@/utils/translationHtml';
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
const readingModeShortTextKeys = {
  original: 'originalShort',
  translation: 'translationShort',
  bilingual: 'bilingualShort',
} as const;
const floatingModeButtonSize = 56;
const floatingModeButtonMargin = 18;
const isFootnoteHref = (href: string) => /#(?:fn|footnote|endnote|note|cite(?:_note)?)[-_:]?\d+$/i.test(href);
const configureTransition = () => {
  LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
};

export function ArticleDetailScreen() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const queryClient = useQueryClient();
  const { width, height } = useWindowDimensions();
  const systemDark = useColorScheme() === 'dark';
  const { readingMode, setReadingMode, fontSize, lineHeightRatio, themeMode, selectedPromptId } = useAppStore();
  const readerColors = getReaderColors(themeMode, systemDark);
  const contentWidth = width - 44;
  const scrollRef = useRef<ScrollView>(null);
  const abortRef = useRef<AbortController | null>(null);
  const autoTranslateKeyRef = useRef('');
  const readMarkedRef = useRef(false);
  const restoredRef = useRef(false);
  const saveAtRef = useRef(0);
  const repairTriedRef = useRef(false);
  const titleTapAtRef = useRef(0);
  const headerCollapsedRef = useRef(false);
  const defaultFloatingPosition = useCallback(() => ({
    x: Math.max(floatingModeButtonMargin, width - floatingModeButtonSize - floatingModeButtonMargin),
    y: Math.max(92, height - floatingModeButtonSize - 92),
  }), [height, width]);
  const [floatingPosition, setFloatingPosition] = useState(defaultFloatingPosition);
  const floatingPositionRef = useRef(floatingPosition);
  const floatingDragStartRef = useRef(floatingPosition);
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
    setReadingMode('original');
    setIsHeaderCollapsed(false);
    setMenuVisible(false);
    setRepairFailed(false);
  }, [id, setReadingMode]);

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
          blocks: translationPlan.blocks,
          sourceHash: translationPlan.sourceHash,
          sourceHtml: translationPlan.sourceHtml,
          promptId: defaultPrompt.id,
          prompt: defaultPrompt.content,
          promptHash: hashText(defaultPrompt.content),
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
  const normalizedContentHtml = useMemo(
    () => sanitizeArticleHtml(item?.contentHtml ?? '', item?.url ?? undefined),
    [item?.contentHtml, item?.url],
  );
  const translationPlan = useMemo(() => createTranslationPlan(normalizedContentHtml), [normalizedContentHtml]);
  const promptHash = useMemo(() => hashText(defaultPrompt?.content ?? ''), [defaultPrompt?.content]);
  const storedTranslation = useMemo(() => {
    const parsed = parseStoredTranslation(translated);
    return parsed && isStoredTranslationValid(parsed, { sourceHash: translationPlan.sourceHash, promptHash }) ? parsed : null;
  }, [promptHash, translated, translationPlan.sourceHash]);
  const translatedHtml = useMemo(() => {
    if (!storedTranslation) return '';
    try { return applyTranslationPlan(translationPlan, storedTranslation.blocks); } catch { return ''; }
  }, [storedTranslation, translationPlan]);
  const originalBlocks = useMemo(() => splitTopLevelHtml(translationPlan.sourceHtml), [translationPlan.sourceHtml]);
  const translatedBlocks = useMemo(() => translatedHtml ? splitTopLevelHtml(translatedHtml).map(removeImagesFromHtml) : [], [translatedHtml]);
  const translatedTitle = storedTranslation?.title.trim() ?? '';
  const articleTitle = readingMode === 'original' ? item?.title ?? '' : translatedTitle || (item?.title ?? '');
  const translationAligned = Boolean(storedTranslation && translatedHtml);
  const isTranslationLoading = readingMode !== 'original' && (translation.isFetching || translate.isPending);
  const hasReadableBody = Boolean(item?.contentText.trim()) && item?.contentText.trim() !== item?.title.trim();
  const lineHeight = Math.round(fontSize * lineHeightRatio);
  const htmlBaseStyle = useMemo(() => ({
    color: readerColors.text,
    fontSize,
    lineHeight,
  }), [fontSize, lineHeight, readerColors.text]);
  const tagsStyles = useMemo<Record<string, MixedStyleDeclaration>>(() => ({
    body: { color: readerColors.text, backgroundColor: readerColors.background },
    h1: { fontSize: fontSize * 1.55, lineHeight: Math.round(lineHeight * 1.35), fontWeight: '800' as const, marginTop: 12, marginBottom: 6 },
    h2: { fontSize: fontSize * 1.28, lineHeight: Math.round(lineHeight * 1.15), fontWeight: '800' as const, marginTop: 14, marginBottom: 5 },
    h3: { fontSize: fontSize * 1.12, lineHeight: Math.round(lineHeight * 1.02), fontWeight: '800' as const, marginTop: 14, marginBottom: 4 },
    h4: { fontSize, lineHeight, fontWeight: '800' as const, marginTop: 14, marginBottom: 4 },
    h5: { fontSize: fontSize * 0.94, lineHeight, fontWeight: '800' as const, marginTop: 14, marginBottom: 4 },
    h6: { fontSize: fontSize * 0.88, lineHeight, fontWeight: '800' as const, marginTop: 14, marginBottom: 4 },
    p: { marginTop: 0, marginBottom: 10 },
    ul: { marginTop: 2, marginBottom: 10, paddingLeft: 22 },
    ol: { marginTop: 2, marginBottom: 10, paddingLeft: 22 },
    li: { marginBottom: 2 },
    a: { color: readerColors.blue, textDecorationLine: 'none' as const },
    sup: {
      color: readerColors.blue,
      fontSize: Math.max(9, Math.round(fontSize * 0.65)),
      lineHeight: Math.max(11, Math.round(lineHeight * 0.65)),
      verticalAlign: 'top' as const,
    },
    mark: { backgroundColor: systemDark ? '#6B5714' : '#FFF0A6', color: readerColors.text, borderRadius: 3 },
    blockquote: { backgroundColor: systemDark ? '#18212C' : '#EEF5FF', borderLeftWidth: 3, borderLeftColor: readerColors.blue, borderRadius: 6, paddingHorizontal: 14, paddingVertical: 8, marginVertical: 10, color: readerColors.secondary },
    pre: { backgroundColor: readerColors.page, borderWidth: StyleSheet.hairlineWidth, borderColor: readerColors.border, borderRadius: 7, padding: 12, marginVertical: 10 },
    code: { fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }), backgroundColor: readerColors.page, fontSize: fontSize * 0.875, paddingHorizontal: 5, paddingVertical: 3, borderRadius: 6 },
    table: { backgroundColor: readerColors.background },
    th: { borderWidth: StyleSheet.hairlineWidth, borderColor: readerColors.border, backgroundColor: readerColors.page, paddingHorizontal: 10, paddingVertical: 7, fontWeight: '800' as const },
    td: { borderWidth: StyleSheet.hairlineWidth, borderColor: readerColors.border, paddingHorizontal: 10, paddingVertical: 7 },
    figure: { marginVertical: 10, marginHorizontal: 0 },
    figcaption: { color: readerColors.secondary, fontSize: fontSize * 0.82, lineHeight: Math.round(lineHeight * 0.82), textAlign: 'center' as const, marginTop: 2 },
    hr: { height: StyleSheet.hairlineWidth, backgroundColor: readerColors.border, marginVertical: 16 },
  }), [fontSize, lineHeight, readerColors, systemDark]);
  const renderers = useMemo(() => ({
    a: ({ InternalRenderer, style, tnode, ...props }: any) => {
      const href = String(tnode.attributes.href ?? '');
      if (!isFootnoteHref(href)) {
        return <InternalRenderer {...props} tnode={tnode} style={style} />;
      }
      return (
        <InternalRenderer
          {...props}
          tnode={tnode}
          style={[
            style,
            {
              fontSize: Math.max(9, Math.round(fontSize * 0.65)),
              lineHeight: Math.max(11, Math.round(lineHeight * 0.65)),
              position: 'relative',
              top: -Math.max(3, Math.round(fontSize * 0.28)),
            },
          ]}
        />
      );
    },
    sup: ({ TDefaultRenderer, style, ...props }: any) => (
      <TDefaultRenderer
        {...props}
        style={[
          style,
          {
            fontSize: Math.max(9, Math.round(fontSize * 0.65)),
            lineHeight: Math.max(11, Math.round(lineHeight * 0.65)),
            transform: [{ translateY: -Math.max(3, Math.round(fontSize * 0.28)) }],
          },
        ]}
      />
    ),
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
  }), [contentWidth, fontSize, lineHeight]);
  const renderersProps = useMemo(() => ({
    a: {
      onPress: (_event: unknown, href: string) => {
        if (!href) return;
        if (isFootnoteHref(href)) {
          scrollRef.current?.scrollToEnd({ animated: true });
          return;
        }
        Linking.openURL(href).catch(() => Alert.alert(t('linkOpenFailed'), href));
      },
      onLongPress: (_event: unknown, href: string) => {
        if (!href) return;
        Clipboard.setStringAsync(href).then(() => Alert.alert(t('copiedLink'))).catch(() => Alert.alert(t('copyFailed')));
      },
    },
  }), []);
  const source = useMemo(() => ({ html: normalizedContentHtml }), [normalizedContentHtml]);
  const changeReadingMode = useCallback(() => {
    const next = readingModes[(readingModes.indexOf(readingMode) + 1) % readingModes.length];
    autoTranslateKeyRef.current = '';
    setReadingMode(next);
  }, [readingMode, setReadingMode]);
  const clampFloatingPosition = useCallback((position: { x: number; y: number }) => ({
    x: Math.min(Math.max(floatingModeButtonMargin, position.x), Math.max(floatingModeButtonMargin, width - floatingModeButtonSize - floatingModeButtonMargin)),
    y: Math.min(Math.max(76, position.y), Math.max(76, height - floatingModeButtonSize - 76)),
  }), [height, width]);
  const updateFloatingPosition = useCallback((position: { x: number; y: number }) => {
    const next = clampFloatingPosition(position);
    floatingPositionRef.current = next;
    setFloatingPosition(next);
  }, [clampFloatingPosition]);
  const dockFloatingPosition = useCallback((position: { x: number; y: number }) => {
    const clamped = clampFloatingPosition(position);
    const leftX = floatingModeButtonMargin;
    const rightX = Math.max(floatingModeButtonMargin, width - floatingModeButtonSize - floatingModeButtonMargin);
    updateFloatingPosition({ ...clamped, x: clamped.x + floatingModeButtonSize / 2 < width / 2 ? leftX : rightX });
  }, [clampFloatingPosition, updateFloatingPosition, width]);
  const floatingModePanResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: (_event, gesture) => Math.abs(gesture.dx) > 3 || Math.abs(gesture.dy) > 3,
    onPanResponderGrant: () => {
      floatingDragStartRef.current = floatingPositionRef.current;
    },
    onPanResponderMove: (_event, gesture) => {
      updateFloatingPosition({
        x: floatingDragStartRef.current.x + gesture.dx,
        y: floatingDragStartRef.current.y + gesture.dy,
      });
    },
    onPanResponderRelease: (_event, gesture) => {
      if (Math.abs(gesture.dx) < 5 && Math.abs(gesture.dy) < 5) {
        changeReadingMode();
        return;
      }
      dockFloatingPosition({
        x: floatingDragStartRef.current.x + gesture.dx,
        y: floatingDragStartRef.current.y + gesture.dy,
      });
    },
    onPanResponderTerminate: (_event, gesture) => {
      dockFloatingPosition({
        x: floatingDragStartRef.current.x + gesture.dx,
        y: floatingDragStartRef.current.y + gesture.dy,
      });
    },
  }), [changeReadingMode, dockFloatingPosition, updateFloatingPosition]);

  useEffect(() => {
    updateFloatingPosition(defaultFloatingPosition());
  }, [defaultFloatingPosition, id, updateFloatingPosition]);

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
            translatedHtml ? <RenderHtml contentWidth={contentWidth} source={{ html: translatedHtml }} baseStyle={htmlBaseStyle} defaultTextProps={{ selectable: true }} tagsStyles={tagsStyles} renderers={renderers} renderersProps={renderersProps} /> :
              <QueryState title={isTranslationLoading ? t('translationLoadingDots') : t('noAlignedTranslation')} textColor={readerColors.text} secondaryColor={readerColors.secondary} />
          )}
          {readingMode === 'bilingual' && (
            <Bilingual
              originalBlocks={originalBlocks}
              translatedBlocks={translatedBlocks}
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
      <View
        {...floatingModePanResponder.panHandlers}
        accessibilityRole="button"
        accessibilityLabel={t(readingModeTextKeys[readingMode])}
        style={[
          styles.floatingModeButton,
          {
            left: floatingPosition.x,
            top: floatingPosition.y,
            backgroundColor: readerColors.blue,
            shadowColor: readerColors.text,
          },
        ]}
      >
        <Ionicons name={readingModeIcons[readingMode]} size={22} color="#fff" />
        <Text style={styles.floatingModeText}>{t(readingModeShortTextKeys[readingMode])}</Text>
      </View>
      <ImageView
        images={previewUri ? [{ uri: previewUri }] : []}
        imageIndex={0}
        visible={Boolean(previewUri)}
        onRequestClose={() => setPreviewUri('')}
        backgroundColor="#050505"
        doubleTapToZoomEnabled
        swipeToCloseEnabled
        HeaderComponent={() => (
          <Pressable style={({ pressed }) => [styles.previewClose, pressed && styles.pressed]} onPress={() => setPreviewUri('')} hitSlop={10}>
            <Ionicons name="close" size={26} color="#fff" />
          </Pressable>
        )}
      />
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
        style={{ width, height: Math.round(width * 0.48), marginVertical: 10, borderRadius: 6, }}
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

const Bilingual = ({
  originalBlocks,
  translatedBlocks,
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
  translatedBlocks: string[];
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
  const originalFontSize = Math.max(12, fontSize - 2);
  const originalLineHeight = Math.round((lineHeight / fontSize) * originalFontSize);
  const originalTagsStyles = {
    ...tagsStyles,
    body: { ...tagsStyles.body, backgroundColor: colors.page },
    p: { ...tagsStyles.p },
  };
  return (
    <View>
      {originalBlocks.map((item, index) => {
        const hasText = Boolean(stripHtml(item));
        const translation = translatedBlocks[index] ?? '';
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
            {!!translation && <RenderHtml contentWidth={contentWidth} source={{ html: translation }} baseStyle={htmlBaseStyle} defaultTextProps={{ selectable: true }} tagsStyles={tagsStyles} renderers={renderers} renderersProps={renderersProps} />}
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
  floatingModeButton: {
    position: 'absolute',
    width: floatingModeButtonSize,
    height: floatingModeButtonSize,
    borderRadius: floatingModeButtonSize / 2,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 20,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.18,
    shadowRadius: 16,
    elevation: 10,
  },
  floatingModeText: {
    marginTop: 1,
    color: '#fff',
    fontSize: 11,
    lineHeight: 13,
    fontWeight: '800',
  },
  previewClose: {
    position: 'absolute',
    top: 48,
    right: 22,
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: 'rgba(0, 0, 0, 0.38)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
