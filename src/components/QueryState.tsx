import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, useThemeColors } from '@/utils/theme';

type Props = {
  title: string;
  message?: string;
  actionLabel?: string;
  onAction?: () => void;
  textColor?: string;
  secondaryColor?: string;
};

export const QueryState = ({ title, message, actionLabel, onAction, textColor, secondaryColor }: Props) => {
  const themeColors = useThemeColors();

  return (
    <View style={styles.wrap}>
      <Text style={[styles.title, { color: textColor ?? themeColors.text }]}>{title}</Text>
      {!!message && <Text style={[styles.message, { color: secondaryColor ?? themeColors.secondary }]}>{message}</Text>}
      {!!actionLabel && !!onAction && (
        <Pressable style={[styles.action, { backgroundColor: themeColors.pill }]} onPress={onAction}>
          <Text style={[styles.actionText, { color: themeColors.blue }]}>{actionLabel}</Text>
        </Pressable>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: {
    paddingVertical: 48,
    alignItems: 'center',
  },
  title: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '700',
  },
  message: {
    marginTop: 8,
    color: colors.secondary,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
  },
  action: {
    marginTop: 16,
    height: 34,
    paddingHorizontal: 16,
    borderRadius: 17,
    backgroundColor: colors.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionText: {
    color: colors.blue,
    fontSize: 13,
    fontWeight: '700',
  },
});
