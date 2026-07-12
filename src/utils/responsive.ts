import { Platform, useWindowDimensions } from 'react-native';

export const DESKTOP_BREAKPOINT = 900;

export const useIsDesktop = () => {
  const { width } = useWindowDimensions();
  return Platform.OS === 'web' && width >= DESKTOP_BREAKPOINT;
};
