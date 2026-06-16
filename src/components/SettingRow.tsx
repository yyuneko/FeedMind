import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '@/utils/theme';

type Props = {
  label: string;
  value?: string;
  onPress?: () => void;
};

export const SettingRow = ({ label, value, onPress }: Props) => (
  <Pressable style={styles.row} onPress={onPress}>
    <Text style={styles.label}>{label}</Text>
    <View style={styles.right}>
      {!!value && <Text style={styles.value} numberOfLines={1}>{value}</Text>}
      <Ionicons name="chevron-forward" size={16} color={colors.subtle} />
    </View>
  </Pressable>
);

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
