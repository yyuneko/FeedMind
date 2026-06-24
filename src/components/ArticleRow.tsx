import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAppStore } from '@/store/appStore';
import type { Article } from '@/types';
import { colors, useThemeColors } from '@/utils/theme';
import { formatRelativeTime } from '@/utils/time';

type Props = {
  article: Article;
  onPress: () => void;
  onToggleStar: () => void;
  compact?: boolean;
};

export const ArticleRow = ({ article, onPress, onToggleStar, compact }: Props) => {
  const themeColors = useThemeColors();
  useAppStore((state) => state.languageMode);

  return (
    <Pressable style={[styles.row, { borderBottomColor: themeColors.border }, compact && styles.compactRow]} onPress={onPress}>
      <View style={[styles.dot, { backgroundColor: themeColors.blue }, article.isRead && styles.readDot]} />
      <View style={styles.body}>
        <Text style={[styles.title, { color: themeColors.text }, article.isRead && styles.readTitle]} numberOfLines={2}>
          {article.title}
        </Text>
        <Text style={[styles.meta, { color: themeColors.secondary }]} numberOfLines={1}>
          {article.feedTitle || 'Feed'} · {formatRelativeTime(article.publishedAt || article.createdAt)}
        </Text>
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
    marginTop: 8,
    color: colors.secondary,
    fontSize: 12,
  },
  star: {
    width: 38,
    paddingTop: 20,
    alignItems: 'flex-end',
  },
});
