import { PropsWithChildren, useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import { ArticleDetailScreen } from '@/screens/ArticleDetailScreen';
import { useThemeColors } from '@/utils/theme';

type Props = PropsWithChildren<{ enabled: boolean; selectedArticleId: string | null; onCloseArticle: () => void }>;

export function DesktopArticleLayout({ enabled, children, selectedArticleId, onCloseArticle }: Props) {
  const colors = useThemeColors();
  const progress = useRef(new Animated.Value(selectedArticleId ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(progress, {
      toValue: selectedArticleId ? 1 : 0,
      duration: selectedArticleId ? 260 : 190,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [progress, selectedArticleId]);

  if (!enabled) return <>{children}</>;

  return (
    <View style={styles.root}>
      <View style={styles.list}>{children}</View>
      <Animated.View
        pointerEvents={selectedArticleId ? 'auto' : 'none'}
        style={[
          styles.detail,
          {
            width: progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '60%'] }),
            opacity: progress.interpolate({ inputRange: [0, 0.35, 1], outputRange: [0, 0, 1] }),
            borderLeftColor: colors.border,
          },
        ]}
      >
        {selectedArticleId ? <ArticleDetailScreen key={selectedArticleId} articleId={selectedArticleId} embedded onClose={onCloseArticle} /> : null}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, flexDirection: 'row', overflow: 'hidden' },
  list: { flex: 1, minWidth: 270 },
  detail: { height: '100%', overflow: 'hidden', borderLeftWidth: StyleSheet.hairlineWidth },
});
