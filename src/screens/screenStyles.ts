import { StyleSheet } from 'react-native';
import { colors, spacing, typography } from '@/utils/theme';

export const screenStyles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.background,
  },
  flex: {
    flex: 1,
  },
  header: {
    height: 60,
    paddingHorizontal: spacing.screenX,
    flexDirection: 'row',
    alignItems: 'center',
  },
  title: {
    flex: 1,
    color: colors.text,
    ...typography.pageTitle,
  },
  navTitle: {
    flex: 1,
    textAlign: 'center',
    color: colors.text,
    ...typography.navigationTitle,
  },
  content: {
    paddingHorizontal: spacing.screenX,
  },
  desktopContent: {
    width: '100%',
    maxWidth: 1120,
    alignSelf: 'center',
    paddingHorizontal: spacing.section,
  },
  desktopHeader: {
    width: '100%',
    maxWidth: 1120,
    alignSelf: 'center',
    height: 80,
    paddingHorizontal: spacing.section,
  },
  sectionTitle: {
    color: colors.text,
    ...typography.sectionLabel,
    marginTop: spacing.xl,
    marginBottom: spacing.md,
  },
  link: {
    color: colors.blue,
    ...typography.body,
    fontWeight: '600',
  },
});
