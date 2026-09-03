import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { LoadingIndicator } from '@/components/LoadingIndicator';
import { colors, radius, spacing, typography, useThemeColors } from '@/utils/theme';

type Props = {
  title: string;
  message?: string;
  actionLabel?: string;
  onAction?: () => void;
  textColor?: string;
  secondaryColor?: string;
  loading?: boolean;
};

export const QueryState = ({ title, message, actionLabel, onAction, textColor, secondaryColor, loading = false }: Props) => {
  const themeColors = useThemeColors();

  if (loading) {
    return (
      <View style={styles.loadingWrap}>
        <LoadingIndicator label={title} />
        {!!message && <Text style={[styles.loadingMessage, { color: secondaryColor ?? themeColors.secondary }]}>{message}</Text>}
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      <Text style={[styles.title, { color: textColor ?? themeColors.text }]}>{title}</Text>
      {!!message && <Text style={[styles.message, { color: secondaryColor ?? themeColors.secondary }]}>{message}</Text>}
      {!!actionLabel && !!onAction && (
        <Pressable style={[styles.action, { backgroundColor: themeColors.pill }]} onPress={onAction}>
          <Text style={[styles.actionText, { color: themeColors.blue }]}>{actionLabel}</Text>
        </Pressable>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: {
    paddingVertical: spacing.huge,
    alignItems: 'center',
  },
  loadingWrap: { minHeight: 112, paddingVertical: spacing.section, alignItems: 'center', justifyContent: 'center' },
  loadingMessage: { marginTop: spacing.sm, ...typography.metadata, textAlign: 'center' },
  title: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '700',
  },
  message: {
    marginTop: 8,
    color: colors.secondary,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
  },
  action: {
    marginTop: 16,
    height: 34,
    paddingHorizontal: 16,
    borderRadius: radius.round,
    backgroundColor: colors.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionText: {
    color: colors.blue,
    fontSize: 13,
    fontWeight: '700',
  },
});
