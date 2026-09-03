import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Pressable, StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import { AutofillSafeTextInput as TextInput } from '@/components/AutofillSafeTextInput';
import { radius, spacing, typography, useThemeColors } from '@/utils/theme';

type Props = {
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  autoFocus?: boolean;
  onEscape?: () => void;
  onSubmit?: () => void;
  style?: StyleProp<ViewStyle>;
};

export function SearchField({ value, onChangeText, placeholder, autoFocus, onEscape, onSubmit, style }: Props) {
  const colors = useThemeColors();
  const [focused, setFocused] = useState(false);
  return (
    <View style={[styles.wrap, { backgroundColor: colors.page, borderColor: focused ? colors.blue : 'transparent' }, focused && styles.focused, style]}>
      <Ionicons name="search-outline" size={17} color={focused ? colors.blue : colors.secondary} />
      <TextInput
        accessibilityLabel={placeholder}
        autoFocus={autoFocus}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.subtle}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onSubmitEditing={onSubmit}
        returnKeyType="search"
        onKeyPress={(event: any) => {
          if (event.nativeEvent.key === 'Escape') onEscape?.();
        }}
        style={[styles.input, { color: colors.text }]}
      />
      {value ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Clear search" hitSlop={6} style={styles.clear} onPress={() => onChangeText('')}>
          <Ionicons name="close-circle" size={17} color={colors.subtle} />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    minWidth: 0,
    height: 40,
    borderRadius: radius.control,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: spacing.lg,
  },
  focused: { borderWidth: 2, paddingLeft: spacing.lg - 1 },
  input: { flex: 1, height: 38, paddingHorizontal: spacing.md, paddingVertical: 0, ...typography.body, outlineStyle: 'none' } as any,
  clear: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
});
