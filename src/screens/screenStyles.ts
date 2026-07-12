import { StyleSheet } from 'react-native';
import { colors, spacing } from '@/utils/theme';

export const screenStyles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.background,
  },
  flex: {
    flex: 1,
    width: '100%',
    maxWidth: 1040,
    alignSelf: 'center',
  },
  header: {
    width: '100%',
    maxWidth: 1040,
    alignSelf: 'center',
    height: 72,
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
    letterSpacing: -0.5,
  },
  navTitle: {
    flex: 1,
    textAlign: 'center',
    color: colors.text,
    fontSize: 17,
    fontWeight: '800',
  },
  content: {
    width: '100%',
    maxWidth: 1040,
    alignSelf: 'center',
    paddingHorizontal: spacing.screenX,
    paddingBottom: 32,
  },
  sectionTitle: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '800',
    marginTop: 20,
    marginBottom: 7,
  },
  link: {
    color: colors.blue,
    fontSize: 15,
    fontWeight: '700',
  },
});