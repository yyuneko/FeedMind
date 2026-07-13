import * as Clipboard from 'expo-clipboard';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, LayoutAnimation, Linking, Modal, NativeScrollEvent, NativeSyntheticEvent, PanResponder, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, UIManager, View, useColorScheme } from 'react-native';
import ImageView from '@/components/ImageViewer';
import RenderHtml, { defaultSystemFonts, HTMLContentModel, HTMLElementModel, type MixedStyleDeclaration } from 'react-native-render-html';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ActionPill } from '@/components/ActionPill';
import { ArticleCodeBlock } from '@/components/ArticleCodeBlock';
import { ArticleMedia } from '@/components/ArticleMedia';
import { IconButton } from '@/components/IconButton';
import { QueryState } from '@/components/QueryState';
import { articleRepo, promptRepo } from '@/api/repositories';
import { updatePreferences } from '@/api/preferences';
import { settingsRepo, translationRepo } from '@/db/repositories';
import { t } from '@/i18n';
import { translateArticle } from '@/services/translate';
import { credentialStore, DEEPSEEK_PROVIDER_ID } from '@/ai/credentials';
import { useAppStore } from '@/store/appStore';
import type { Prompt, ReaderFont, ReadingMode } from '@/types';
import { addArticleHeadingIds, extractArticleHeadings, hasArticleMedia, sanitizeArticleHtml, stripHtml, type ArticleHeading } from '@/utils/html';
import { applyTranslationPlan, createTranslationPlan, hashText, isStoredTranslationValid, parseStoredTranslation, removeImagesFromHtml, splitTopLevelHtml } from '@/utils/translationHtml';
import { colors, getReaderColors } from '@/utils/theme';
import { useReaderFontFamilies } from '@/utils/readerFonts';
import { formatArticleDate } from '@/utils/time';
import { useDesktopLayout } from '@/hooks/useDesktopLayout';
import { screenStyles } from './screenStyles';

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
  iframe: HTMLElementModel.fromCustomModel({ tagName: 'iframe', contentModel: HTMLContentModel.block }),
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
  console.log('codeNode: ', codeNode);
  const className = String(codeNode?.attributes?.class ?? codeNode?.attributes?.className ?? codeNode?.domNode?.getAttribute?.('class') ?? '');
  return className.match(/(?:^|\s)(?:language|lang)-([a-z0-9_+#.-]+)(?:\s|$)/i)?.[1]?.toLowerCase();
};
type ArticleDetailScreenProps = { articleId?: string; embedded?: boolean; onClose?: () => void };

export function ArticleDetailScreen({ articleId, embedded = false, onClose }: ArticleDetailScreenProps = {}) {
  const params = useLocalSearchParams<{ id: string }>();
  const id = articleId ?? params.id ?? '';
  const queryClient = useQueryClient();
  const systemDark = useColorScheme() === 'dark';
  const desktop = useDesktopLayout();
  const { readingMode, setReadingMode, fontSize, setFontSize, lineHeightRatio, setLineHeightRatio, readerFont, setReaderFont, themeMode, selectedPromptId } = useAppStore();
  const readerFontFamilies = useReaderFontFamilies(readerFont);
  const readerColors = getReaderColors(themeMode, systemDark);
  const codeThemeDark = themeMode === 'dark' || (themeMode === 'system' && systemDark);
  const inlineCodeBackgroundColor = desktop
    ? readerColors.page
    : codeThemeDark ? '#30343B' : '#E9EDF3';
  const bilingualOriginalBackgroundColor = desktop
    ? codeThemeDark ? '#252A31' : '#EEF2F7'
    : readerColors.page;
  const [paneSize, setPaneSize] = useState({ width: 0, height: 0 });
  const [contentWidth, setContentWidth] = useState(1);
  const scrollRef = useRef<ScrollView>(null);
  const abortControllersRef = useRef(new Map<string, AbortController>());
  const autoTranslateKeyRef = useRef('');
  const pendingTranslateRef = useRef(false);
  const translationWorkFrameRef = useRef<number | null>(null);
  const readMarkedRef = useRef(false);
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
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [activeHeadingId, setActiveHeadingId] = useState('');
  const activeHeadingIdRef = useRef('');
  const headingOffsetsRef = useRef<Record<string, number>>({});
  const headingContainerOffsetsRef = useRef<Record<string, number>>({});
  const articleBodyOffsetRef = useRef(0);

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
    refetchInterval: (query) => {
      const status = query.state.data?.parseStatus;
      return status === 'pending' || status === 'parsing' ? 1000 : false;
    },
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
    pendingTranslateRef.current = false;
    if (translationWorkFrameRef.current !== null) cancelAnimationFrame(translationWorkFrameRef.current);
    translationWorkFrameRef.current = null;
    setTranslationWorkEnabled(false);
    headerCollapsedRef.current = false;
    setReadingMode('original');
    setIsHeaderCollapsed(false);
    setMenuVisible(false);
    setReadingSettingsVisible(false);
    setRepairFailed(false);
  }, [id, setReadingMode]);

  useEffect(() => () => {
    if (translationWorkFrameRef.current !== null) cancelAnimationFrame(translationWorkFrameRef.current);
  }, []);

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
    mutationFn: async ({ requestKey }: { requestKey: string }) => {
      const item = article.data;
      const plan = translationPlan;
      if (!item || !defaultPrompt || !plan) throw new Error(t('promptRequired'));
      const controller = new AbortController();
      abortControllersRef.current.set(requestKey, controller);
      try {
        return await translateArticle({
          articleId: item.id,
          title: item.title,
          blocks: plan.blocks,
          sourceHash: plan.sourceHash,
          sourceHtml: plan.sourceHtml,
          promptId: defaultPrompt.id,
          prompt: defaultPrompt.content,
          promptHash: hashText(defaultPrompt.content),
          signal: controller.signal,
        });
      } finally {
        if (abortControllersRef.current.get(requestKey) === controller) {
          abortControllersRef.current.delete(requestKey);
        }
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
  const renderedOriginalHtml = useMemo(() => addArticleHeadingIds(normalizedContentHtml), [normalizedContentHtml]);
  const originalHeadings = useMemo(() => extractArticleHeadings(renderedOriginalHtml), [renderedOriginalHtml]);
  const translationPlan = useMemo(
    () => translationWorkEnabled ? createTranslationPlan(normalizedContentHtml) : null,
    [normalizedContentHtml, translationWorkEnabled],
  );
  const promptHash = useMemo(() => hashText(defaultPrompt?.content ?? ''), [defaultPrompt?.content]);
  const storedTranslation = useMemo(() => {
    if (!translationPlan) return null;
    const parsed = parseStoredTranslation(translated);
    return parsed && isStoredTranslationValid(parsed, { sourceHash: translationPlan.sourceHash, promptHash }) ? parsed : null;
  }, [promptHash, translated, translationPlan]);
  const translatedHtml = useMemo(() => {
    if (!storedTranslation || !translationPlan) return '';
    try { return applyTranslationPlan(translationPlan, storedTranslation.blocks); } catch { return ''; }
  }, [storedTranslation, translationPlan]);
  const renderedTranslatedHtml = useMemo(() => addArticleHeadingIds(translatedHtml), [translatedHtml]);
  const translatedHeadings = useMemo(() => extractArticleHeadings(renderedTranslatedHtml), [renderedTranslatedHtml]);
  const headings = readingMode === 'original' ? originalHeadings : translatedHeadings;
  const highlightedHeadingId = activeHeadingId || headings[0]?.id || '';
  const originalBlocks = useMemo(() => translationPlan ? splitTopLevelHtml(translationPlan.sourceHtml) : [], [translationPlan]);
  const translatedBlocks = useMemo(() => renderedTranslatedHtml ? splitTopLevelHtml(renderedTranslatedHtml).map(removeImagesFromHtml) : [], [renderedTranslatedHtml]);
  const translatedTitle = storedTranslation?.title.trim() ?? '';
  const articleTitle = readingMode === 'original' ? item?.title ?? '' : translatedTitle || (item?.title ?? '');
  const translationAligned = Boolean(storedTranslation && translatedHtml);
  const translationRequestKey = `${id}:${defaultPrompt?.id ?? ''}`;
  const isCurrentTranslationPending = translate.isPending && translate.variables?.requestKey === translationRequestKey;
  const isCurrentTranslationError = translate.isError && translate.variables?.requestKey === translationRequestKey;
  const isTranslationLoading = readingMode !== 'original' && (!translationWorkEnabled || translation.isFetching || isCurrentTranslationPending);
  const isArticleParsing = item?.parseStatus === 'pending' || item?.parseStatus === 'parsing';
  const hasReadableBody = Boolean(item?.contentText.trim()) && item?.contentText.trim() !== item?.title.trim();
  const hasRenderableBody = hasReadableBody || hasArticleMedia(normalizedContentHtml);
  const lineHeight = Math.round(fontSize * lineHeightRatio);
  const htmlBaseStyle = useMemo(() => ({
    color: readerColors.text,
    fontSize,
    lineHeight,
    fontFamily: readerFontFamilies.regular,
  }), [fontSize, lineHeight, readerColors.text, readerFontFamilies.regular]);
  const tagsStyles = useMemo<Record<string, MixedStyleDeclaration>>(() => ({
    body: { color: readerColors.text, backgroundColor: readerColors.background, fontFamily: readerFontFamilies.regular },
    h1: { fontSize: fontSize * 1.55, lineHeight: Math.round(lineHeight * 1.35), fontFamily: readerFontFamilies.bold, fontWeight: readerFontFamilies.bold ? 'normal' as const : '800' as const, marginTop: 12, marginBottom: 6 },
    h2: { fontSize: fontSize * 1.28, lineHeight: Math.round(lineHeight * 1.15), fontFamily: readerFontFamilies.bold, fontWeight: readerFontFamilies.bold ? 'normal' as const : '800' as const, marginTop: 14, marginBottom: 5 },
    h3: { fontSize: fontSize * 1.12, lineHeight: Math.round(lineHeight * 1.02), fontFamily: readerFontFamilies.bold, fontWeight: readerFontFamilies.bold ? 'normal' as const : '800' as const, marginTop: 14, marginBottom: 4 },
    h4: { fontSize, lineHeight, fontFamily: readerFontFamilies.bold, fontWeight: readerFontFamilies.bold ? 'normal' as const : '800' as const, marginTop: 14, marginBottom: 4 },
    h5: { fontSize: fontSize * 0.94, lineHeight, fontFamily: readerFontFamilies.bold, fontWeight: readerFontFamilies.bold ? 'normal' as const : '800' as const, marginTop: 14, marginBottom: 4 },
    h6: { fontSize: fontSize * 0.88, lineHeight, fontFamily: readerFontFamilies.bold, fontWeight: readerFontFamilies.bold ? 'normal' as const : '800' as const, marginTop: 14, marginBottom: 4 },
    p: { marginTop: 0, marginBottom: 10 },
    ul: { marginTop: 2, marginBottom: 10, paddingLeft: 22 },
    ol: { marginTop: 2, marginBottom: 10, paddingLeft: 22 },
    li: { marginBottom: 2 },
    strong: { fontFamily: readerFontFamilies.bold, fontWeight: readerFontFamilies.bold ? 'normal' as const : 'bold' as const },
    b: { fontFamily: readerFontFamilies.bold, fontWeight: readerFontFamilies.bold ? 'normal' as const : 'bold' as const },
    a: { color: readerColors.blue, textDecorationLine: 'none' as const },
    sup: {
      color: readerColors.blue,
      fontSize: Math.max(9, Math.round(fontSize * 0.65)),
      lineHeight: Math.max(11, Math.round(lineHeight * 0.65)),
      verticalAlign: 'top' as const,
    },
    mark: { backgroundColor: systemDark ? '#6B5714' : '#FFF0A6', color: readerColors.text, borderRadius: 3 },
    blockquote: { backgroundColor: systemDark ? '#18212C' : '#EEF5FF', borderLeftWidth: 3, borderLeftColor: readerColors.blue, borderRadius: 6, paddingHorizontal: 14, paddingVertical: 8, marginVertical: 10, color: readerColors.secondary },
    pre: { marginVertical: 0 },
    code: { fontFamily: Platform.select({ web: 'ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace', ios: 'Menlo', default: 'monospace' }), backgroundColor: inlineCodeBackgroundColor, fontSize: fontSize * 0.875, paddingHorizontal: 5, paddingVertical: 3, borderRadius: 6 },
    table: { backgroundColor: readerColors.background },
    th: { borderWidth: StyleSheet.hairlineWidth, borderColor: readerColors.border, backgroundColor: readerColors.page, paddingHorizontal: 10, paddingVertical: 7, fontFamily: readerFontFamilies.bold, fontWeight: readerFontFamilies.bold ? 'normal' as const : '800' as const },
    td: { borderWidth: StyleSheet.hairlineWidth, borderColor: readerColors.border, paddingHorizontal: 10, paddingVertical: 7 },
    figure: { marginVertical: 10, marginHorizontal: 0 },
    figcaption: { color: readerColors.secondary, fontSize: fontSize * 0.82, lineHeight: Math.round(lineHeight * 0.82), textAlign: 'center' as const, marginTop: 2 },
    hr: { height: StyleSheet.hairlineWidth, backgroundColor: readerColors.border, marginVertical: 16 },
  }), [fontSize, inlineCodeBackgroundColor, lineHeight, readerColors, readerFontFamilies.bold, readerFontFamilies.regular, systemDark]);
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
          poster={String(tnode.attributes.poster ?? '')}
          width={contentWidth}
        />
      ),
      iframe: ({ tnode }: any) => (
        <ArticleMedia
          kind="embed"
          uri={String(tnode.attributes.src ?? '')}
          width={contentWidth}
        />
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
      table: ({ TDefaultRenderer, ...props }: any) => (
        <ScrollView horizontal showsHorizontalScrollIndicator>
          <TDefaultRenderer {...props} />
        </ScrollView>
      ),
    });
  }, [codeThemeDark, contentWidth, fontSize, lineHeight, readerColors]);
  const requestTranslate = useCallback(async () => {
    if (!translationPlan) {
      pendingTranslateRef.current = true;
      setTranslationWorkEnabled(true);
      return;
    }
    const apiKey = (await credentialStore.get(DEEPSEEK_PROVIDER_ID))?.trim();
    if (!apiKey) {
      setApiKeyInput('');
      setApiKeyVisible(true);
      return;
    }
    translate.mutate({ requestKey: translationRequestKey });
  }, [translate, translationPlan, translationRequestKey]);

  useEffect(() => {
    if (!pendingTranslateRef.current || !translationPlan) return;
    pendingTranslateRef.current = false;
    requestTranslate();
  }, [requestTranslate, translationPlan]);
  const submitApiKey = async () => {
    const apiKey = apiKeyInput.trim();
    if (!apiKey) return;
    try {
      await credentialStore.set(DEEPSEEK_PROVIDER_ID, apiKey);
      setApiKeyVisible(false);
      setApiKeyInput('');
      translate.mutate({ requestKey: translationRequestKey });
    } catch {
      Alert.alert(t('checkConfig'));
    }
  };
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
  const changeReadingMode = useCallback(() => {
    const next = readingModes[(readingModes.indexOf(readingMode) + 1) % readingModes.length];
    autoTranslateKeyRef.current = '';
    pendingTranslateRef.current = false;
    if (translationWorkFrameRef.current !== null) cancelAnimationFrame(translationWorkFrameRef.current);
    setTranslationWorkEnabled(false);
    setReadingMode(next);
    if (next === 'original') {
      translationWorkFrameRef.current = null;
      return;
    }
    translationWorkFrameRef.current = requestAnimationFrame(() => {
      translationWorkFrameRef.current = requestAnimationFrame(() => {
        translationWorkFrameRef.current = null;
        setTranslationWorkEnabled(true);
      });
    });
  }, [readingMode, setReadingMode]);
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
    if (!isHeaderCollapsed && menuVisible) {
      configureTransition();
      setMenuVisible(false);
    }
  }, [isHeaderCollapsed, menuVisible]);

  useEffect(() => {
    if (readingMode === 'original' || !translationWorkEnabled || !translationPlan || translation.isFetching || (translated && translationAligned) || isCurrentTranslationPending || !item || !defaultPrompt) return;
    const key = `${id}:${defaultPrompt.id}:${readingMode}:${translated && !translationAligned ? 'mismatch' : isCurrentTranslationError ? 'retry' : 'empty'}`;
    if (autoTranslateKeyRef.current === key) return;
    autoTranslateKeyRef.current = key;
    requestTranslate();
  }, [defaultPrompt, id, isCurrentTranslationError, isCurrentTranslationPending, item, readingMode, requestTranslate, translated, translation.isFetching, translationAligned, translationPlan, translationWorkEnabled]);


  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement, contentSize } = event.nativeEvent;
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
    if (ratio >= 0.3) markRead().catch(() => undefined);
    const now = Date.now();
    if (now - saveAtRef.current < 1000) return;
    saveAtRef.current = now;
    settingsRepo.set(progressKey(id), JSON.stringify({ y: contentOffset.y, ratio })).catch(() => undefined);
  };

  const cancelTranslate = () => {
    abortControllersRef.current.get(translationRequestKey)?.abort();
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
        <IconButton name={embedded ? 'close' : 'chevron-back'} onPress={onClose ?? (() => router.back())} />
        <View style={{ flex: 1 }} />
        {isHeaderCollapsed && (
          <Pressable style={({ pressed }) => [styles.pinnedTitle, pressed && styles.pressed]} onPress={handlePinnedTitlePress}>
            <Text numberOfLines={1} style={[styles.pinnedTitleText, { color: readerColors.text, fontFamily: readerFontFamilies.bold, fontWeight: readerFontFamilies.bold ? 'normal' : '800' }]}>{articleTitle}</Text>
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
          <View style={styles.dot} />
          <Text style={[styles.title, { color: readerColors.text, fontFamily: readerFontFamilies.bold, fontWeight: readerFontFamilies.bold ? 'normal' : '800' }]}>{articleTitle}</Text>
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
        {isArticleParsing && (
          <View style={[styles.parsingNotice, { backgroundColor: readerColors.page, borderColor: readerColors.border }]}>
            <ActivityIndicator size="small" color={readerColors.blue} />
            <View style={styles.parsingNoticeText}>
              <Text style={[styles.parsingNoticeTitle, { color: readerColors.text }]}>{t('articleParsing')}</Text>
              <Text style={[styles.parsingNoticeMessage, { color: readerColors.secondary }]}>{t('articleParsingMessage')}</Text>
            </View>
          </View>
        )}
        <View
          style={styles.articleBody}
          onLayout={(event) => {
            const { width, y } = event.nativeEvent.layout;
            articleBodyOffsetRef.current = y;
            if (width <= 0) return;
            setContentWidth((current) => current === width ? current : width);
            setPaneSize((current) => {
              const paneWidth = width + 44;
              return current.width === paneWidth ? current : { ...current, width: paneWidth };
            });
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
                title={isArticleParsing ? t('articleParsing') : repairingContent ? t('repairBodyLoading') : repairFailed ? t('repairBodyFailed') : t('noText')}
                message={isArticleParsing ? t('articleParsingMessage') : t('repairBodyMessage')}
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
            <View style={styles.translateState}>
              <ActivityIndicator color={readerColors.blue} />
              <Text style={[styles.translateText, { color: readerColors.secondary }]}>{t('translationLoading')}</Text>
            </View>
          )}
          {isCurrentTranslationError && !(translate.error instanceof Error && translate.error.name === 'AbortError') && (
            <QueryState title={t('translateFailed')} message={translate.error instanceof Error ? translate.error.message : t('soonRetry')} actionLabel={t('retry')} onAction={requestTranslate} textColor={readerColors.text} secondaryColor={readerColors.secondary} />
          )}
        </View>
      </ScrollView>
      <View style={[styles.actions, { backgroundColor: readerColors.background }]}>
        {isCurrentTranslationPending ? (
          <ActionPill icon="close-circle-outline" label={t('cancel')} onPress={cancelTranslate} />
        ) : (
          <ActionPill icon="language-outline" label={t('translate')} onPress={requestTranslate} />
        )}
        <ActionPill icon="list-outline" label={t('contents')} onPress={() => setContentsVisible(true)} />
        <ActionPill icon="book-outline" label={t('readingSettings')} onPress={() => setReadingSettingsVisible(true)} />
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
      <Modal transparent visible={apiKeyVisible} animationType="fade" onRequestClose={() => setApiKeyVisible(false)}>
        <View style={styles.apiKeyBackdrop}>
          <View style={[styles.apiKeyPanel, { backgroundColor: readerColors.background, borderColor: readerColors.border }]}>
            <Text style={[styles.apiKeyTitle, { color: readerColors.text }]}>{t('apiKeyRequired')}</Text>
            <TextInput
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              value={apiKeyInput}
              onChangeText={setApiKeyInput}
              onSubmitEditing={submitApiKey}
              placeholder={t('apiKeyPlaceholder')}
              placeholderTextColor={readerColors.secondary}
              style={[styles.apiKeyInput, { color: readerColors.text, borderColor: readerColors.border, backgroundColor: readerColors.page }]}
            />
            <View style={styles.apiKeyActions}>
              <Pressable style={({ pressed }) => [styles.apiKeyButton, pressed && styles.pressed]} onPress={() => setApiKeyVisible(false)}>
                <Text style={[styles.apiKeyButtonText, { color: readerColors.secondary }]}>{t('cancel')}</Text>
              </Pressable>
              <Pressable disabled={!apiKeyInput.trim()} style={({ pressed }) => [styles.apiKeyButton, (!apiKeyInput.trim() || pressed) && styles.pressed]} onPress={submitApiKey}>
                <Text style={[styles.apiKeyButtonText, { color: readerColors.blue }]}>{t('confirm')}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
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
          <Pressable style={[styles.readingSettingsPanel, { backgroundColor: readerColors.background, borderColor: readerColors.border }]} onPress={(event) => event.stopPropagation()}>
            <View style={styles.contentsHeader}>
              <Text style={[styles.contentsTitle, { color: readerColors.text }]}>{t('readingSettings')}</Text>
              <IconButton name='close' onPress={() => setReadingSettingsVisible(false)} />
            </View>
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
          <Pressable style={[styles.contentsPanel, { backgroundColor: readerColors.background, borderColor: readerColors.border }]} onPress={(event) => event.stopPropagation()}>
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
  const [hidden, setHidden] = useState(false);
  if (!uri || hidden) return null;
  return (
    <Pressable style={styles.articleImageContainer} onPress={() => onPress(uri)}>
      <Image
        source={{ uri }}
        style={[styles.articleImage, { width, height: Math.round(width * 0.48) }]}
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
        return (
          <View key={`${index}-${item}`} style={styles.bilingualBlock} onLayout={(event) => onBlockLayout(index, event.nativeEvent.layout.y)}>
            <View style={[styles.bilingualOriginal, { backgroundColor: originalBackgroundColor }]}>
              <RenderHtml
                contentWidth={contentWidth}
                source={{ html: item }}
                systemFonts={articleSystemFonts}
                customHTMLElementModels={mediaElementModels}
                baseStyle={{ ...htmlBaseStyle, color: colors.secondary, fontSize: originalFontSize, lineHeight: originalLineHeight }}
                defaultTextProps={{ selectable: true }}
                tagsStyles={originalTagsStyles}
                renderers={renderers}
                renderersProps={renderersProps}
              />
            </View>
            {!!translation && <RenderHtml contentWidth={contentWidth} source={{ html: translation }} systemFonts={articleSystemFonts} customHTMLElementModels={mediaElementModels} baseStyle={htmlBaseStyle} defaultTextProps={{ selectable: true }} tagsStyles={tagsStyles} renderers={renderers} renderersProps={renderersProps} />}
            {!translation && hasText && isTranslationLoading && <Text style={[styles.bilingualTranslation, { color: colors.secondary, fontSize, lineHeight, fontFamily: typeof htmlBaseStyle.fontFamily === 'string' ? htmlBaseStyle.fontFamily : undefined, textIndent: `${fontSize * 2}px` }]}>{loadingText}</Text>}
          </View>
        );
      })}
    </View>
  );
};

const styles = StyleSheet.create({
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
    fontWeight: '800',
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
  contentsBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.35)',
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
    fontWeight: '800',
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
    fontWeight: '800',
  },
  contentsPanel: {
    maxHeight: '72%',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingBottom: 24,
  },
  readingSettingsPanel: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingHorizontal: 18,
    paddingBottom: 28,
  },
  readingSettingsLabel: {
    marginTop: 2,
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
    fontWeight: '800',
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
    fontWeight: '800',
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
