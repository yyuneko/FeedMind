import { StyleSheet } from 'react-native';
import { colors, spacing } from '@/utils/theme';

export const screenStyles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    height: 64,
    paddingHorizontal: spacing.screenX,
    flexDirection: 'row',
    alignItems: 'center',
  },
  title: {
    flex: 1,
    color: colors.text,
    fontSize: 28,
    lineHeight: 34,
    fontWeight: '800',
  },
  navTitle: {
    flex: 1,
    textAlign: 'center',
    color: colors.text,
    fontSize: 18,
    fontWeight: '800',
  },
  content: {
    paddingHorizontal: spacing.screenX,
  },
  sectionTitle: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '800',
    marginTop: 18,
    marginBottom: 8,
  },
  link: {
    color: colors.blue,
    fontSize: 15,
    fontWeight: '700',
  },
});
