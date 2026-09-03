import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useAppStore } from '@/store/appStore';
import type { Article } from '@/types';
import { colors, radius, spacing, typography, useThemeColors } from '@/utils/theme';
import { formatArticleListTime } from '@/utils/time';
import { extractFirstContentImage, getFeedIconUrl, resolveArticleUrl } from '@/utils/html';
import { useDesktopLayout } from '@/hooks/useDesktopLayout';
import { getArticleDisplayTitle } from '@/utils/articlePresentation';
import { t } from '@/i18n';

type Props = {
  article: Article;
  onPress: () => void;
  onToggleStar: () => void;
  onDelete?: () => void;
  compact?: boolean;
  hidePreviewActions?: boolean;
  hideFeedName?: boolean;
  selected?: boolean;
  query?: string;
  onTagPress?: (tag: NonNullable<Article['topicTags']>[number]) => void;
};

export const ArticleRow = ({ article, onPress, onToggleStar, onDelete, onTagPress, compact, hidePreviewActions = false, hideFeedName = false, selected = false, query = '' }: Props) => {
  const themeColors = useThemeColors();
  const desktop = useDesktopLayout();
  useAppStore((state) => state.languageMode);
  const publishedTime = formatArticleListTime(article.publishedAt || article.createdAt);
  const meta = hideFeedName
    ? publishedTime
    : publishedTime ? `${article.feedTitle || 'Feed'} · ${publishedTime}` : article.feedTitle || 'Feed';
  const imageUrl = useMemo(
    () => resolveArticleUrl(article.thumbnailUrl || extractFirstContentImage(article.contentHtml || '') || '', article.url ?? undefined),
    [article.thumbnailUrl, article.contentHtml, article.url],
  );
  const feedIconUrl = getFeedIconUrl(article.feedSiteUrl, article.feedUrl);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [failedFeedIconUrl, setFailedFeedIconUrl] = useState<string | null>(null);
  const displayTitle = getArticleDisplayTitle(article);
  const summary = article.oneLineSummary?.trim();
  const topicTags = article.topicTags?.filter((tag) => tag.name.trim()) ?? [];

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${displayTitle}${meta ? `，${meta}` : ''}`}
      accessibilityState={{ selected }}
      style={({ hovered, pressed }: any) => [
        styles.row,
        { borderBottomColor: themeColors.border },
        compact && styles.compactRow,
        desktop && styles.desktopRow,
        selected && { backgroundColor: themeColors.selected },
        desktop && !selected && hovered && { backgroundColor: themeColors.hover },
        pressed && { backgroundColor: themeColors.pressed },
      ]}
      onPress={onPress}
    >
      <View style={[styles.dot, { backgroundColor: themeColors.blue }, article.isRead && styles.readDot]} />
      <View style={styles.body}>
        <HighlightedText value={displayTitle} query={query} numberOfLines={2} style={[styles.title, { color: selected ? themeColors.blue : themeColors.text }, article.isRead && styles.readTitle]} />
        {!compact && summary ? <View style={styles.summarySlot}><HighlightedText value={summary} query={query} numberOfLines={1} style={[styles.summary, { color: themeColors.secondary }]} /></View> : null}
        {topicTags.length > 0 && (
          <View style={styles.tags} accessibilityLabel={topicTags.map((tag) => tag.name).join('，')}>
            {topicTags.map((tag) => (
              <Pressable key={tag.key} accessibilityRole={onTagPress ? 'button' : undefined} accessibilityLabel={onTagPress ? t('filterByTag', { name: tag.name }) : undefined}
                style={({ hovered, pressed }: any) => [styles.tag, { backgroundColor: themeColors.page }, hovered && onTagPress && { backgroundColor: themeColors.hover }, pressed && onTagPress && styles.tagPressed]}
                onPress={onTagPress ? (event) => { event.stopPropagation(); onTagPress(tag); } : undefined}>
                <Text style={[styles.tagText, { color: themeColors.secondary }]} numberOfLines={1}>{tag.name}</Text>
              </Pressable>
            ))}
          </View>
        )}
        <View style={styles.metaRow}>
          {!hideFeedName && <View style={[styles.feedAvatar, { backgroundColor: themeColors.page }]}>
            {feedIconUrl && feedIconUrl !== failedFeedIconUrl
              ? <Image source={{ uri: feedIconUrl }} style={styles.feedAvatarImage} contentFit={'contain'} onError={() => setFailedFeedIconUrl(feedIconUrl)} />
              : <Ionicons name={'logo-rss'} size={9} color={themeColors.secondary} />}
          </View>}
          <Text style={[styles.meta, { color: themeColors.secondary }]} numberOfLines={1}>
            {meta}
          </Text>
        </View>
      </View>
      {!hidePreviewActions ? <View style={styles.previewActions}>
        <View style={[styles.thumbnail, { backgroundColor: themeColors.page }]}>
          {imageUrl && imageUrl !== failedUrl ? <Image source={{ uri: imageUrl }} style={styles.thumbnailImage} contentFit="cover" onError={() => setFailedUrl(imageUrl)} /> : <Ionicons name="newspaper-outline" size={20} color={themeColors.disabled} />}
        </View>
        <Pressable accessibilityLabel={article.isStarred ? t('saved') : t('collect')} hitSlop={8} style={styles.star} onPress={(event) => { event.stopPropagation(); onToggleStar(); }}><Ionicons name={article.isStarred ? 'bookmark' : 'bookmark-outline'} size={16} color={article.isStarred ? themeColors.blue : themeColors.secondary} /></Pressable>
        {article.isSelected && onDelete ? <Pressable accessibilityLabel={t('deleteArticle')} hitSlop={8} style={styles.star} onPress={(event) => { event.stopPropagation(); onDelete(); }}><Ionicons name="trash-outline" size={16} color={themeColors.destructive} /></Pressable> : null}
      </View> : null}
    </Pressable>
  );
};

function HighlightedText({ value, query, style, numberOfLines }: { value: string; query: string; style: any; numberOfLines: number }) {
  const colors = useThemeColors(); const needle = query.trim().toLocaleLowerCase();
  if (!needle) return <Text style={style} numberOfLines={numberOfLines}>{value}</Text>;
  const parts: Array<{ text: string; match: boolean }> = []; let cursor = 0; const lower = value.toLocaleLowerCase();
  for (;;) { const index = lower.indexOf(needle, cursor); if (index < 0) break; if (index > cursor) parts.push({ text: value.slice(cursor, index), match: false }); parts.push({ text: value.slice(index, index + needle.length), match: true }); cursor = index + needle.length; }
  if (cursor < value.length) parts.push({ text: value.slice(cursor), match: false });
  return <Text style={style} numberOfLines={numberOfLines}>{parts.map((part, index) => <Text key={`${index}:${part.text}`} style={part.match ? { backgroundColor: colors.pill, color: colors.text } : undefined}>{part.text}</Text>)}</Text>;
}

const styles = StyleSheet.create({
  row: {
    minHeight: 68,
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  compactRow: {
    minHeight: 64,
  },
  desktopRow: {
    minHeight: 68,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.control,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.blue,
    marginRight: spacing.lg,
    marginTop: 17,
  },
  readDot: {
    backgroundColor: 'transparent',
  },
  body: {
    flex: 1,
    minWidth: 0,
    paddingVertical: spacing.md,
  },
  title: {
    color: colors.text,
    ...typography.listTitle,
  },
  readTitle: {
    fontWeight: '400',
    opacity: 0.78,
  },
  tagPressed: { opacity: 0.55 },
  summary: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '400',
  },
  summarySlot: { height: 18, marginTop: spacing.xxs, overflow: 'hidden' },
  tags: { marginTop: spacing.xs, flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  tag: { maxWidth: 120, minHeight: 18, paddingHorizontal: spacing.sm, paddingVertical: 1, borderRadius: radius.small, justifyContent: 'center' },
  tagText: { fontSize: 11, lineHeight: 15, fontWeight: '500' },
  meta: {
    flex: 1,
    minWidth: 0,
    color: colors.secondary,
    ...typography.metadata,
  },
  metaRow: {
    marginTop: spacing.xs,
    flexDirection: 'row',
    alignItems: 'center',
  },
  feedAvatar: {
    width: 16,
    height: 16,
    borderRadius: radius.small,
    marginRight: spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  feedAvatarImage: {
    width: 16,
    height: 16,
  },
  previewActions: {
    marginTop: spacing.md,
    marginLeft: spacing.lg,
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  thumbnail: {
    width: 52,
    height: 52,
    borderRadius: radius.control,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  thumbnailImage: {
    width: '100%',
    height: '100%',
  },
  star: { width: 28, height: 28, marginLeft: spacing.sm, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
});
