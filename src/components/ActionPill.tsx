import { Pressable, StyleSheet, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, useThemeColors } from '@/utils/theme';

type Props = {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress?: () => void;
};

export const ActionPill = ({ icon, label, onPress }: Props) => {
  const themeColors = useThemeColors();

  return (
    <Pressable style={({ pressed }) => [styles.pill, pressed && styles.pressed]} onPress={onPress}>
      <Ionicons name={icon} size={15} color={themeColors.blue} />
      <Text style={[styles.text, { color: themeColors.text }]}>{label}</Text>
    </Pressable>
  );
};

const styles = StyleSheet.create({
  pill: {
    flex: 1,
    height: 36,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 4,
  },
  pressed: {
    opacity: 0.55,
  },
  text: {
    marginLeft: 6,
    color: colors.text,
    fontSize: 12,
    fontWeight: '700',
  },
});
