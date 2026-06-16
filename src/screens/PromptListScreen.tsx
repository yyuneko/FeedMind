import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { IconButton } from '@/components/IconButton';
import { promptRepo } from '@/db/repositories';
import { colors } from '@/utils/theme';
import { screenStyles } from './screenStyles';

export function PromptListScreen() {
  const prompts = useQuery({ queryKey: ['prompts'], queryFn: promptRepo.list });
  return (
    <SafeAreaView style={screenStyles.safe}>
      <View style={screenStyles.header}>
        <IconButton name="chevron-back" onPress={() => router.back()} />
        <Text style={screenStyles.navTitle}>Prompts</Text>
        <Pressable onPress={() => router.push('/prompts/edit')}>
          <Text style={screenStyles.link}>新建＋</Text>
        </Pressable>
      </View>
      <FlatList
        data={prompts.data ?? []}
        contentContainerStyle={screenStyles.content}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <Pressable style={styles.row} onPress={() => router.push({ pathname: '/prompts/edit', params: { id: item.id } })}>
            <View style={styles.body}>
              <View style={styles.titleLine}>
                <Text style={styles.name}>{item.name}</Text>
                {item.isDefault && <Text style={styles.badge}>默认</Text>}
              </View>
              <Text style={styles.desc} numberOfLines={1}>{item.content}</Text>
            </View>
            <IconButton name="ellipsis-horizontal" />
          </Pressable>
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 68,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  body: {
    flex: 1,
  },
  titleLine: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  name: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '800',
  },
  badge: {
    marginLeft: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    backgroundColor: colors.pill,
    color: colors.blue,
    fontSize: 11,
    fontWeight: '700',
  },
  desc: {
    marginTop: 7,
    color: colors.secondary,
    fontSize: 13,
  },
});
