import * as Clipboard from 'expo-clipboard';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AppState, LayoutAnimation, Linking, Modal, NativeScrollEvent, NativeSyntheticEvent, PanResponder, Platform, Pressable, ScrollView, StyleSheet, Text, UIManager, View, useColorScheme } from 'react-native';
import ImageView from '@/components/ImageViewer';
import RenderHtml, { defaultSystemFonts, domNodeToHTMLString, HTMLContentModel, HTMLElementModel, type MixedStyleDeclaration } from 'react-native-render-html';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ActionPill } from '@/components/ActionPill';
import { ArticleCodeBlock } from '@/components/ArticleCodeBlock';
import { ArticleMedia } from '@/components/ArticleMedia';
import { ArticleRichContent } from '@/components/ArticleRichContent';
import { ArticleSvg } from '@/components/ArticleSvg';
import { IconButton } from '@/components/IconButton';
import { LoadingIndicator } from '@/components/LoadingIndicator';
import { QueryState } from '@/components/QueryState';
import { SegmentedTabs } from '@/components/SegmentedTabs';
import { articleRepo, translationRepo } from '@/api/repositories';
import { updatePreferences } from '@/api/preferences';
import { settingsRepo } from '@/db/repositories';
import { getLocale, t } from '@/i18n';
import { useAppStore } from '@/store/appStore';
import type { Article, ReaderFont, ReadingMode } from '@/types';
import { addArticleHeadingIds, decodeHtmlText, extractArticleHeadings, hasArticleMedia, isVideoEmbedUrl, renderHtmlNodeText, sanitizeArticleHtml, stripHtml, wrapFormulaBlocksForRendering, type ArticleHeading } from '@/utils/html';
import type { ArticleMediaSource } from '@/utils/articleMedia';
import { applyPartialTranslationPlan, createTranslationPlan, removeImagesFromHtml, splitTopLevelHtml } from '@/utils/translationHtml';
import { colors, getReaderColors, radius, spacing, typography, useReducedMotion } from '@/utils/theme';
import { useReaderFontFamilies } from '@/utils/readerFonts';
import { updateArticleCaches } from '@/utils/articleCache';
import { formatArticleDate } from '@/utils/time';
import { useDesktopLayout } from '@/hooks/useDesktopLayout';
import { useThinkingMode } from '@/components/ThinkingModeOverlay';
import { screenStyles } from './screenStyles';
import { getArticleDisplayTitle } from '@/utils/articlePresentation';
import { getArticleTableWidth } from '@/utils/tableLayout';
import { confirmDestructiveAction } from '@/utils/confirmAction';

const progressKey = (id: string) => `readerProgress:${id}`;
const articleSystemFonts = [
  ...defaultSystemFonts,
  'FeedMindSourceHanSerifRegular',
  'FeedMindSourceHanSerifBold',
  'FeedMindLiterataRegular',
  'FeedMindLiterataBold',
  'FeedMindSourceSerif4Regular',
  'FeedMindSourceSerif4Bold',
];
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
const mediaElementModels = {
  video: HTMLElementModel.fromCustomModel({ tagName: 'video', contentModel: HTMLContentModel.block }),
  audio: HTMLElementModel.fromCustomModel({ tagName: 'audio', contentModel: HTMLContentModel.block }),
  iframe: HTMLElementModel.fromCustomModel({ tagName: 'iframe', contentModel: HTMLContentModel.block }),
  svg: HTMLElementModel.fromCustomModel({ tagName: 'svg', contentModel: HTMLContentModel.block }),
  'feedmind-rich': HTMLElementModel.fromCustomModel({ tagName: 'feedmind-rich', contentModel: HTMLContentModel.block }),
};
const isFootnoteHref = (href: string) => /#(?:fn|footnote|endnote|note|cite(?:_note)?)[-_:]?\d+$/i.test(href);
const configureTransition = () => {
  LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
};
const codeLineTags = new Set(['div', 'p', 'li', 'tr']);
const codeTextFromDomNode = (node: any): string => {
  if (node?.nodeType === 3) return String(node.data ?? node.nodeValue ?? '');
  const tagName = String(node?.tagName ?? node?.nodeName ?? '').toLowerCase();
  if (tagName === 'br') return '\n';
  const text = Array.from(node?.childNodes ?? []).map(codeTextFromDomNode).join('');
  return codeLineTags.has(tagName) && text && !text.endsWith('\n') ? text + '\n' : text;
};
const codeTextFromNode = (node: any): string => {
  if (node?.domNode) return codeTextFromDomNode(node.domNode);
  if (node?.tagName === 'br') return '\n';
  if (typeof node?.data === 'string') return node.data;
  return Array.isArray(node?.children) ? node.children.map(codeTextFromNode).join('') : '';
};
const codeNodeFromPre = (node: any): any => {
  if (node?.tagName === 'code') return node;
  if (!Array.isArray(node?.children)) return undefined;
  for (const child of node.children) {
    const codeNode = codeNodeFromPre(child);
    if (codeNode) return codeNode;
  }
  return undefined;
};
const codeLanguageFromClassName = (codeNode: any) => {
  const className = String(codeNode?.attributes?.class ?? codeNode?.attributes?.className ?? codeNode?.domNode?.getAttribute?.('class') ?? '');
  return className.match(/(?:^|\s)(?:language|lang)-([a-z0-9_+#.-]+)(?:\s|$)/i)?.[1]?.toLowerCase();
};
type ArticleDetailScreenProps = {
  articleId?: string;
  embedded?: boolean;
  onClose?: () => void;
  onTagPress?: (tag: NonNullable<Article['topicTags']>[number]) => void;
  onPrevious?: () => void;
  onNext?: () => void;
  previousDisabled?: boolean;
  nextDisabled?: boolean;
};

export function ArticleDetailScreen({ articleId, embedded = false, onClose, onTagPress, onPrevious, onNext, previousDisabled = false, nextDisabled = false }: ArticleDetailScreenProps = {}) {
  const params = useLocalSearchParams<{ id: string }>();
  const id = articleId ?? params.id ?? '';
  const queryClient = useQueryClient();
  const systemDark = useColorScheme() === 'dark';
  const desktop = useDesktopLayout();
  const reducedMotion = useReducedMotion();
  const { openThinkingMode } = useThinkingMode();
  const { readingMode, setReadingMode, fontSize, setFontSize, lineHeightRatio, setLineHeightRatio, readerPageWidth, setReaderPageWidth, readerFont, setReaderFont, themeMode, languageMode } = useAppStore();
  const readerFontFamilies = useReaderFontFamilies(readerFont);
  const readerColors = getReaderColors(themeMode, systemDark);
  const codeThemeDark = themeMode === 'dark' || (themeMode === 'system' && systemDark);
  const inlineCodeBackgroundColor = desktop
    ? readerColors.page
    : codeThemeDark ? '#30343B' : '#E9EDF3';
  const inlineCodeBorderColor = codeThemeDark ? '#3A3F47' : '#DDE2EA';
  const bilingualOriginalBackgroundColor = desktop
    ? codeThemeDark ? '#252A31' : '#EEF2F7'
    : readerColors.page;
  const [paneSize, setPaneSize] = useState({ width: 0, height: 0 });
  const [contentWidth, setContentWidth] = useState(1);
  const scrollRef = useRef<ScrollView>(null);
  const scrollYRef = useRef(0);
  const autoTranslateKeyRef = useRef('');
  const pendingTranslateRef = useRef(false);
  const translationWorkFrameRef = useRef<number | null>(null);
  const engagedRef = useRef(false);
  const readingSessionIdRef = useRef('');
  const progressRatioRef = useRef(0);
  const remoteProgressAtRef = useRef(0);
  const restoredRef = useRef(false);
  const saveAtRef = useRef(0);
  const repairTriedRef = useRef(false);
  const titleTapAtRef = useRef(0);
  const headerCollapsedRef = useRef(false);
  const defaultFloatingPosition = useCallback(() => ({
    x: Math.max(floatingModeButtonMargin, paneSize.width - floatingModeButtonSize - floatingModeButtonMargin),
    y: Math.max(92, paneSize.height - floatingModeButtonSize - 92),
  }), [paneSize.height, paneSize.width]);
  const [floatingPosition, setFloatingPosition] = useState(defaultFloatingPosition);
  const floatingPositionRef = useRef(floatingPosition);
  const floatingDragStartRef = useRef(floatingPosition);
  const [previewUri, setPreviewUri] = useState('');
  const [repairingContent, setRepairingContent] = useState(false);
  const [repairFailed, setRepairFailed] = useState(false);
  const [translationWorkEnabled, setTranslationWorkEnabled] = useState(false);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  const [titleHeight, setTitleHeight] = useState(0);
  const [isHeaderCollapsed, setIsHeaderCollapsed] = useState(false);
  const [menuVisible, setMenuVisible] = useState(false);
  const [contentsVisible, setContentsVisible] = useState(false);
  const [readingSettingsVisible, setReadingSettingsVisible] = useState(false);
  const [activeHeadingId, setActiveHeadingId] = useState('');
  const activeHeadingIdRef = useRef('');
  const headingOffsetsRef = useRef<Record<string, number>>({});
  const headingContainerOffsetsRef = useRef<Record<string, number>>({});
  const articleBodyOffsetRef = useRef(0);

  const updateHeaderCollapsed = useCallback((collapsed: boolean) => {
    if (headerCollapsedRef.current === collapsed) return;
    headerCollapsedRef.current = collapsed;
    if (!reducedMotion) configureTransition();
    setIsHeaderCollapsed(collapsed);
  }, [reducedMotion]);

  useEffect(() => {
    if (Platform.OS === 'android') UIManager.setLayoutAnimationEnabledExperimental?.(true);
  }, []);

  const article = useQuery({
    queryKey: ['article', id, 'title-locale', languageMode, getLocale()],
    queryFn: () => articleRepo.get(id),
  });
  const translation = useQuery({
    queryKey: ['translation', id],
    enabled: Boolean(id),
    queryFn: () => translationRepo.get(id),
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const sendReadingActivity = useCallback(async (kind: 'engaged' | 'progress') => {
    if (!id || !readingSessionIdRef.current) return;
    const response = await articleRepo.readingActivity(id, {
      operationId: kind === 'engaged' ? `${readingSessionIdRef.current}:engaged` : `${readingSessionIdRef.current}:progress:${Date.now()}`,
      sessionId: readingSessionIdRef.current,
      kind,
      progress: progressRatioRef.current,
    });
    updateArticleCaches(queryClient, id, { isRead: response.data.isRead, progress: response.data.progress, lastOpenedAt: response.data.lastOpenedAt ?? undefined });
  }, [id, queryClient]);

  const engageReading = useCallback(() => {
    if (!article.data || engagedRef.current) return;
    engagedRef.current = true;
    void sendReadingActivity('engaged').catch(() => { engagedRef.current = false; });
  }, [article.data, sendReadingActivity]);

  useEffect(() => {
    engagedRef.current = false;
    readingSessionIdRef.current = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    progressRatioRef.current = 0;
    remoteProgressAtRef.current = 0;
    restoredRef.current = false;
    repairTriedRef.current = false;
    autoTranslateKeyRef.current = '';
    pendingTranslateRef.current = false;
    if (translationWorkFrameRef.current !== null) cancelAnimationFrame(translationWorkFrameRef.current);
    translationWorkFrameRef.current = null;
    setTranslationWorkEnabled(false);
    headerCollapsedRef.current = false;
    setReadingMode('original');
    setIsHeaderCollapsed(false);
    setMenuVisible(false);
    setContentsVisible(false);
    setReadingSettingsVisible(false);
    activeHeadingIdRef.current = '';
    headingOffsetsRef.current = {};
    headingContainerOffsetsRef.current = {};
    setActiveHeadingId('');
    setRepairFailed(false);
  }, [id, setReadingMode]);

  useEffect(() => () => {
    if (engagedRef.current) void sendReadingActivity('progress').catch(() => undefined);
  }, [sendReadingActivity]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active' && engagedRef.current) void sendReadingActivity('progress').catch(() => undefined);
    });
    return () => subscription.remove();
  }, [sendReadingActivity]);

  useEffect(() => {
    if (Platform.OS !== 'web') return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (['PageDown', 'PageUp', 'ArrowDown', 'ArrowUp', ' '].includes(event.key)) engageReading();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [engageReading]);

  useEffect(() => () => {
    if (translationWorkFrameRef.current !== null) cancelAnimationFrame(translationWorkFrameRef.current);
  }, []);

  useEffect(() => {
    if (!article.data || restoredRef.current || !contentHeight || !viewportHeight || !titleHeight) return;
    restoredRef.current = true;
    settingsRepo.get(progressKey(id)).then((value) => {
      const next = value ? JSON.parse(value) as { y?: number } : undefined;
      const maxY = Math.max(0, contentHeight - viewportHeight);
      const y = Math.max(0, next?.y ?? maxY * Math.max(0, Math.min(1, article.data.progress ?? 0)));
      updateHeaderCollapsed(y >= titleHeight);
      scrollRef.current?.scrollTo({ y, animated: false });
    }).catch(() => undefined);
  }, [article.data, contentHeight, id, titleHeight, updateHeaderCollapsed, viewportHeight]);

  const toggleStar = useMutation({
    mutationFn: async () => {
      const next = !article.data?.isStarred;
      await articleRepo.setStarred(id, next);
      return next;
    },
    onSuccess: (next) => updateArticleCaches(queryClient, id, { isStarred: next }),
  });
  const item = article.data;
  const translated = translation.data?.content ?? '';
  const normalizedContentHtml = useMemo(
    () => sanitizeArticleHtml(item?.contentHtml ?? '', item?.url ?? undefined),
    [item?.contentHtml, item?.url],
  );
  const originalHeadingHtml = useMemo(() => addArticleHeadingIds(normalizedContentHtml), [normalizedContentHtml]);
  const renderedOriginalHtml = useMemo(() => wrapFormulaBlocksForRendering(originalHeadingHtml), [originalHeadingHtml]);
  const originalHeadings = useMemo(() => extractArticleHeadings(originalHeadingHtml), [originalHeadingHtml]);
  const translationPlan = useMemo(
    () => translationWorkEnabled ? createTranslationPlan(normalizedContentHtml) : null,
    [normalizedContentHtml, translationWorkEnabled],
  );
  const translatedHtml = useMemo(() => {
    if (translated || !translationPlan || !translation.data?.partialBlocks.length) return translated;
    try {
      return applyPartialTranslationPlan(translationPlan, translation.data.partialBlocks);
    } catch {
      return '';
    }
  }, [translated, translation.data?.partialBlocks, translationPlan]);
  const translatedHeadingHtml = useMemo(() => addArticleHeadingIds(translatedHtml), [translatedHtml]);
  const renderedTranslatedHtml = useMemo(() => wrapFormulaBlocksForRendering(translatedHeadingHtml), [translatedHeadingHtml]);
  const translatedHeadings = useMemo(() => extractArticleHeadings(translatedHeadingHtml), [translatedHeadingHtml]);
  const headings = readingMode === 'original' ? originalHeadings : translatedHeadings;
  const highlightedHeadingId = activeHeadingId || headings[0]?.id || '';
  const originalBlocks = useMemo(() => translationPlan ? splitTopLevelHtml(translationPlan.sourceHtml) : [], [translationPlan]);
  const translatedBlocks = useMemo(() => translatedHeadingHtml ? splitTopLevelHtml(translatedHeadingHtml).map(removeImagesFromHtml) : [], [translatedHeadingHtml]);
  const originalArticleTitle = decodeHtmlText(item?.title ?? '');
  const articleTitle = readingMode === 'original' || !item
    ? originalArticleTitle
    : getArticleDisplayTitle(item);
  const articleSummary = item?.oneLineSummary?.trim() ?? '';
  const articleTopicTags: NonNullable<Article['topicTags']> = item?.topicTags
    ?.filter((tag: NonNullable<Article['topicTags']>[number]) => tag.name.trim()) ?? [];
  const translationAligned = Boolean(translatedHtml);
  const isCurrentTranslationPending = ['pending','running','cancel_requested'].includes(translation.data?.status ?? '');
  const isCurrentTranslationError = ['failed','cancelled','superseded'].includes(translation.data?.status ?? '') || translation.isError;
  const isTranslationLoading = readingMode !== 'original' && (!translationWorkEnabled || translation.isFetching || isCurrentTranslationPending);
  const isArticleParsing = item?.parseStatus === 'pending' || item?.parseStatus === 'parsing';
  const articleParseErrorMessage = item?.parseError?.trim();
  const hasReadableBody = Boolean(item?.contentText.trim()) && item?.contentText.trim() !== originalArticleTitle.trim();
  const hasRenderableBody = hasReadableBody || hasArticleMedia(normalizedContentHtml);
  const lineHeight = Math.round(fontSize * lineHeightRatio);
  const htmlBaseStyle = useMemo(() => ({
    color: readerColors.text,
    fontSize,
    lineHeight,
    fontFamily: readerFontFamilies.regular,
  }), [fontSize, lineHeight, readerColors.text, readerFontFamilies.regular]);
  const inlineCodeStyle = useMemo<MixedStyleDeclaration>(() => ({
    fontFamily: Platform.select({ web: 'ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace', ios: 'Menlo', default: 'monospace' }),
    backgroundColor: inlineCodeBackgroundColor,
    borderColor: inlineCodeBorderColor,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 5,
    overflow: Platform.OS === 'web' ? 'visible' : 'hidden',
    color: readerColors.text,
    fontSize: fontSize * 0.875,
    paddingHorizontal: 5,
    paddingVertical: Platform.OS === 'web' ? 1 : 2,
  }), [fontSize, inlineCodeBackgroundColor, inlineCodeBorderColor, readerColors.text]);
  const tableCellMinWidth = Math.max(96, Math.round(fontSize * 5.5));
  const tagsStyles = useMemo<Record<string, MixedStyleDeclaration>>(() => ({
    body: { color: readerColors.text, backgroundColor: readerColors.background, fontFamily: readerFontFamilies.regular },
    h1: { fontSize: fontSize * 1.5, lineHeight: Math.round(lineHeight * 1.28), fontFamily: readerFontFamilies.bold, fontWeight: readerFontFamilies.bold ? 'normal' as const : '700' as const, marginTop: 28, marginBottom: 12 },
    h2: { fontSize: fontSize * 1.28, lineHeight: Math.round(lineHeight * 1.14), fontFamily: readerFontFamilies.bold, fontWeight: readerFontFamilies.bold ? 'normal' as const : '700' as const, marginTop: 24, marginBottom: 10 },
    h3: { fontSize: fontSize * 1.12, lineHeight: Math.round(lineHeight * 1.04), fontFamily: readerFontFamilies.bold, fontWeight: readerFontFamilies.bold ? 'normal' as const : '600' as const, marginTop: 22, marginBottom: 8 },
    h4: { fontSize, lineHeight, fontFamily: readerFontFamilies.bold, fontWeight: readerFontFamilies.bold ? 'normal' as const : '600' as const, marginTop: 20, marginBottom: 8 },
    h5: { fontSize: fontSize * 0.94, lineHeight, fontFamily: readerFontFamilies.bold, fontWeight: readerFontFamilies.bold ? 'normal' as const : '600' as const, marginTop: 18, marginBottom: 6 },
    h6: { fontSize: fontSize * 0.88, lineHeight, fontFamily: readerFontFamilies.bold, fontWeight: readerFontFamilies.bold ? 'normal' as const : '600' as const, marginTop: 18, marginBottom: 6 },
    p: { marginTop: 0, marginBottom: 14 },
    ul: { marginTop: 2, marginBottom: 10, paddingLeft: 22 },
    ol: { marginTop: 2, marginBottom: 10, paddingLeft: 22 },
    li: { marginBottom: 2 },
    strong: { fontFamily: readerFontFamilies.bold, fontWeight: readerFontFamilies.bold ? 'normal' as const : 'bold' as const },
    b: { fontFamily: readerFontFamilies.bold, fontWeight: readerFontFamilies.bold ? 'normal' as const : 'bold' as const },
    a: { color: readerColors.blue, textDecorationLine: 'underline' as const, textDecorationColor: readerColors.blue },
    sup: {
      color: readerColors.blue,
      fontSize: Math.max(9, Math.round(fontSize * 0.65)),
      lineHeight: Math.max(11, Math.round(lineHeight * 0.65)),
    },
    mark: { backgroundColor: readerColors.mark, color: readerColors.text, borderRadius: 3 },
    blockquote: { backgroundColor: readerColors.quote, borderLeftWidth: 2, borderLeftColor: readerColors.borderStrong, paddingHorizontal: 16, paddingVertical: 8, marginVertical: 14, color: readerColors.secondary },
    pre: { marginVertical: 0 },
    code: inlineCodeStyle,
    table: { minWidth: Math.max(1, contentWidth - 2), backgroundColor: readerColors.background, marginVertical: 0 },
    th: { minWidth: tableCellMinWidth, borderWidth: StyleSheet.hairlineWidth, borderColor: readerColors.border, backgroundColor: readerColors.page, paddingHorizontal: 12, paddingVertical: 9, fontFamily: readerFontFamilies.bold, fontWeight: readerFontFamilies.bold ? 'normal' as const : '600' as const },
    td: { minWidth: tableCellMinWidth, borderWidth: StyleSheet.hairlineWidth, borderColor: readerColors.border, paddingHorizontal: 12, paddingVertical: 9 },
    figure: { marginVertical: 10, marginHorizontal: 0 },
    figcaption: { color: readerColors.secondary, fontSize: fontSize * 0.82, lineHeight: Math.round(lineHeight * 0.82), textAlign: 'center' as const, marginTop: 2 },
    hr: { height: StyleSheet.hairlineWidth, backgroundColor: readerColors.border, marginVertical: 16 },
  }), [contentWidth, fontSize, inlineCodeStyle, lineHeight, readerColors, readerFontFamilies.bold, readerFontFamilies.regular, systemDark, tableCellMinWidth]);
  const renderers = useMemo(() => {
    const headingRenderer = ({ TDefaultRenderer, tnode, ...props }: any) => {
      const headingId = String(tnode.attributes.id ?? '');
      return (
        <View onLayout={(event) => {
          if (headingId) headingOffsetsRef.current[headingId] = event.nativeEvent.layout.y;
        }}>
          <TDefaultRenderer {...props} tnode={tnode} />
        </View>
      );
    };
    return ({
      h1: headingRenderer,
      h2: headingRenderer,
      h3: headingRenderer,
      h4: headingRenderer,
      h5: headingRenderer,
      h6: headingRenderer,
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
      video: ({ tnode }: any) => (
        <ArticleMedia
          kind="video"
          uri={String(tnode.attributes.src ?? '')}
          sources={mediaSourcesFromNode(tnode)}
          poster={String(tnode.attributes.poster ?? '')}
          width={contentWidth}
          sourceWidth={numberAttribute(tnode, 'width')}
          sourceHeight={numberAttribute(tnode, 'height')}
        />
      ),
      audio: ({ tnode }: any) => (
        <ArticleMedia kind="audio" uri={String(tnode.attributes.src ?? '')} sources={mediaSourcesFromNode(tnode)} width={contentWidth} />
      ),
      iframe: ({ tnode }: any) => (
        <ArticleMedia
          kind="embed"
          uri={String(tnode.attributes.src ?? '')}
          width={contentWidth}
          sourceWidth={numberAttribute(tnode, 'width')}
          sourceHeight={numberAttribute(tnode, 'height')}
          trustedEmbed={isVideoEmbedUrl(String(tnode.attributes.src ?? ''))}
          title={String(tnode.attributes.title ?? '')}
        />
      ),
      svg: ({ tnode }: any) => <ArticleSvg xml={domNodeToHTMLString(tnode.domNode ?? null)} width={contentWidth} />,
      'feedmind-rich': ({ tnode }: any) => (
        <ArticleRichContent
          html={renderHtmlNodeText(tnode)}
          width={contentWidth}
          color={readerColors.text}
          backgroundColor={readerColors.background}
          inlineCodeBackgroundColor={inlineCodeBackgroundColor}
          inlineCodeBorderColor={inlineCodeBorderColor}
          fontSize={fontSize}
          lineHeight={lineHeight}
          fontFamily={readerFontFamilies.regular}
        />
      ),
      code: ({ TDefaultRenderer, style, tnode, ...props }: any) => (
        <TDefaultRenderer {...props} tnode={tnode} style={[style, inlineCodeStyle]} />
      ),
      pre: ({ TDefaultRenderer, tnode, ...props }: any) => {
        const codeNode = codeNodeFromPre(tnode);
        if (!codeNode) {
          return (
            <ScrollView horizontal showsHorizontalScrollIndicator>
              <View style={{ minWidth: contentWidth }}><TDefaultRenderer {...props} tnode={tnode} /></View>
            </ScrollView>
          );
        }
        const code = codeTextFromNode(codeNode ?? tnode).replace(/^\n|\n$/g, '');
        const language = codeLanguageFromClassName(codeNode);
        return <ArticleCodeBlock code={code} language={language} dark={codeThemeDark} width={contentWidth} borderColor={readerColors.border} backgroundColor={readerColors.page} textColor={readerColors.text} fontSize={fontSize * 0.875} />;
      },
      tr: ({ TDefaultRenderer, ...props }: any) => (
        <TDefaultRenderer
          {...props}
          style={[
            props.style,
            props.renderIndex % 2 === 1 && { backgroundColor: readerColors.page },
          ]}
        />
      ),
      table: ({ TDefaultRenderer, tnode, ...props }: any) => {
        const tableWidth = getArticleTableWidth(tnode, contentWidth, tableCellMinWidth);
        return (
          <View style={[styles.articleTableCard, { backgroundColor: readerColors.background, borderColor: readerColors.border }]}>
            <ScrollView
              horizontal
              nestedScrollEnabled
              directionalLockEnabled
              showsHorizontalScrollIndicator
              style={styles.articleTableScroll}
              contentContainerStyle={[styles.articleTableContent, { minWidth: Math.max(1, contentWidth - 2) }]}
            >
              <TDefaultRenderer {...props} tnode={tnode} style={[props.style, { width: tableWidth }]} />
            </ScrollView>
          </View>
        );
      },
    });
  }, [codeThemeDark, contentWidth, fontSize, inlineCodeBackgroundColor, inlineCodeBorderColor, inlineCodeStyle, lineHeight, readerColors, readerFontFamilies.regular, tableCellMinWidth]);
  const requestTranslate = useCallback(async () => {
    if (!translationPlan) {
      pendingTranslateRef.current = true;
      setTranslationWorkEnabled(true);
      return;
    }
    if (!item) return;
    try {
      const existing = translation.data;
      if (existing && ['failed','cancelled','superseded'].includes(existing.status)) {
        await translationRepo.retry(existing.id);
      } else {
        await translationRepo.start(item.id);
      }
      await queryClient.invalidateQueries({ queryKey: ['translation', item.id] });
    } catch (error) {
      Alert.alert(t('translateFailed'), error instanceof Error ? error.message : t('soonRetry'));
    }
  }, [item, queryClient, translation.data, translationPlan]);

  useEffect(() => {
    if (!pendingTranslateRef.current || !translationPlan) return;
    pendingTranslateRef.current = false;
    requestTranslate();
  }, [requestTranslate, translationPlan]);
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
  const source = useMemo(() => ({ html: renderedOriginalHtml }), [renderedOriginalHtml]);
  const selectReadingMode = useCallback((next: ReadingMode) => {
    if (next === readingMode) return;
    const preservedY = scrollYRef.current;
    activeHeadingIdRef.current = '';
    headingOffsetsRef.current = {};
    headingContainerOffsetsRef.current = {};
    setActiveHeadingId('');
    autoTranslateKeyRef.current = '';
    pendingTranslateRef.current = false;
    if (translationWorkFrameRef.current !== null) cancelAnimationFrame(translationWorkFrameRef.current);
    setTranslationWorkEnabled(false);
    setReadingMode(next);
    if (next === 'original') {
      translationWorkFrameRef.current = null;
      requestAnimationFrame(() => scrollRef.current?.scrollTo({ y: preservedY, animated: false }));
      return;
    }
    translationWorkFrameRef.current = requestAnimationFrame(() => {
      translationWorkFrameRef.current = requestAnimationFrame(() => {
        translationWorkFrameRef.current = null;
        setTranslationWorkEnabled(true);
        scrollRef.current?.scrollTo({ y: preservedY, animated: false });
      });
    });
  }, [readingMode, setReadingMode]);

  const changeReadingMode = useCallback(() => {
    const next = readingModes[(readingModes.indexOf(readingMode) + 1) % readingModes.length];
    selectReadingMode(next);
  }, [readingMode, selectReadingMode]);
  const clampFloatingPosition = useCallback((position: { x: number; y: number }) => ({
    x: Math.min(Math.max(floatingModeButtonMargin, position.x), Math.max(floatingModeButtonMargin, paneSize.width - floatingModeButtonSize - floatingModeButtonMargin)),
    y: Math.min(Math.max(76, position.y), Math.max(76, paneSize.height - floatingModeButtonSize - 76)),
  }), [paneSize.height, paneSize.width]);
  const updateFloatingPosition = useCallback((position: { x: number; y: number }) => {
    const next = clampFloatingPosition(position);
    floatingPositionRef.current = next;
    setFloatingPosition(next);
  }, [clampFloatingPosition]);
  const dockFloatingPosition = useCallback((position: { x: number; y: number }) => {
    const clamped = clampFloatingPosition(position);
    const leftX = floatingModeButtonMargin;
    const rightX = Math.max(floatingModeButtonMargin, paneSize.width - floatingModeButtonSize - floatingModeButtonMargin);
    updateFloatingPosition({ ...clamped, x: clamped.x + floatingModeButtonSize / 2 < paneSize.width / 2 ? leftX : rightX });
  }, [clampFloatingPosition, paneSize.width, updateFloatingPosition]);
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
    setMenuVisible(false);
  }, [isHeaderCollapsed]);

  useEffect(() => {
    if (readingMode === 'original' || !translationWorkEnabled || !translationPlan || translation.isFetching || (translated && translationAligned) || isCurrentTranslationPending || isCurrentTranslationError || !item) return;
    const key = `${id}:${readingMode}:${translated && !translationAligned ? 'mismatch' : 'empty'}`;
    if (autoTranslateKeyRef.current === key) return;
    autoTranslateKeyRef.current = key;
    requestTranslate();
  }, [id, isCurrentTranslationError, isCurrentTranslationPending, item, readingMode, requestTranslate, translated, translation.isFetching, translationAligned, translationPlan, translationWorkEnabled]);


  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement, contentSize } = event.nativeEvent;
    scrollYRef.current = contentOffset.y;
    updateHeaderCollapsed(titleHeight > 0 && contentOffset.y >= titleHeight);
    const readingY = contentOffset.y - articleBodyOffsetRef.current + 24;
    let activeId = '';
    for (const heading of headings) {
      const localOffset = headingOffsetsRef.current[heading.id];
      if (localOffset === undefined) continue;
      const containerOffset = readingMode === 'bilingual' ? headingContainerOffsetsRef.current[heading.id] ?? 0 : 0;
      if (containerOffset + localOffset <= readingY) activeId = heading.id;
      else break;
    }
    if (!activeId && headings.length) activeId = headings[0].id;
    if (activeHeadingIdRef.current !== activeId) {
      activeHeadingIdRef.current = activeId;
      setActiveHeadingId(activeId);
    }
    const maxY = Math.max(1, contentSize.height - layoutMeasurement.height);
    const ratio = contentOffset.y / maxY;
    progressRatioRef.current = Math.max(0, Math.min(1, ratio));
    const now = Date.now();
    if (engagedRef.current && now - remoteProgressAtRef.current >= 5000) {
      remoteProgressAtRef.current = now;
      void sendReadingActivity('progress').catch(() => undefined);
    }
    if (now - saveAtRef.current < 1000) return;
    saveAtRef.current = now;
    settingsRepo.set(progressKey(id), JSON.stringify({ y: contentOffset.y, ratio })).catch(() => undefined);
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
  const removeArticle = useMutation({ mutationFn: () => articleRepo.remove(id), onSuccess: () => {
    queryClient.removeQueries({ queryKey: ['article', id] });
    void queryClient.invalidateQueries({ queryKey: ['articles'] });
    void queryClient.invalidateQueries({ queryKey: ['library-tree'] });
    (onClose ?? (() => router.back()))();
  }, onError: (error) => Alert.alert(t('deleteFailed'), error instanceof Error ? error.message : t('soonRetry')) });
  const confirmRemoveArticle = () => item && confirmDestructiveAction({ title: t('deleteArticle'), message: t('deleteArticleConfirm', { title: articleTitle }), cancelText: t('cancel'), confirmText: t('delete'), onConfirm: () => removeArticle.mutate() });
  const updateReaderFont = (next: ReaderFont) => {
    setReaderFont(next);
    settingsRepo.set('readerFont', next).catch(() => undefined);
  };
  const updateReaderFontSize = (next: number) => {
    const value = Math.min(24, Math.max(14, next));
    setFontSize(value);
    settingsRepo.set('readerFontSize', String(value)).catch(() => undefined);
    updatePreferences({ fontSize: value }).catch(() => undefined);
  };
  const updateReaderLineHeight = (next: number) => {
    const value = Math.min(2, Math.max(1.35, Math.round(next * 100) / 100));
    setLineHeightRatio(value);
    settingsRepo.set('readerLineHeightRatio', String(value)).catch(() => undefined);
    updatePreferences({ lineHeightRatio: value }).catch(() => undefined);
  };
  const updateReaderPageWidth = (next: number) => {
    const value = Math.min(1200, Math.max(480, Math.round(next / 20) * 20));
    setReaderPageWidth(value);
    settingsRepo.set('readerPageWidth', String(value)).catch(() => undefined);
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
  const jumpToHeading = (heading: ArticleHeading) => {
    engageReading();
    setContentsVisible(false);
    activeHeadingIdRef.current = heading.id;
    setActiveHeadingId(heading.id);
    const offset = headingOffsetsRef.current[heading.id];
    if (offset === undefined) return;
    requestAnimationFrame(() => scrollRef.current?.scrollTo({
      y: Math.max(0, articleBodyOffsetRef.current + (readingMode === 'bilingual' ? headingContainerOffsetsRef.current[heading.id] ?? 0 : 0) + offset - 12),
      animated: true,
    }));
  };
  const recordBilingualBlockOffset = (index: number, offset: number) => {
    for (const heading of extractArticleHeadings(translatedBlocks[index] ?? '')) {
      headingContainerOffsetsRef.current[heading.id] = offset;
    }
  };

  if (article.isLoading) {
    return <SafeAreaView style={[screenStyles.safe, { backgroundColor: readerColors.background }]}><QueryState title={t('articlesLoading')} textColor={readerColors.text} secondaryColor={readerColors.secondary} /></SafeAreaView>;
  }

  if (article.isError) {
    return <SafeAreaView style={[screenStyles.safe, { backgroundColor: readerColors.background }]}><QueryState title={t('articleLoadFailed')} message={article.error instanceof Error ? article.error.message : t('soonRetry')} actionLabel={t('retry')} onAction={() => article.refetch()} textColor={readerColors.text} secondaryColor={readerColors.secondary} /></SafeAreaView>;
  }

  if (!item) {
    return <SafeAreaView style={[screenStyles.safe, { backgroundColor: readerColors.background }]}><QueryState title={t('articleMissing')} message={t('articleNotFoundMessage')} actionLabel={t('back')} onAction={onClose ?? (() => router.back())} textColor={readerColors.text} secondaryColor={readerColors.secondary} /></SafeAreaView>;
  }

  return (
    <SafeAreaView
      style={[screenStyles.safe, { backgroundColor: readerColors.background }]}
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        setPaneSize((current) => current.width === width && current.height === height ? current : { width, height });
      }}
    >
      <View style={[screenStyles.header, { paddingHorizontal: 16 }]}>
        <View style={styles.leadingHeaderActions}>
          <IconButton name={embedded ? 'close' : 'chevron-back'} label={embedded ? t('close') : t('back')} onPress={onClose ?? (() => router.back())} />
          {embedded && onPrevious ? <IconButton name="chevron-up" label={t('previousArticle')} disabled={previousDisabled} onPress={onPrevious} /> : null}
          {embedded && onNext ? <IconButton name="chevron-down" label={t('nextArticle')} disabled={nextDisabled} onPress={onNext} /> : null}
        </View>
        <View style={{ flex: 1 }} />
        {isHeaderCollapsed && (
          <Pressable style={({ pressed }) => [styles.pinnedTitle, pressed && styles.pressed]} onPress={handlePinnedTitlePress}>
            <Text numberOfLines={1} style={[styles.pinnedTitleText, { color: readerColors.text, fontFamily: readerFontFamilies.bold, fontWeight: readerFontFamilies.bold ? 'normal' : '600' }]}>{articleTitle}</Text>
          </Pressable>
        )}
        {isHeaderCollapsed ? (
          <View style={styles.headerActions}>
            {desktop && <IconButton name="list-outline" label={t('contents')} onPress={() => setContentsVisible(true)} />}
            <IconButton name="ellipsis-horizontal" onPress={toggleMenu} />
          </View>
        ) : (
          <View style={styles.headerActions}>
            <IconButton name={item.isStarred ? 'star' : 'star-outline'} label={item.isStarred ? t('saved') : t('collect')} active={item.isStarred} loading={toggleStar.isPending} onPress={() => toggleStar.mutate()} />
            {!!item.url && (
              <Pressable style={({ pressed }) => [styles.openOriginalButton, pressed && styles.pressed]} onPress={openOriginal} hitSlop={8}>
                <Ionicons name="earth" size={18} color={readerColors.text} />
              </Pressable>
            )}
            {desktop && <IconButton name="list-outline" label={t('contents')} onPress={() => setContentsVisible(true)} />}
            <IconButton name="ellipsis-horizontal" onPress={toggleMenu} />
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
              label={t('readingSettings')}
              color={readerColors.text}
              onPress={() => runMenuAction(() => setReadingSettingsVisible(true))}
            />
            <MenuItem
              icon="bulb-outline"
              label={t('thinkingMode')}
              color={readerColors.text}
              onPress={() => runMenuAction(() => openThinkingMode(item))}
            />
            {item.isSelected ? <MenuItem icon="trash-outline" label={t('deleteArticle')} color={readerColors.destructive} onPress={() => runMenuAction(confirmRemoveArticle)} disabled={removeArticle.isPending} /> : null}
          </View>
        </>
      )}
      <ScrollView
        ref={scrollRef}
        {...(Platform.OS === 'web' ? ({ dataSet: { scrollbar: 'feedmind' } } as any) : {})}
        onScrollBeginDrag={engageReading}
        {...(Platform.OS === 'web' ? { onWheel: engageReading } : {})}
        contentContainerStyle={[styles.scroll, desktop && styles.desktopScroll]}
        onLayout={(event) => {
          const { width, height } = event.nativeEvent.layout;
          setViewportHeight(height);
          if (width <= 0 || height <= 0) return;
          setPaneSize((current) => {
            const paneHeight = height + 62;
            return current.width === width && current.height === paneHeight
              ? current
              : { width, height: paneHeight };
          });
        }}
        onContentSizeChange={(_width, height) => setContentHeight(height)}
        onScroll={onScroll}
        scrollEventThrottle={16}
      >
        <View style={styles.titleRow} onLayout={(event) => setTitleHeight(event.nativeEvent.layout.height)}>
          <View style={styles.titleTextGroup}>
            <Text style={[styles.title, desktop && styles.desktopTitle, { color: readerColors.text, fontFamily: readerFontFamilies.bold, fontWeight: readerFontFamilies.bold ? 'normal' : '700' }]}>{articleTitle}</Text>
          </View>
        </View>
        <Text style={[styles.meta, { color: readerColors.secondary }]}>
          {item.feedTitle || 'Feed'} · {formatArticleDate(item.publishedAt || item.createdAt)}
        </Text>
        {(articleSummary || articleTopicTags.length > 0) && (
          <View style={styles.preprocessingCard}>
            {articleSummary && (
              <View style={[styles.articleSummaryCard, { backgroundColor: readerColors.pill, borderColor: readerColors.border }]}>
                <View style={styles.articleSummaryHeader}>
                  <View style={[styles.articleSummaryIcon, { backgroundColor: readerColors.selected }]}>
                    <Ionicons name="sparkles" size={14} color={readerColors.blue} />
                  </View>
                  <Text style={[styles.articleSummaryLabel, { color: readerColors.blue }]}>{t('aiSummary')}</Text>
                </View>
                <Text style={[styles.articleSummary, { color: readerColors.text, fontFamily: readerFontFamilies.regular }]}>{articleSummary}</Text>
              </View>
            )}
            {articleTopicTags.length > 0 && (
              <View style={[styles.articleTags, articleSummary && styles.articleTagsAfterSummary]} accessibilityLabel={articleTopicTags.map((tag) => tag.name).join('，')}>
                {articleTopicTags.map((tag) => (
                  <Pressable key={tag.key} accessibilityRole="button" accessibilityLabel={t('filterByTag', { name: tag.name })}
                    style={({ hovered, pressed }: any) => [styles.articleTag, { backgroundColor: readerColors.page }, hovered && { backgroundColor: readerColors.hover }, pressed && styles.pressed]}
                    onPress={() => onTagPress ? onTagPress(tag) : router.replace({ pathname: '/all', params: { tag: tag.key } })}>
                    <Text style={[styles.articleTagText, { color: readerColors.secondary }]}>{tag.name}</Text>
                  </Pressable>
                ))}
              </View>
            )}
          </View>
        )}
        {isArticleParsing && (
          <View style={[styles.parsingNotice, { backgroundColor: readerColors.page, borderColor: readerColors.border }]}>
            <LoadingIndicator compact accent />
            <View style={styles.parsingNoticeText}>
              <Text style={[styles.parsingNoticeTitle, { color: readerColors.text }]}>{t('articleParsing')}</Text>
              <Text style={[styles.parsingNoticeMessage, { color: readerColors.secondary }]}>{t('articleParsingMessage')}</Text>
            </View>
          </View>
        )}
        <View
          style={[styles.articleBody, desktop && { width: '100%', maxWidth: readerPageWidth, alignSelf: 'center' }]}
          onLayout={(event) => {
            const { width, y } = event.nativeEvent.layout;
            articleBodyOffsetRef.current = y;
            if (width <= 0) return;
            setContentWidth((current) => current === width ? current : width);
          }}
        >
          {readingMode === 'original' && (
            hasRenderableBody ? (
              <RenderHtml
                contentWidth={contentWidth}
                source={source}
                systemFonts={articleSystemFonts}
                customHTMLElementModels={mediaElementModels}
                baseStyle={htmlBaseStyle}
                defaultTextProps={{ selectable: true }}
                tagsStyles={tagsStyles}
                renderers={renderers}
                renderersProps={renderersProps}
              />
            ) : (
              <QueryState
                title={isArticleParsing ? t('articleParsing') : item.parseStatus === 'error' ? t('repairBodyFailed') : repairingContent ? t('repairBodyLoading') : repairFailed ? t('repairBodyFailed') : t('noText')}
                message={isArticleParsing
                  ? t('articleParsingMessage')
                  : item.parseStatus === 'error' && articleParseErrorMessage
                    ? t('articleParseFailureReason', { error: articleParseErrorMessage })
                    : t('repairBodyMessage')}
                loading={isArticleParsing}
                actionLabel={isArticleParsing ? undefined : t('retry')}
                onAction={isArticleParsing ? undefined : () => {
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
            translatedHtml ? <RenderHtml contentWidth={contentWidth} source={{ html: renderedTranslatedHtml }} systemFonts={articleSystemFonts} customHTMLElementModels={mediaElementModels} baseStyle={htmlBaseStyle} defaultTextProps={{ selectable: true }} tagsStyles={tagsStyles} renderers={renderers} renderersProps={renderersProps} /> :
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
              originalBackgroundColor={bilingualOriginalBackgroundColor}
              contentWidth={contentWidth}
              htmlBaseStyle={htmlBaseStyle}
              tagsStyles={tagsStyles}
              renderers={renderers}
              renderersProps={renderersProps}
              loadingText={t('translationLoadingDots')}
              onBlockLayout={recordBilingualBlockOffset}
            />
          )}
          {isTranslationLoading && (
            isCurrentTranslationPending ? (
              <QueryState
                title={t('translationLoadingDots')}
                message={t('translationManualRefreshHint')}
                actionLabel={translation.isFetching ? t('refreshing') : t('refresh')}
                onAction={translation.isFetching ? undefined : () => { void translation.refetch(); }}
                textColor={readerColors.text}
                secondaryColor={readerColors.secondary}
              />
            ) : (
              <View style={styles.translateState}>
                <LoadingIndicator compact label={t('translationLoading')} />
              </View>
            )
          )}
          {isCurrentTranslationError && (
            <QueryState title={t('translateFailed')} message={translation.error instanceof Error ? translation.error.message : t('soonRetry')} actionLabel={t('retry')} onAction={requestTranslate} textColor={readerColors.text} secondaryColor={readerColors.secondary} />
          )}
        </View>
      </ScrollView>
      {!desktop && <View style={[styles.actions, { backgroundColor: readerColors.background, borderTopColor: readerColors.border }]}>
        <ActionPill icon="list-outline" label={t('contents')} onPress={() => setContentsVisible(true)} />
        <ActionPill icon="book-outline" label={t('readingSettings')} onPress={() => setReadingSettingsVisible(true)} />
        <ActionPill icon="bulb-outline" label={t('thinkingMode')} onPress={() => openThinkingMode(item)} />
      </View>}
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
      <Modal transparent visible={readingSettingsVisible} animationType='fade' onRequestClose={() => setReadingSettingsVisible(false)}>
        <Pressable
          style={[
            styles.contentsBackdrop,
            Platform.OS === 'web' && embedded && paneSize.width > 0
              ? { width: paneSize.width, alignSelf: 'flex-end' }
              : null,
          ]}
          onPress={() => setReadingSettingsVisible(false)}
        >
          <Pressable style={[styles.readingSettingsPanel, desktop && styles.desktopReaderPanel, { backgroundColor: readerColors.background, borderColor: readerColors.border }]} onPress={(event) => event.stopPropagation()}>
            <View style={styles.contentsHeader}>
              <Text style={[styles.contentsTitle, { color: readerColors.text }]}>{t('readingSettings')}</Text>
              <IconButton name='close' onPress={() => setReadingSettingsVisible(false)} />
            </View>
            <Text style={[styles.readingSettingsLabel, { color: readerColors.secondary }]}>{t('readingMode')}</Text>
            <SegmentedTabs
              items={readingModes.map((mode) => ({ label: t(readingModeTextKeys[mode]), value: mode }))}
              value={readingMode}
              onChange={selectReadingMode}
            />
            <Text style={[styles.readingSettingsLabel, { color: readerColors.secondary }]}>{t('bodyFont')}</Text>
            <View style={styles.fontOptions}>
              {([
                { value: 'system', label: t('system') },
                { value: 'source-han-serif', label: '思源宋体' },
                { value: 'literata', label: 'Literata' },
                { value: 'source-serif-4', label: 'Source Serif 4' },
              ] as Array<{ value: ReaderFont; label: string }>).map((option) => {
                const active = option.value === readerFont;
                return (
                  <Pressable
                    key={option.value}
                    style={({ pressed }) => [styles.fontOption, { borderColor: active ? readerColors.blue : readerColors.border, backgroundColor: active ? readerColors.page : readerColors.background }, pressed && styles.pressed]}
                    onPress={() => updateReaderFont(option.value)}
                  >
                    <Text style={[styles.fontOptionText, { color: active ? readerColors.blue : readerColors.text }]}>{option.label}</Text>
                    {active && <Ionicons name='checkmark-circle' size={18} color={readerColors.blue} />}
                  </Pressable>
                );
              })}
            </View>
            <ReaderStepper label={t('fontSize')} value={String(fontSize)} color={readerColors.text} secondaryColor={readerColors.secondary} buttonColor={readerColors.page} accentColor={readerColors.blue} onDecrease={() => updateReaderFontSize(fontSize - 1)} onIncrease={() => updateReaderFontSize(fontSize + 1)} />
            <ReaderStepper label={t('lineHeight')} value={lineHeightRatio.toFixed(2)} color={readerColors.text} secondaryColor={readerColors.secondary} buttonColor={readerColors.page} accentColor={readerColors.blue} onDecrease={() => updateReaderLineHeight(lineHeightRatio - 0.1)} onIncrease={() => updateReaderLineHeight(lineHeightRatio + 0.1)} />
            {desktop && (
              <ReaderSlider
                label={t('pageWidth')}
                value={readerPageWidth}
                minimumValue={480}
                maximumValue={1200}
                step={20}
                color={readerColors.text}
                secondaryColor={readerColors.secondary}
                trackColor={readerColors.page}
                accentColor={readerColors.blue}
                onValueChange={updateReaderPageWidth}
              />
            )}
          </Pressable>
        </Pressable>
      </Modal>
      <Modal transparent visible={contentsVisible} animationType="fade" onRequestClose={() => setContentsVisible(false)}>
        <Pressable
          style={[
            styles.contentsBackdrop,
            Platform.OS === 'web' && embedded && paneSize.width > 0
              ? { width: paneSize.width, alignSelf: 'flex-end' }
              : null,
          ]}
          onPress={() => setContentsVisible(false)}
        >
          <Pressable style={[styles.contentsPanel, desktop && styles.desktopReaderPanel, desktop && styles.desktopContentsPanel, { backgroundColor: readerColors.background, borderColor: readerColors.border }]} onPress={(event) => event.stopPropagation()}>
            <View style={styles.contentsHeader}>
              <Text style={[styles.contentsTitle, { color: readerColors.text }]}>{t('contents')}</Text>
              <IconButton name="close" onPress={() => setContentsVisible(false)} />
            </View>
            {headings.length ? (
              <ScrollView style={styles.contentsList}>
                {headings.map((heading) => (
                  <Pressable key={heading.id} style={({ pressed }) => [styles.contentsItem, { paddingLeft: 16 + (heading.level - 1) * 14 }, highlightedHeadingId === heading.id && { backgroundColor: readerColors.page }, pressed && styles.pressed]} onPress={() => jumpToHeading(heading)}>
                    <Text numberOfLines={2} style={[styles.contentsItemText, { color: highlightedHeadingId === heading.id ? readerColors.blue : readerColors.text }, highlightedHeadingId === heading.id && styles.contentsItemTextActive]}>{heading.title}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            ) : <Text style={[styles.contentsEmpty, { color: readerColors.secondary }]}>{t('contentsEmpty')}</Text>}
          </Pressable>
        </Pressable>
      </Modal>
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
  const [failedUri, setFailedUri] = useState('');
  const [retryCount, setRetryCount] = useState(0);
  if (!uri) return null;
  const height = Math.round(width * 0.48);
  if (failedUri === uri) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${t('mediaLoadFailed')}，${t('retry')}`}
        style={[styles.articleImagePlaceholder, { width, height }]}
        onPress={() => {
          setFailedUri('');
          setRetryCount((count) => count + 1);
        }}
      >
        <Ionicons name="image-outline" size={38} color={colors.subtle} />
        <Text style={styles.articleImagePlaceholderText}>{t('mediaLoadFailed')} · {t('retry')}</Text>
      </Pressable>
    );
  }
  return (
    <Pressable style={styles.articleImageContainer} onPress={() => onPress(uri)}>
      <Image
        key={`${uri}:${retryCount}`}
        source={{ uri }}
        style={[styles.articleImage, { width, height }]}
        contentFit="contain"
        transition={150}
        onError={() => setFailedUri(uri)}
      />
    </Pressable>
  );
};

const MenuItem = ({ icon, label, color, onPress, disabled = false }: { icon: keyof typeof Ionicons.glyphMap; label: string; color: string; onPress: () => void; disabled?: boolean }) => (
  <Pressable disabled={disabled} style={({ pressed }) => [styles.menuItem, disabled && { opacity: 0.5 }, pressed && styles.pressed]} onPress={onPress}>
    <Ionicons name={icon} size={18} color={color} />
    <Text style={[styles.menuItemText, { color }]}>{label}</Text>
  </Pressable>
);

const ReaderStepper = ({ label, value, color, secondaryColor, buttonColor, accentColor, onDecrease, onIncrease }: {
  label: string;
  value: string;
  color: string;
  secondaryColor: string;
  buttonColor: string;
  accentColor: string;
  onDecrease: () => void;
  onIncrease: () => void;
}) => (
  <View style={styles.readerStepperRow}>
    <Text style={[styles.readerStepperLabel, { color }]}>{label}</Text>
    <View style={styles.readerStepperControls}>
      <Pressable style={({ pressed }) => [styles.readerStepperButton, { backgroundColor: buttonColor }, pressed && styles.pressed]} onPress={onDecrease}>
        <Ionicons name='remove' size={20} color={accentColor} />
      </Pressable>
      <Text style={[styles.readerStepperValue, { color: secondaryColor }]}>{value}</Text>
      <Pressable style={({ pressed }) => [styles.readerStepperButton, { backgroundColor: buttonColor }, pressed && styles.pressed]} onPress={onIncrease}>
        <Ionicons name='add' size={20} color={accentColor} />
      </Pressable>
    </View>
  </View>
);

const ReaderSlider = ({ label, value, minimumValue, maximumValue, step, color, secondaryColor, trackColor, accentColor, onValueChange }: {
  label: string;
  value: number;
  minimumValue: number;
  maximumValue: number;
  step: number;
  color: string;
  secondaryColor: string;
  trackColor: string;
  accentColor: string;
  onValueChange: (value: number) => void;
}) => {
  const [trackWidth, setTrackWidth] = useState(0);
  const percentage = (value - minimumValue) / (maximumValue - minimumValue);
  const updateFromPosition = useCallback((position: number) => {
    if (!trackWidth) return;
    const ratio = Math.min(1, Math.max(0, position / trackWidth));
    const next = minimumValue + ratio * (maximumValue - minimumValue);
    const nextValue = Math.round(next / step) * step;
    if (nextValue !== value) onValueChange(nextValue);
  }, [maximumValue, minimumValue, onValueChange, step, trackWidth, value]);
  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (event) => updateFromPosition(event.nativeEvent.locationX),
    onPanResponderMove: (event) => updateFromPosition(event.nativeEvent.locationX),
  }), [updateFromPosition]);

  return (
    <View style={styles.readerSliderRow}>
      <View style={styles.readerSliderHeader}>
        <Text style={[styles.readerStepperLabel, { color }]}>{label}</Text>
        <Text style={[styles.readerSliderValue, { color: secondaryColor }]}>{value} px</Text>
      </View>
      <View
        {...panResponder.panHandlers}
        accessible
        accessibilityRole='adjustable'
        accessibilityLabel={label}
        accessibilityValue={{ min: minimumValue, max: maximumValue, now: value, text: String(value) + ' px' }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(event) => onValueChange(value + (event.nativeEvent.actionName === 'increment' ? step : -step))}
        style={styles.readerSliderTouchArea}
        onLayout={(event) => setTrackWidth(event.nativeEvent.layout.width)}
      >
        <View style={[styles.readerSliderTrack, { backgroundColor: trackColor }]}>
          <View style={[styles.readerSliderFill, { width: percentage * trackWidth, backgroundColor: accentColor }]} />
          <View style={[styles.readerSliderThumb, { left: percentage * trackWidth, backgroundColor: accentColor }]} />
        </View>
      </View>
    </View>
  );
};
const mediaSourcesFromNode = (node: any): ArticleMediaSource[] => Array.from(node?.domNode?.querySelectorAll?.('source') ?? []).flatMap((source: any) => {
  const uri = String(source.getAttribute?.('src') ?? '');
  return uri ? [{ uri, type: String(source.getAttribute?.('type') ?? '') || undefined }] : [];
});
const numberAttribute = (node: any, name: string) => {
  const value = Number.parseFloat(String(node?.attributes?.[name] ?? ''));
  return Number.isFinite(value) && value > 0 ? value : undefined;
};

const Bilingual = ({
  originalBlocks,
  translatedBlocks,
  isTranslationLoading,
  fontSize,
  lineHeight,
  colors,
  originalBackgroundColor,
  contentWidth,
  htmlBaseStyle,
  tagsStyles,
  renderers,
  renderersProps,
  loadingText,
  onBlockLayout,
}: {
  originalBlocks: string[];
  translatedBlocks: string[];
  isTranslationLoading: boolean;
  fontSize: number;
  lineHeight: number;
  colors: ReturnType<typeof getReaderColors>;
  originalBackgroundColor: string;
  contentWidth: number;
  htmlBaseStyle: Record<string, string | number | undefined>;
  tagsStyles: Record<string, any>;
  renderers: Record<string, any>;
  renderersProps: Record<string, any>;
  loadingText: string;
  onBlockLayout: (index: number, offset: number) => void;
}) => {
  const originalFontSize = Math.max(12, fontSize - 2);
  const originalLineHeight = Math.round((lineHeight / fontSize) * originalFontSize);
  const originalTagsStyles = {
    ...tagsStyles,
    body: { ...tagsStyles.body, backgroundColor: originalBackgroundColor },
    p: { ...tagsStyles.p },
  };
  return (
    <View>
      {originalBlocks.map((item, index) => {
        const hasText = Boolean(stripHtml(item));
        const translation = translatedBlocks[index] ?? '';
        const hasTranslation = Boolean(stripHtml(translation).trim() || hasArticleMedia(translation));
        return (
          <View key={`${index}-${item}`} style={styles.bilingualBlock} onLayout={(event) => onBlockLayout(index, event.nativeEvent.layout.y)}>
            <View style={[styles.bilingualOriginal, { backgroundColor: originalBackgroundColor }]}>
              <RenderHtml
                contentWidth={contentWidth}
                source={{ html: wrapFormulaBlocksForRendering(item) }}
                systemFonts={articleSystemFonts}
                customHTMLElementModels={mediaElementModels}
                baseStyle={{ ...htmlBaseStyle, color: colors.secondary, fontSize: originalFontSize, lineHeight: originalLineHeight }}
                defaultTextProps={{ selectable: true }}
                tagsStyles={originalTagsStyles}
                renderers={renderers}
                renderersProps={renderersProps}
              />
            </View>
            {hasTranslation && <RenderHtml contentWidth={contentWidth} source={{ html: wrapFormulaBlocksForRendering(translation) }} systemFonts={articleSystemFonts} customHTMLElementModels={mediaElementModels} baseStyle={htmlBaseStyle} defaultTextProps={{ selectable: true }} tagsStyles={tagsStyles} renderers={renderers} renderersProps={renderersProps} />}
            {!hasTranslation && hasText && isTranslationLoading && <Text style={[styles.bilingualTranslation, { color: colors.secondary, fontSize, lineHeight, fontFamily: typeof htmlBaseStyle.fontFamily === 'string' ? htmlBaseStyle.fontFamily : undefined, textIndent: `${fontSize * 2}px` }]}>{loadingText}</Text>}
          </View>
        );
      })}
    </View>
  );
};

const styles = StyleSheet.create({
  articleTableCard: {
    width: '100%',
    marginVertical: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    overflow: 'hidden',
  },
  articleTableScroll: {
    width: '100%',
  },
  articleTableContent: {
    flexGrow: 1,
  },
  articleImageContainer: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  articleImage: {
    alignSelf: 'center',
    marginVertical: 10,
    borderRadius: 6,
    backgroundColor: '#FFFFFF',
  },
  articleImagePlaceholder: {
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginVertical: 10,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.page,
  },
  articleImagePlaceholderText: {
    color: colors.secondary,
    fontSize: 13,
  },
  scroll: {
    paddingHorizontal: spacing.xxl,
    paddingBottom: 88,
  },
  desktopScroll: { paddingHorizontal: spacing.section, paddingBottom: spacing.huge },
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
  title: {
    ...typography.readerTitle,
  },
  desktopTitle: { fontSize: 30, lineHeight: 39 },
  titleTextGroup: {
    flex: 1,
    minWidth: 0,
  },
  preprocessingCard: {
    marginBottom: spacing.xxxl,
  },
  articleSummary: {
    fontSize: 15,
    lineHeight: 24,
  },
  articleSummaryCard: { paddingHorizontal: spacing.xl, paddingVertical: spacing.lg, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.panel },
  articleSummaryHeader: { marginBottom: spacing.md, flexDirection: 'row', alignItems: 'center' },
  articleSummaryIcon: { width: 26, height: 26, marginRight: spacing.md, borderRadius: radius.control, alignItems: 'center', justifyContent: 'center' },
  articleSummaryLabel: { ...typography.metadata, fontWeight: '700', letterSpacing: 0.2 },
  articleTagsAfterSummary: {
    marginTop: spacing.md,
  },
  articleTags: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  articleTag: { minHeight: 24, paddingHorizontal: spacing.md, paddingVertical: 3, borderRadius: radius.small, justifyContent: 'center' },
  articleTagText: {
    ...typography.metadata,
    fontWeight: '500',
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
    fontWeight: '600',
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  leadingHeaderActions: { flexDirection: 'row', alignItems: 'center' },
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
    ...typography.metadata,
    marginTop: 12,
    marginBottom: spacing.xxxl,
  },
  articleBody: {
    paddingTop: 2,
  },
  parsingNotice: {
    marginBottom: 20,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    flexDirection: 'row',
    alignItems: 'center',
  },
  parsingNoticeText: {
    flex: 1,
    marginLeft: 10,
  },
  parsingNoticeTitle: {
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '600',
  },
  parsingNoticeMessage: {
    marginTop: 2,
    fontSize: 12,
    lineHeight: 18,
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
  thinkingCard: {
    marginTop: 28,
    marginBottom: 64,
    minHeight: 72,
    paddingHorizontal: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
  },
  thinkingCardText: {
    flex: 1,
    marginLeft: 12,
  },
  thinkingCardTitle: {
    fontSize: 15,
    fontWeight: '600',
  },
  thinkingCardAction: {
    marginTop: 3,
    fontSize: 12,
  },
  actions: {
    position: 'absolute',
    left: 18,
    right: 18,
    bottom: 0,
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
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
  contentsBackdrop: {
    flex: 1,
    backgroundColor: colors.scrim,
    justifyContent: 'flex-end',
  },
  apiKeyBackdrop: {
    flex: 1,
    paddingHorizontal: 24,
    backgroundColor: 'rgba(0, 0, 0, 0.42)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  apiKeyPanel: {
    width: '100%',
    maxWidth: 420,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    padding: 20,
  },
  apiKeyTitle: {
    marginBottom: 16,
    fontSize: 17,
    lineHeight: 24,
    fontWeight: '700',
  },
  apiKeyInput: {
    height: 46,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingHorizontal: 12,
    fontSize: 15,
  },
  apiKeyActions: {
    marginTop: 14,
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  apiKeyButton: {
    minWidth: 70,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
  },
  apiKeyButtonText: {
    fontSize: 14,
    fontWeight: '600',
  },
  contentsPanel: {
    maxHeight: '72%',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingBottom: 24,
  },
  apiProviderOptions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 14,
  },
  apiProviderOption: {
    minHeight: 34,
    paddingHorizontal: 11,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  apiProviderOptionText: {
    fontSize: 12,
    fontWeight: '700',
  },
  readingSettingsPanel: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingHorizontal: 18,
    paddingBottom: 28,
  },
  desktopReaderPanel: { width: 420, maxHeight: '86%', alignSelf: 'flex-end', borderLeftWidth: StyleSheet.hairlineWidth, borderTopLeftRadius: radius.sheet, borderTopRightRadius: 0 },
  desktopContentsPanel: { width: 360 },
  readingSettingsLabel: {
    marginTop: spacing.xl,
    marginBottom: 10,
    fontSize: 12,
    fontWeight: '700',
  },
  fontOptions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 14,
  },
  fontOption: {
    width: '48%',
    minHeight: 42,
    paddingHorizontal: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 9,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  fontOptionText: {
    flexShrink: 1,
    fontSize: 13,
    fontWeight: '700',
  },
  readerStepperRow: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  readerStepperLabel: {
    fontSize: 14,
    fontWeight: '700',
  },
  readerStepperControls: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  readerStepperButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  readerStepperValue: {
    width: 58,
    fontSize: 13,
    textAlign: 'center',
  },
  readerSliderRow: {
    minHeight: 64,
    paddingTop: 8,
  },
  readerSliderHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  readerSliderValue: {
    fontSize: 13,
  },
  readerSliderTouchArea: {
    height: 34,
    justifyContent: 'center',
  },
  readerSliderTrack: {
    height: 6,
    borderRadius: 3,
  },
  readerSliderFill: {
    height: 6,
    borderRadius: 3,
  },
  readerSliderThumb: {
    position: 'absolute',
    top: -6,
    width: 18,
    height: 18,
    marginLeft: -9,
    borderRadius: 9,
  },
  contentsHeader: {
    height: 54,
    paddingLeft: 22,
    paddingRight: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  contentsTitle: {
    fontSize: 17,
    fontWeight: '600',
  },
  contentsList: {
    paddingHorizontal: 6,
  },
  contentsItem: {
    minHeight: 42,
    paddingRight: 16,
    justifyContent: 'center',
  },
  contentsItemText: {
    fontSize: 14,
    lineHeight: 20,
  },
  contentsItemTextActive: {
    fontWeight: '600',
  },
  contentsEmpty: {
    paddingHorizontal: 22,
    paddingVertical: 24,
    fontSize: 14,
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
