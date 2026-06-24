import { useMemo, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, useThemeColors } from '@/utils/theme';

type Item<T extends string> = {
  label: string;
  value: T;
  count?: number;
};

type Props<T extends string> = {
  items: Item<T>[];
  value: T;
  onChange: (value: T) => void;
  indicatorScrollX?: Animated.Value;
  indicatorPageWidth?: number;
};

export const SegmentedTabs = <T extends string>({ items, value, onChange, indicatorScrollX, indicatorPageWidth }: Props<T>) => {
  const [width, setWidth] = useState(0);
  const themeColors = useThemeColors();
  const tabWidth = width / items.length;
  const translateX = useMemo(() => {
    if (!indicatorScrollX || !indicatorPageWidth || !width) return undefined;
    return indicatorScrollX.interpolate({
      inputRange: items.map((_item, index) => index * indicatorPageWidth),
      outputRange: items.map((_item, index) => index * tabWidth),
      extrapolate: 'clamp',
    });
  }, [indicatorPageWidth, indicatorScrollX, items, tabWidth, width]);

  return (
    <View style={[styles.wrap, { borderBottomColor: themeColors.border }]} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      {items.map((item) => {
        const active = item.value === value;
        return (
          <Pressable key={item.value} style={styles.item} onPress={() => onChange(item.value)}>
            <Text style={[styles.label, { color: active ? themeColors.text : themeColors.secondary }, active && styles.active]} numberOfLines={1}>
              {item.label}
              {item.count !== undefined ? ` ${item.count}` : ''}
            </Text>
            <View style={[styles.line, active && !translateX && { backgroundColor: themeColors.blue }]} />
          </Pressable>
        );
      })}
      {!!translateX && <Animated.View style={[styles.animatedLine, { width: tabWidth, backgroundColor: themeColors.blue, transform: [{ translateX }] }]} />}
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    position: 'relative',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  item: {
    flex: 1,
    height: 42,
    justifyContent: 'flex-end',
  },
  label: {
    textAlign: 'center',
    color: colors.secondary,
    fontSize: 13,
    paddingBottom: 10,
  },
  active: {
    color: colors.text,
    fontWeight: '700',
  },
  line: {
    height: 2,
    backgroundColor: 'transparent',
  },
  activeLine: {
    backgroundColor: colors.blue,
  },
  animatedLine: {
    position: 'absolute',
    left: 0,
    bottom: 0,
    height: 2,
    backgroundColor: colors.blue,
  },
});
