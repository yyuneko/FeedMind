import { ActivityIndicator, Animated, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRef } from 'react';
import { motion, radius, useReducedMotion, useThemeColors } from '@/utils/theme';

type Props = {
  name: keyof typeof Ionicons.glyphMap;
  onPress?: () => void;
  active?: boolean;
  size?: number;
  label?: string;
  disabled?: boolean;
  loading?: boolean;
  variant?: 'plain' | 'tinted' | 'destructive';
  showFocusBorder?: boolean;
};

export const IconButton = ({ name, onPress, active = false, size = 21, label, disabled = false, loading = false, variant = 'plain', showFocusBorder = true }: Props) => {
  const themeColors = useThemeColors();
  const reducedMotion = useReducedMotion();
  const scale = useRef(new Animated.Value(1)).current;
  const animateTo = (toValue: number) => {
    if (reducedMotion) {
      scale.setValue(1);
      return;
    }
    Animated.spring(scale, { toValue, useNativeDriver: true, ...motion.spring.snappy }).start();
  };
  const color = variant === 'destructive' ? themeColors.destructive : active || variant === 'tinted' ? themeColors.blue : themeColors.text;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label ?? name.replace(/-outline$/, '').replace(/-/g, ' ')}
      accessibilityState={{ selected: active, disabled, busy: loading }}
      disabled={disabled || loading}
      onPress={onPress}
      onPressIn={() => animateTo(0.97)}
      onPressOut={() => animateTo(1)}
      hitSlop={6}
      style={({ pressed, hovered, focused }: any) => [
        styles.button,
        (active || variant === 'tinted') && { backgroundColor: themeColors.selected },
        hovered && !disabled && { backgroundColor: active ? themeColors.selected : themeColors.hover },
        pressed && !disabled && { backgroundColor: themeColors.pressed },
        focused && showFocusBorder && { borderColor: themeColors.blue, borderWidth: 2 },
        (disabled || loading) && styles.disabled,
      ]}
    >
      <Animated.View style={{ transform: [{ scale }] }}>
        {loading ? <ActivityIndicator size="small" color={color} /> : <Ionicons name={name} size={size} color={color} />}
      </Animated.View>
    </Pressable>
  );
};

const styles = StyleSheet.create({
  button: {
    width: 44,
    height: 44,
    borderRadius: radius.control,
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabled: {
    opacity: 0.42,
  },
});
