import { Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '@/utils/theme';

type Props = {
  name: keyof typeof Ionicons.glyphMap;
  onPress?: () => void;
  active?: boolean;
  size?: number;
};

export const IconButton = ({ name, onPress, active, size = 22 }: Props) => (
  <Pressable style={styles.button} onPress={onPress} hitSlop={12}>
    <Ionicons name={name} size={size} color={active ? colors.text : colors.text} />
  </Pressable>
);

const styles = StyleSheet.create({
  button: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
