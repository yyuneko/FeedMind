import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, useThemeColors } from '@/utils/theme';

type Props = {
  label: string;
  value?: string;
  onPress?: () => void;
};

export const SettingRow = ({ label, value, onPress }: Props) => {
  const themeColors = useThemeColors();

  return (
    <Pressable style={[styles.row, { borderBottomColor: themeColors.border }]} onPress={onPress}>
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
    height: 48,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  label: {
    flex: 1,
    fontSize: 14,
    color: colors.text,
  },
  right: {
    flexDirection: 'row',
    alignItems: 'center',
    maxWidth: '62%',
  },
  value: {
    color: colors.secondary,
    fontSize: 13,
    marginRight: 6,
  },
});
