import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { spacing, typography, useReducedMotion, useThemeColors } from '@/utils/theme';

type Props = {
  label?: string;
  compact?: boolean;
  accent?: boolean;
};

export function LoadingIndicator({ label, compact = false, accent = false }: Props) {
  const colors = useThemeColors();
  const reducedMotion = useReducedMotion();
  const indicatorColor = accent ? colors.blue : colors.secondary;

  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityLiveRegion="polite"
      style={[styles.row, compact ? styles.compact : styles.regular]}
    >
      {reducedMotion
        ? <Ionicons name="ellipsis-horizontal" size={compact ? 16 : 18} color={indicatorColor} />
        : <ActivityIndicator size="small" color={indicatorColor} />}
      {label ? <Text style={[styles.label, { color: colors.secondary }]}>{label}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.md },
  compact: { minHeight: 32 },
  regular: { minHeight: 44 },
  label: { ...typography.metadata, fontWeight: '500' },
});
