import { Pressable, StyleSheet, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius, typography, useThemeColors } from '@/utils/theme';

type Props = {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress?: () => void;
};

export const ActionPill = ({ icon, label, onPress }: Props) => {
  const themeColors = useThemeColors();

  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} style={({ pressed, hovered, focused }: any) => [styles.pill, hovered && { backgroundColor: themeColors.hover }, pressed && { backgroundColor: themeColors.pressed, transform: [{ scale: 0.985 }] }, focused && { borderColor: themeColors.blue, borderWidth: 2 }]} onPress={onPress}>
      <Ionicons name={icon} size={15} color={themeColors.blue} />
      <Text style={[styles.text, { color: themeColors.text }]}>{label}</Text>
    </Pressable>
  );
};

const styles = StyleSheet.create({
  pill: {
    flex: 1,
    minHeight: 44,
    borderRadius: radius.control,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 4,
  },
  text: {
    marginLeft: 6,
    color: colors.text,
    ...typography.control,
  },
});
