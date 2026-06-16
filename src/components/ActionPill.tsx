import { Pressable, StyleSheet, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '@/utils/theme';

type Props = {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress?: () => void;
};

export const ActionPill = ({ icon, label, onPress }: Props) => (
  <Pressable style={styles.pill} onPress={onPress}>
    <Ionicons name={icon} size={15} color={colors.blue} />
    <Text style={styles.text}>{label}</Text>
  </Pressable>
);

const styles = StyleSheet.create({
  pill: {
    flex: 1,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.pill,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 4,
  },
  text: {
    marginLeft: 6,
    color: colors.blue,
    fontSize: 12,
    fontWeight: '700',
  },
});
