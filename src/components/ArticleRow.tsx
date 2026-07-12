import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useAppStore } from '@/store/appStore';
import type { Article } from '@/types';
import { colors, useThemeColors } from '@/utils/theme';
import { formatRelativeTime } from '@/utils/time';
import { extractFirstContentImage, getFeedIconUrl } from '@/utils/html';

type Props = {
  article: Article;
  onPress: () => void;
  onToggleStar: () => void;
  compact?: boolean;
};

export const ArticleRow = ({ article, onPress, onToggleStar, compact }: Props) => {
  const themeColors = useThemeColors();
  useAppStore((state) => state.languageMode);
  const publishedTime = article.publishedAt ? formatRelativeTime(article.publishedAt) : '';
  const meta = publishedTime ? (article.feedTitle || 'Feed') + ' · ' + publishedTime : article.feedTitle || 'Feed';
  const imageUrl = useMemo(
    () => article.thumbnailUrl || extractFirstContentImage(article.contentHtml || ''),
    [article.thumbnailUrl, article.contentHtml],
  );
  const feedIconUrl = getFeedIconUrl(article.feedSiteUrl, article.feedUrl);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [failedFeedIconUrl, setFailedFeedIconUrl] = useState<string | null>(null);

  return (
    <Pressable style={[styles.row, { borderBottomColor: themeColors.border }, compact && styles.compactRow]} onPress={onPress}>
      <View style={[styles.dot, { backgroundColor: themeColors.blue }, article.isRead && styles.readDot]} />
      <View style={styles.body}>
        <Text style={[styles.title, { color: themeColors.text }, article.isRead && styles.readTitle]} numberOfLines={2}>
          {article.title}
        </Text>
        <View style={styles.metaRow}>
          <View style={[styles.feedAvatar, { backgroundColor: themeColors.page }]}>
            {feedIconUrl && feedIconUrl !== failedFeedIconUrl
              ? <Image source={{ uri: feedIconUrl }} style={styles.feedAvatarImage} contentFit={'contain'} onError={() => setFailedFeedIconUrl(feedIconUrl)} />
              : <Ionicons name={'logo-rss'} size={9} color={themeColors.secondary} />}
          </View>
          <Text style={[styles.meta, { color: themeColors.secondary }]} numberOfLines={1}>
            {meta}
          </Text>
        </View>
      </View>
      <View style={[styles.thumbnail, { backgroundColor: themeColors.page }]}>
        {imageUrl && imageUrl !== failedUrl
          ? <Image source={{ uri: imageUrl }} style={styles.thumbnailImage} contentFit={'cover'} onError={() => setFailedUrl(imageUrl)} />
          : <Ionicons name={'image-outline'} size={23} color={themeColors.subtle} />}
      </View>
      <Pressable style={styles.star} onPress={onToggleStar} hitSlop={12}>
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
    color: colors.secondary,
    fontSize: 12,
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
  star: {
    width: 30,
    paddingTop: 20,
    alignItems: 'flex-end',
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
