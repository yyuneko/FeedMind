import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useAppStore } from '@/store/appStore';
import type { Article } from '@/types';
import { colors, useThemeColors } from '@/utils/theme';
import { formatRelativeTime } from '@/utils/time';
import { extractFirstContentImage, getFeedIconUrl, resolveArticleUrl } from '@/utils/html';
import { useDesktopLayout } from '@/hooks/useDesktopLayout';

type Props = {
  article: Article;
  onPress: () => void;
  onToggleStar: () => void;
  compact?: boolean;
  hidePreviewActions?: boolean;
  hideFeedName?: boolean;
  selected?: boolean;
};

export const ArticleRow = ({ article, onPress, compact, hidePreviewActions = false, hideFeedName = false, selected = false }: Props) => {
  const themeColors = useThemeColors();
  const desktop = useDesktopLayout();
  useAppStore((state) => state.languageMode);
  const publishedTime = formatRelativeTime(article.publishedAt || article.createdAt);
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

  return (
    <Pressable accessibilityState={{ selected }} style={({ hovered, pressed }) => [styles.row, { borderBottomColor: themeColors.border }, compact && styles.compactRow, desktop && styles.desktopRow, selected && { backgroundColor: themeColors.pill }, desktop && !selected && (hovered || pressed) && { backgroundColor: themeColors.page }]} onPress={onPress}>
      <View style={[styles.dot, { backgroundColor: themeColors.blue }, article.isRead && styles.readDot]} />
      <View style={styles.body}>
        <Text style={[styles.title, { color: selected ? themeColors.blue : themeColors.text }, article.isRead && styles.readTitle]} numberOfLines={2}>
          {article.title}
        </Text>
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
      {!hidePreviewActions && <View style={[styles.thumbnail, { backgroundColor: themeColors.page }]}>
        {imageUrl && imageUrl !== failedUrl
          ? <Image source={{ uri: imageUrl }} style={styles.thumbnailImage} contentFit={'cover'} onError={() => setFailedUrl(imageUrl)} />
          : <Ionicons name={'image-outline'} size={23} color={themeColors.subtle} />}
      </View>}
    </Pressable>
  );
};

const styles = StyleSheet.create({
  row: {
    minHeight: 82,
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  compactRow: {
    minHeight: 88,
  },
  desktopRow: {
    minHeight: 92,
    paddingHorizontal: 12,
    borderRadius: 10,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: colors.blue,
    marginRight: 14,
    marginTop: 24,
  },
  readDot: {
    backgroundColor: 'transparent',
  },
  body: {
    flex: 1,
    minWidth: 0,
    paddingVertical: 14,
  },
  title: {
    color: colors.text,
    fontSize: 15,
    lineHeight: 21,
    fontWeight: '700',
  },
  readTitle: {
    fontWeight: '500',
  },
  meta: {
    flex: 1,
    minWidth: 0,
    color: colors.secondary,
    fontSize: 12,
    lineHeight: 16,
  },
  metaRow: {
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
  },
  feedAvatar: {
    width: 16,
    height: 16,
    borderRadius: 4,
    marginRight: 6,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  feedAvatarImage: {
    width: 16,
    height: 16,
  },
  thumbnail: {
    width: 64,
    height: 64,
    borderRadius: 8,
    marginTop: 9,
    marginLeft: 10,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  thumbnailImage: {
    width: '100%',
    height: '100%',
  },
});
