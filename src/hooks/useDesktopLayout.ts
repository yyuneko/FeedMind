import { useWindowDimensions } from 'react-native';

export const DESKTOP_BREAKPOINT = 900;

export const useDesktopLayout = () => useWindowDimensions().width >= DESKTOP_BREAKPOINT;
