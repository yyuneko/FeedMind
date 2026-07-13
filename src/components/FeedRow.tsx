import { useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { DESKTOP_BREAKPOINT } from '@/hooks/useDesktopLayout';
import { t } from '@/i18n';
import { colors, spacing, useThemeColors } from '@/utils/theme';

const ACTION_WIDTH = 40;
const CONTEXT_MENU_WIDTH = 144;
const CONTEXT_MENU_HEIGHT = 92;

type Props = {
  title: string;
  count?: number;
  icon?: keyof typeof Ionicons.glyphMap;
  color?: string;
  imageUrl?: string | null;
  onPress?: () => void;
  onLongPress?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  selected?: boolean;
};

export const FeedRow = ({ title, count, icon = 'reader-outline', color = colors.blue, imageUrl, onPress, onLongPress, onEdit, onDelete, selected = false }: Props) => {
  const { width, height } = useWindowDimensions();
  const [viewportWidth, setViewportWidth] = useState(0);
  const [contextMenuPosition, setContextMenuPosition] = useState<{ left: number; top: number } | null>(null);
  const themeColors = useThemeColors();
  const desktop = Platform.OS === 'web' && width >= DESKTOP_BREAKPOINT;
  const rowWidth = viewportWidth || width - spacing.screenX * 2;
  const actionGroupWidth = (onEdit ? ACTION_WIDTH : 0) + (onDelete ? ACTION_WIDTH : 0) + 16;
  const openContextMenu = (event: any) => {
    if (!desktop || (!onEdit && !onDelete)) return;
    event.preventDefault?.();
    event.stopPropagation?.();
    const nativeEvent = event.nativeEvent ?? event;
    const x = nativeEvent.pageX ?? nativeEvent.clientX ?? 0;
    const y = nativeEvent.pageY ?? nativeEvent.clientY ?? 0;
    setContextMenuPosition({
      left: Math.max(8, Math.min(x, width - CONTEXT_MENU_WIDTH - 8)),
      top: Math.max(8, Math.min(y, height - CONTEXT_MENU_HEIGHT - 8)),
    });
  };
  const runContextAction = (action?: () => void) => {
    setContextMenuPosition(null);
    action?.();
  };
  const contextMenu = contextMenuPosition ? (
    <Modal transparent visible animationType={'none'} onRequestClose={() => setContextMenuPosition(null)}>
      <Pressable
        style={styles.contextOverlay}
        onPress={() => setContextMenuPosition(null)}
        {...({ onContextMenu: (event: any) => event.preventDefault?.() } as any)}
      >
        <View style={[styles.contextMenu, { left: contextMenuPosition.left, top: contextMenuPosition.top, backgroundColor: themeColors.card, borderColor: themeColors.border }]}>
          {onEdit ? (
            <Pressable style={({ pressed }) => [styles.contextMenuItem, pressed && styles.contextMenuItemPressed]} onPress={() => runContextAction(onEdit)}>
              <Ionicons name={'create-outline'} size={18} color={themeColors.text} />
              <Text style={[styles.contextMenuText, { color: themeColors.text }]}>{t('edit')}</Text>
            </Pressable>
          ) : null}
          {onDelete ? (
            <Pressable style={({ pressed }) => [styles.contextMenuItem, pressed && styles.contextMenuItemPressed]} onPress={() => runContextAction(onDelete)}>
              <Ionicons name={'trash-outline'} size={18} color={'#FF3B30'} />
              <Text style={[styles.contextMenuText, { color: '#FF3B30' }]}>{t('delete')}</Text>
            </Pressable>
          ) : null}
        </View>
      </Pressable>
    </Modal>
  ) : null;
  const row = (
    <>
      <Pressable
        accessibilityState={{ selected }}
        style={[styles.row, { backgroundColor: selected ? themeColors.pill : themeColors.background, borderBottomColor: themeColors.border }, selected && styles.selectedRow]}
        onPress={onPress}
        onLongPress={desktop ? undefined : onLongPress}
        {...(desktop ? ({ onContextMenu: openContextMenu } as any) : {})}
      >
        <FeedIcon icon={icon} color={color} imageUrl={imageUrl} />
        <Text numberOfLines={1} ellipsizeMode={'tail'} style={[styles.title, { color: selected ? themeColors.blue : themeColors.text }]}>{title}</Text>
        {count !== undefined && <Text style={[styles.count, { color: selected ? themeColors.blue : themeColors.secondary }]}>{count}</Text>}
      </Pressable>
      {contextMenu}
    </>
  );

  if (!onEdit && !onDelete || desktop) return row;

  return (
    <ScrollView
      style={styles.swipeContainer}
      horizontal
      bounces={false}
      decelerationRate="fast"
      disableIntervalMomentum
      showsHorizontalScrollIndicator={false}
      snapToOffsets={[0, actionGroupWidth]}
      onLayout={(event) => setViewportWidth(event.nativeEvent.layout.width)}
    >
      <Pressable accessibilityState={{ selected }} style={[styles.row, { width: rowWidth, backgroundColor: selected ? themeColors.pill : themeColors.background, borderBottomColor: themeColors.border }, selected && styles.selectedRow]} onPress={onPress} onLongPress={onLongPress}>
        <FeedIcon icon={icon} color={color} imageUrl={imageUrl} />
        <Text numberOfLines={1} ellipsizeMode={'tail'} style={[styles.title, { color: selected ? themeColors.blue : themeColors.text }]}>{title}</Text>
        {count !== undefined && <Text style={[styles.count, { color: selected ? themeColors.blue : themeColors.secondary }]}>{count}</Text>}
      </Pressable>
      <View style={[styles.actions, { backgroundColor: themeColors.page }]}>
        {!!onEdit && (
          <Pressable style={[styles.action]} onPress={onEdit}>
            <Ionicons name="create-outline" size={18} color={themeColors.text} />
          </Pressable>
        )}
        {!!onDelete && (
          <Pressable style={styles.action} onPress={onDelete}>
            <Ionicons name="trash-outline" size={18} color="#FF3B30" />
          </Pressable>
        )}
      </View>
    </ScrollView>
  );
};

const FeedIcon = ({ icon, color, imageUrl }: { icon: keyof typeof Ionicons.glyphMap; color: string; imageUrl?: string | null }) => {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showImage = Boolean(imageUrl && imageUrl !== failedUrl);
  return (
    <View style={[styles.icon, { backgroundColor: `${color}18` }]}>
      {showImage
        ? <Image source={{ uri: imageUrl! }} style={styles.iconImage} contentFit={'contain'} onError={() => setFailedUrl(imageUrl!)} />
        : <Ionicons name={icon} size={15} color={color} />}
    </View>
  );
};

const styles = StyleSheet.create({
  swipeContainer: {
    width: '100%',
  },
  row: {
    height: 56,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.background,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  icon: {
    width: 20,
    height: 20,
    borderRadius: 5,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 16,
  },
  selectedRow: {
    borderRadius: 9,
  },
  iconImage: {
    width: 20,
    height: 20,
  },
  title: {
    flex: 1,
    fontSize: 15,
    color: colors.text,
    fontWeight: '600',
  },
  count: {
    color: colors.secondary,
    fontSize: 14,
  },
  actions: {
    marginLeft: 16,
    backgroundColor: colors.page,
    flexDirection: 'row',
    justifyContent: 'space-evenly',
    height: 56,
  },
  action: {
    width: ACTION_WIDTH,
    height: 56,
    alignItems: 'center',
    justifyContent: 'center',
  },
  contextOverlay: {
    flex: 1,
  },
  contextMenu: {
    position: 'absolute',
    width: CONTEXT_MENU_WIDTH,
    paddingVertical: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.16,
    shadowRadius: 14,
    elevation: 8,
  },
  contextMenuItem: {
    height: 40,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
  },
  contextMenuText: {
    marginLeft: 10,
    fontSize: 14,
    fontWeight: '700',
  },
  contextMenuItemPressed: {
    opacity: 0.55,
  },
});
