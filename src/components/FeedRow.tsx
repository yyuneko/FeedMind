import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '@/utils/theme';

type Props = {
  title: string;
  count?: number;
  icon?: keyof typeof Ionicons.glyphMap;
  color?: string;
  onPress?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
};

export const FeedRow = ({ title, count, icon = 'reader-outline', color = colors.blue, onPress, onEdit, onDelete }: Props) => (
  <Pressable style={styles.row} onPress={onPress}>
    <View style={[styles.icon, { backgroundColor: `${color}18` }]}>
      <Ionicons name={icon} size={15} color={color} />
    </View>
    <Text style={styles.title}>{title}</Text>
    {count !== undefined && <Text style={styles.count}>{count}</Text>}
    {!!onEdit && (
      <Pressable style={styles.action} onPress={onEdit}>
        <Ionicons name="create-outline" size={18} color={colors.blue} />
      </Pressable>
    )}
    {!!onDelete && (
      <Pressable style={styles.action} onPress={onDelete}>
        <Ionicons name="trash-outline" size={18} color="#EF4444" />
      </Pressable>
    )}
  </Pressable>
);

const styles = StyleSheet.create({
  row: {
    height: 58,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  icon: {
    width: 22,
    height: 22,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 18,
  },
  title: {
    flex: 1,
    fontSize: 16,
    color: colors.text,
    fontWeight: '600',
  },
  count: {
    color: colors.secondary,
    fontSize: 14,
  },
  action: {
    width: 40,
    height: 40,
    marginLeft: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
