import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, typography, useThemeColors } from '@/utils/theme';

type Props = {
  label: string;
  value?: string;
  onPress?: () => void;
};

export const SettingRow = ({ label, value, onPress }: Props) => {
  const themeColors = useThemeColors();

  return (
    <Pressable accessibilityRole={onPress ? "button" : undefined} accessibilityLabel={`${label}${value ? `，${value}` : ''}`} style={({ pressed, hovered, focused }: any) => [styles.row, { borderBottomColor: themeColors.border }, onPress && hovered && { backgroundColor: themeColors.hover }, onPress && pressed && { backgroundColor: themeColors.pressed }, focused && { borderColor: themeColors.blue, borderWidth: 2 }]} onPress={onPress}>
      <Text style={[styles.label, { color: themeColors.text }]}>{label}</Text>
      <View style={styles.right}>
        {!!value && <Text style={[styles.value, { color: themeColors.secondary }]} numberOfLines={1}>{value}</Text>}
        {onPress ? <Ionicons name="chevron-forward" size={16} color={themeColors.subtle} /> : null}
      </View>
    </Pressable>
  );
};

const styles = StyleSheet.create({
  row: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  label: {
    flex: 1,
    ...typography.body,
    color: colors.text,
  },
  right: {
    flexDirection: 'row',
    alignItems: 'center',
    maxWidth: '62%',
  },
  value: {
    color: colors.secondary,
    ...typography.metadata,
    marginRight: 6,
  },
});
