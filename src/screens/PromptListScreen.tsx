import { Alert, FlatList, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { IconButton } from '@/components/IconButton';
import { promptRepo } from '@/db/repositories';
import { t } from '@/i18n';
import { scheduleSync } from '@/services/sync';
import { useAppStore } from '@/store/appStore';
import { colors, spacing, useThemeColors } from '@/utils/theme';
import { screenStyles } from './screenStyles';

const ACTION_WIDTH = 40;

export function PromptListScreen() {
  const queryClient = useQueryClient();
  const { mode } = useLocalSearchParams<{ mode?: string }>();
  const { selectedPromptId, setSelectedPromptId } = useAppStore();
  const [listKey, setListKey] = useState(0);
  const { width } = useWindowDimensions();
  const themeColors = useThemeColors();
  const rowWidth = width - spacing.screenX * 2;
  const actionGroupWidth = ACTION_WIDTH * 2 + 16;
  const isSelectMode = mode === 'select';
  const prompts = useQuery({ queryKey: ['prompts'], queryFn: promptRepo.list });
  const removePrompt = useMutation({
    mutationFn: (id: string) => promptRepo.remove(id),
    onSuccess: () => {
      scheduleSync();
      queryClient.invalidateQueries({ queryKey: ['prompts'] });
    },
    onError: (error) => Alert.alert(t('deleteFailed'), error instanceof Error ? error.message : t('soonRetry')),
  });
  const confirmRemovePrompt = (id: string, name: string) => {
    Alert.alert(t('deletePrompt'), t('deletePromptConfirm', { name }), [
      { text: t('cancel'), style: 'cancel' },
      { text: t('delete'), style: 'destructive', onPress: () => removePrompt.mutate(id) },
    ]);
  };
  const openPrompt = (id: string) => {
    if (!isSelectMode) return;
    setSelectedPromptId(id);
    router.back();
  };

  useFocusEffect(
    useCallback(() => {
      setListKey((key) => key + 1);
    }, []),
  );

  return (
    <SafeAreaView style={[screenStyles.safe, { backgroundColor: themeColors.background }]}>
      <View style={screenStyles.header}>
        <IconButton name="chevron-back" onPress={() => router.back()} />
        <Text style={[screenStyles.navTitle, { color: themeColors.text }]}>{t('prompts')}</Text>
        <IconButton name="add" onPress={() => router.push('/prompts/edit')} />
      </View>
      <FlatList
        data={prompts.data ?? []}
        extraData={listKey}
        contentContainerStyle={screenStyles.content}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <ScrollView
            key={`${item.id}-${listKey}`}
            horizontal
            bounces={false}
            decelerationRate="fast"
            disableIntervalMomentum
            showsHorizontalScrollIndicator={false}
            snapToOffsets={[0, actionGroupWidth]}
          >
            <Pressable style={[styles.row, { width: rowWidth, backgroundColor: themeColors.background, borderBottomColor: themeColors.border }]} onPress={() => openPrompt(item.id)}>
              <View style={[styles.icon, { backgroundColor: `${themeColors.blue}18` }]}>
                <Ionicons name={selectedPromptId === item.id ? 'checkbox' : 'checkbox-outline'} size={15} color={themeColors.blue} />
              </View>
              <Text style={[styles.name, { color: themeColors.text }]} numberOfLines={1}>{item.name}</Text>
            </Pressable>
            <View style={[styles.actions, { backgroundColor: themeColors.page }]}>
              <Pressable style={styles.action} onPress={() => router.push({ pathname: '/prompts/edit', params: { id: item.id } })}>
                <Ionicons name="create-outline" size={18} color={themeColors.text} />
              </Pressable>
              <Pressable style={styles.action} onPress={() => confirmRemovePrompt(item.id, item.name)}>
                <Ionicons name="trash-outline" size={18} color="#FF3B30" />
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
  name: {
    flex: 1,
    color: colors.text,
    fontSize: 15,
    fontWeight: '600',
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
