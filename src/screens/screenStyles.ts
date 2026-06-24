import { StyleSheet } from 'react-native';
import { colors, spacing } from '@/utils/theme';

export const screenStyles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.background,
  },
  flex: {
    flex: 1,
  },
  header: {
    height: 62,
    paddingHorizontal: spacing.screenX,
    flexDirection: 'row',
    alignItems: 'center',
  },
  title: {
    flex: 1,
    color: colors.text,
    fontSize: 25,
    lineHeight: 31,
    fontWeight: '800',
  },
  navTitle: {
    flex: 1,
    textAlign: 'center',
    color: colors.text,
    fontSize: 17,
    fontWeight: '800',
  },
  content: {
    paddingHorizontal: spacing.screenX,
  },
  sectionTitle: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '800',
    marginTop: 16,
    marginBottom: 7,
  },
  link: {
    color: colors.blue,
    fontSize: 15,
    fontWeight: '700',
  },
});
