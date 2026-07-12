import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { colors, spacing, useThemeColors } from '@/utils/theme';

const ACTION_WIDTH = 40;

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
};

export const FeedRow = ({ title, count, icon = 'reader-outline', color = colors.blue, imageUrl, onPress, onLongPress, onEdit, onDelete }: Props) => {
  const { width } = useWindowDimensions();
  const themeColors = useThemeColors();
  const rowWidth = width - spacing.screenX * 2;
  const actionGroupWidth = (onEdit ? ACTION_WIDTH : 0) + (onDelete ? ACTION_WIDTH : 0) + 16;
  const row = (
    <Pressable style={[styles.row, { backgroundColor: themeColors.background, borderBottomColor: themeColors.border }]} onPress={onPress} onLongPress={onLongPress}>
      <FeedIcon icon={icon} color={color} imageUrl={imageUrl} />
      <Text style={[styles.title, { color: themeColors.text }]}>{title}</Text>
      {count !== undefined && <Text style={[styles.count, { color: themeColors.secondary }]}>{count}</Text>}
    </Pressable>
  );

  if (!onEdit && !onDelete) return row;

  return (
    <ScrollView
      horizontal
      bounces={false}
      decelerationRate="fast"
      disableIntervalMomentum
      showsHorizontalScrollIndicator={false}
      snapToOffsets={[0, actionGroupWidth]}
    >
      <Pressable style={[styles.row, { width: rowWidth, backgroundColor: themeColors.background, borderBottomColor: themeColors.border }]} onPress={onPress} >
        <FeedIcon icon={icon} color={color} imageUrl={imageUrl} />
        <Text style={[styles.title, { color: themeColors.text }]}>{title}</Text>
        {count !== undefined && <Text style={[styles.count, { color: themeColors.secondary }]}>{count}</Text>}
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
});
