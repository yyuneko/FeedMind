import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useAppStore } from '@/store/appStore';
import type { Article } from '@/types';
import { colors, useThemeColors } from '@/utils/theme';
import { formatRelativeTime } from '@/utils/time';
import { extractFirstContentImage, getFeedIconUrl } from '@/utils/html';
import { useIsDesktop } from '@/utils/responsive';

type Props = {
  article: Article;
  onPress: () => void;
  onToggleStar: () => void;
  compact?: boolean;
};

export const ArticleRow = ({ article, onPress, onToggleStar, compact }: Props) => {
  const themeColors = useThemeColors();
  const isDesktop = useIsDesktop();
  useAppStore((state) => state.languageMode);
  const publishedTime = article.publishedAt ? formatRelativeTime(article.publishedAt) : '';
  const meta = publishedTime ? (article.feedTitle || 'Feed') + ' · ' + publishedTime : article.feedTitle || 'Feed';
  const imageUrl = useMemo(() => extractFirstContentImage(article.contentHtml), [article.contentHtml]);
  const excerpt = useMemo(() => article.contentText.replace(/\s+/g, ' ').trim(), [article.contentText]);
  const feedIconUrl = getFeedIconUrl(article.feedSiteUrl, article.feedUrl);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [failedFeedIconUrl, setFailedFeedIconUrl] = useState<string | null>(null);

  return (
    <Pressable
      style={({ pressed }) => [
        styles.row,
        { borderBottomColor: themeColors.border },
        compact && styles.compactRow,
        isDesktop && styles.desktopRow,
        isDesktop && pressed && { backgroundColor: themeColors.page },
      ]}
      onPress={onPress}
    >
      <View style={[styles.dot, isDesktop && styles.desktopDot, { backgroundColor: themeColors.blue }, article.isRead && styles.readDot]} />
      <View style={[styles.body, isDesktop && styles.desktopBody]}>
        <Text style={[styles.title, isDesktop && styles.desktopTitle, { color: themeColors.text }, article.isRead && styles.readTitle]} numberOfLines={2}>
          {article.title}
        </Text>
        {isDesktop && excerpt ? (
          <Text style={[styles.excerpt, { color: themeColors.secondary }]} numberOfLines={2}>
            {excerpt}
          </Text>
        ) : null}
        <View style={[styles.metaRow, isDesktop && styles.desktopMetaRow]}>
          <View style={[styles.feedAvatar, { backgroundColor: themeColors.page }]}>
            {feedIconUrl && feedIconUrl !== failedFeedIconUrl
              ? <Image source={{ uri: feedIconUrl }} style={styles.feedAvatarImage} contentFit="contain" onError={() => setFailedFeedIconUrl(feedIconUrl)} />
              : <Ionicons name="logo-rss" size={9} color={themeColors.secondary} />}
          </View>
          <Text style={[styles.meta, { color: themeColors.secondary }]} numberOfLines={1}>
            {meta}
          </Text>
        </View>
      </View>
      <View style={[styles.thumbnail, isDesktop && styles.desktopThumbnail, { backgroundColor: themeColors.page }]}>
        {imageUrl && imageUrl !== failedUrl
          ? <Image source={{ uri: imageUrl }} style={styles.thumbnailImage} contentFit="cover" onError={() => setFailedUrl(imageUrl)} />
          : <Ionicons name="image-outline" size={isDesktop ? 28 : 23} color={themeColors.subtle} />}
      </View>
      <Pressable style={[styles.star, isDesktop && styles.desktopStar]} onPress={onToggleStar} hitSlop={12}>
        <Ionicons name={article.isStarred ? 'star' : 'star-outline'} size={19} color={themeColors.text} />
      </Pressable>
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
    minHeight: 132,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderBottomWidth: 0,
    marginBottom: 8,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: colors.blue,
    marginRight: 14,
    marginTop: 24,
  },
  desktopDot: {
    marginTop: 28,
  },
  readDot: {
    backgroundColor: 'transparent',
  },
  body: {
    flex: 1,
    paddingVertical: 14,
  },
  desktopBody: {
    paddingVertical: 22,
    paddingRight: 18,
  },
  title: {
    color: colors.text,
    fontSize: 15,
    lineHeight: 21,
    fontWeight: '700',
  },
  desktopTitle: {
    fontSize: 18,
    lineHeight: 25,
  },
  readTitle: {
    fontWeight: '500',
  },
  excerpt: {
    marginTop: 8,
    fontSize: 14,
    lineHeight: 21,
  },
  meta: {
    color: colors.secondary,
    fontSize: 12,
  },
  metaRow: {
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
  },
  desktopMetaRow: {
    marginTop: 12,
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
  star: {
    width: 30,
    paddingTop: 20,
    alignItems: 'flex-end',
  },
  desktopStar: {
    paddingTop: 24,
    paddingRight: 4,
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
  desktopThumbnail: {
    width: 132,
    height: 92,
    borderRadius: 10,
    marginTop: 20,
    marginLeft: 0,
  },
  thumbnailImage: {
    width: '100%',
    height: '100%',
  },
});