import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { Article } from '@/types';
import { colors } from '@/utils/theme';
import { formatRelativeTime } from '@/utils/time';

type Props = {
  article: Article;
  onPress: () => void;
  onToggleStar: () => void;
  compact?: boolean;
};

export const ArticleRow = ({ article, onPress, onToggleStar }: Props) => (
  <Pressable style={styles.row} onPress={onPress}>
    <View style={[styles.dot, article.isRead && styles.readDot]} />
    <View style={styles.body}>
      <Text style={[styles.title, article.isRead && styles.readTitle]} numberOfLines={2}>
        {article.title}
      </Text>
      <Text style={styles.meta} numberOfLines={1}>
        {article.feedTitle || 'Feed'} · {formatRelativeTime(article.publishedAt || article.createdAt)}
      </Text>
      <Text style={styles.summary} numberOfLines={2}>
        {article.contentText}
      </Text>
    </View>
    <Pressable style={styles.star} onPress={onToggleStar} hitSlop={12}>
      <Ionicons name={article.isStarred ? 'star' : 'star-outline'} size={19} color={article.isStarred ? colors.text : colors.text} />
    </Pressable>
  </Pressable>
);

const styles = StyleSheet.create({
  row: {
    minHeight: 118,
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.blue,
    marginRight: 16,
    marginTop: 22,
  },
  readDot: {
    backgroundColor: 'transparent',
  },
  body: {
    flex: 1,
    paddingVertical: 16,
  },
  title: {
    color: colors.text,
    fontSize: 16,
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
  summary: {
    marginTop: 8,
    color: colors.secondary,
    fontSize: 13,
    lineHeight: 19,
  },
  star: {
    width: 42,
    paddingTop: 18,
    alignItems: 'flex-end',
  },
});
