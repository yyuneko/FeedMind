import { Alert, FlatList, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconButton } from '@/components/IconButton';
import { promptRepo } from '@/db/repositories';
import { scheduleSync } from '@/services/sync';
import { colors, spacing, useThemeColors } from '@/utils/theme';
import { screenStyles } from './screenStyles';

const ACTION_WIDTH = 50;

export function PromptListScreen() {
  const queryClient = useQueryClient();
  const { width } = useWindowDimensions();
  const themeColors = useThemeColors();
  const rowWidth = width - spacing.screenX * 2;
  const prompts = useQuery({ queryKey: ['prompts'], queryFn: promptRepo.list });
  const removePrompt = useMutation({
    mutationFn: (id: string) => promptRepo.remove(id),
    onSuccess: () => {
      scheduleSync();
      queryClient.invalidateQueries({ queryKey: ['prompts'] });
    },
    onError: (error) => Alert.alert('删除失败', error instanceof Error ? error.message : '请稍后重试'),
  });
  const confirmRemovePrompt = (id: string, name: string) => {
    Alert.alert('删除 Prompt', `确定删除「${name}」吗？`, [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: () => removePrompt.mutate(id) },
    ]);
  };

  return (
    <SafeAreaView style={[screenStyles.safe, { backgroundColor: themeColors.background }]}>
      <View style={screenStyles.header}>
        <IconButton name="chevron-back" onPress={() => router.back()} />
        <Text style={[screenStyles.navTitle, { color: themeColors.text }]}>Prompts</Text>
        <IconButton name="add" onPress={() => router.push('/prompts/edit')} />
      </View>
      <FlatList
        data={prompts.data ?? []}
        contentContainerStyle={screenStyles.content}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <ScrollView
            horizontal
            bounces={false}
            decelerationRate="fast"
            disableIntervalMomentum
            showsHorizontalScrollIndicator={false}
            snapToOffsets={[0, ACTION_WIDTH * 2]}
          >
            <Pressable style={[styles.row, { width: rowWidth, backgroundColor: themeColors.background, borderBottomColor: themeColors.border }]} onPress={() => router.push({ pathname: '/prompts/edit', params: { id: item.id } })}>
              <View style={styles.body}>
                <Text style={[styles.name, { color: themeColors.text }]}>{item.name}</Text>
                <Text style={[styles.desc, { color: themeColors.secondary }]} numberOfLines={1}>{item.content}</Text>
              </View>
            </Pressable>
            <View style={styles.actions}>
              <Pressable style={[styles.action, styles.editAction, { borderLeftColor: themeColors.border }]} onPress={() => router.push({ pathname: '/prompts/edit', params: { id: item.id } })}>
                <Ionicons name="create-outline" size={20} color={themeColors.text} />
              </Pressable>
              <Pressable style={styles.action} onPress={() => confirmRemovePrompt(item.id, item.name)}>
                <Ionicons name="trash-outline" size={20} color="#FF3B30" />
              </Pressable>
            </View>
          </ScrollView>
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  row: {
    height: 64,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.background,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  body: {
    flex: 1,
  },
  name: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '800',
  },
  desc: {
    marginTop: 5,
    color: colors.secondary,
    fontSize: 11,
  },
  actions: {
    flexDirection: 'row',
    height: 64,
  },
  action: {
    width: ACTION_WIDTH,
    height: 64,
    alignItems: 'center',
    justifyContent: 'center',
  },
  editAction: {
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: colors.border,
  },
});
