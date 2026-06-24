import { Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useThemeColors } from '@/utils/theme';

type Props = {
  name: keyof typeof Ionicons.glyphMap;
  onPress?: () => void;
  active?: boolean;
  size?: number;
};

export const IconButton = ({ name, onPress, active, size = 22 }: Props) => {
  const themeColors = useThemeColors();

  return (
    <Pressable style={({ pressed }) => [styles.button, pressed && styles.pressed]} onPress={onPress} hitSlop={12}>
      <Ionicons name={name} size={size} color={active ? themeColors.text : themeColors.text} />
    </Pressable>
  );
};

const styles = StyleSheet.create({
  button: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: {
    opacity: 0.55,
  },
});
