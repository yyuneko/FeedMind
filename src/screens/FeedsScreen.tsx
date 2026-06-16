import { Alert, FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { FeedRow } from '@/components/FeedRow';
import { articleRepo, feedRepo } from '@/db/repositories';
import { addFeed, updateFeed } from '@/services/rss';
import type { Article, Feed } from '@/types';
import { colors } from '@/utils/theme';
import { screenStyles } from './screenStyles';

const categoryColors = ['#6B6FDD', '#8B5CF6', '#0EA5A3', '#EAB308', '#EF4444'];

export function FeedsScreen() {
  const queryClient = useQueryClient();
  const [isEditing, setIsEditing] = useState(false);
  const [addVisible, setAddVisible] = useState(false);
  const [editingFeed, setEditingFeed] = useState<Feed | null>(null);
  const [url, setUrl] = useState('');
  const [category, setCategory] = useState('Uncategorized');
  const [editTitle, setEditTitle] = useState('');
  const [editUrl, setEditUrl] = useState('');
  const [editCategory, setEditCategory] = useState('Uncategorized');
  const feeds = useQuery<Feed[]>({ queryKey: ['feeds'], queryFn: feedRepo.list });
  const articles = useQuery<Article[]>({ queryKey: ['articles', 'all'], queryFn: () => articleRepo.list('all') });
  const mutation = useMutation({
    mutationFn: (feed: { url: string; category: string }) => addFeed({ url: feed.url }, feed.category),
    onSuccess: () => {
      setUrl('');
      setCategory('Uncategorized');
      setAddVisible(false);
      queryClient.invalidateQueries();
    },
    onError: (error) => Alert.alert('添加失败', error instanceof Error ? error.message : '请检查 RSS 地址'),
  });
  const removeFeed = useMutation({
    mutationFn: (id: string) => feedRepo.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries();
    },
    onError: (error) => Alert.alert('删除失败', error instanceof Error ? error.message : '请稍后重试'),
  });
  const updateMutation = useMutation({
    mutationFn: updateFeed,
    onSuccess: () => {
      setEditingFeed(null);
      queryClient.invalidateQueries();
    },
    onError: (error) => Alert.alert('更新失败', error instanceof Error ? error.message : '请稍后重试'),
  });
  const allArticles = articles.data ?? [];
  const categoryMap = new Map<string, number>();
  for (const feed of feeds.data ?? []) {
    categoryMap.set(feed.category, allArticles.filter((item: Article) => item.feedId === feed.id).length + (categoryMap.get(feed.category) ?? 0));
  }
  const categories = [...categoryMap.entries()];
  const categoryOptions = ['Uncategorized', ...categories.map(([item]) => item).filter((item) => item !== 'Uncategorized')];
  const confirmRemoveFeed = (feed: Feed) => {
    Alert.alert('删除订阅源', `确定删除「${feed.title}」及其文章吗？`, [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: () => removeFeed.mutate(feed.id) },
    ]);
  };
  const openEditFeed = (feed: Feed) => {
    setEditingFeed(feed);
    setEditTitle(feed.title);
    setEditUrl(feed.url);
    setEditCategory(feed.category);
  };

  return (
    <SafeAreaView style={screenStyles.safe}>
      <View style={screenStyles.header}>
        <Text style={screenStyles.title}>Feeds</Text>
        <Text style={styles.edit} onPress={() => setIsEditing((value) => !value)}>{isEditing ? 'Done' : 'Edit'}</Text>
      </View>
      <View style={screenStyles.content}>
        <FeedRow title="All Articles" count={allArticles.length} icon="reader-outline" color="#222222" onPress={() => router.push('/')} />
        <FeedRow title="Uncategorized" count={categoryMap.get('Uncategorized') ?? 0} icon="folder-outline" color="#5B6472" onPress={() => router.push({ pathname: '/article/category', params: { category: 'Uncategorized' } })} />
        <Text style={screenStyles.sectionTitle}>My Feeds</Text>
        {isEditing ? (
          <FlatList
            scrollEnabled={false}
            data={feeds.data ?? []}
            keyExtractor={(item) => item.id}
            renderItem={({ item, index }) => (
              <FeedRow
                title={item.title}
                count={allArticles.filter((article: Article) => article.feedId === item.id).length}
                color={categoryColors[index % categoryColors.length]}
                onEdit={() => openEditFeed(item)}
                onDelete={() => confirmRemoveFeed(item)}
              />
            )}
          />
        ) : (
          <FlatList
            scrollEnabled={false}
            data={feeds.data ?? []}
            keyExtractor={(item) => item.id}
            renderItem={({ item, index }) => (
              <FeedRow
                title={item.title}
                count={allArticles.filter((article: Article) => article.feedId === item.id).length}
                color={categoryColors[index % categoryColors.length]}
                onPress={() => router.push({ pathname: '/article/category', params: { category: item.category, feedId: item.id, title: item.title } })}
              />
            )}
          />
        )}
        <View style={styles.addBox}>
          <Pressable style={styles.addButton} onPress={() => setAddVisible(true)}>
            <Text style={screenStyles.link}>＋ Add Feed</Text>
          </Pressable>
        </View>
      </View>
      <Modal visible={addVisible} transparent animationType="fade" onRequestClose={() => setAddVisible(false)}>
        <View style={styles.modalMask}>
          <View style={styles.modal}>
            <Text style={styles.modalTitle}>Add Feed</Text>
            <TextInput
              value={url}
              onChangeText={setUrl}
              placeholder="RSS 地址"
              autoCapitalize="none"
              style={styles.input}
            />
            <Text style={styles.fieldLabel}>分类</Text>
            <View style={styles.categoryOptions}>
              {categoryOptions.map((item) => {
                const active = item === category;
                return (
                  <Pressable key={item} style={[styles.categoryChip, active && styles.categoryChipActive]} onPress={() => setCategory(item)}>
                    <Text style={[styles.categoryText, active && styles.categoryTextActive]}>{item}</Text>
                  </Pressable>
                );
              })}
            </View>
            <View style={styles.modalActions}>
              <Pressable style={styles.modalButton} onPress={() => setAddVisible(false)}>
                <Text style={styles.cancelText}>Cancel</Text>
              </Pressable>
              <Pressable style={styles.modalButton} onPress={() => url.trim() && mutation.mutate({ url, category })}>
                <Text style={screenStyles.link}>{mutation.isPending ? 'Adding...' : 'Add'}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
      <Modal visible={Boolean(editingFeed)} transparent animationType="fade" onRequestClose={() => setEditingFeed(null)}>
        <View style={styles.modalMask}>
          <View style={styles.modal}>
            <Text style={styles.modalTitle}>Edit Feed</Text>
            <TextInput
              value={editTitle}
              onChangeText={setEditTitle}
              placeholder="订阅源名称"
              style={styles.input}
            />
            <TextInput
              value={editUrl}
              onChangeText={setEditUrl}
              placeholder="RSS 地址"
              autoCapitalize="none"
              style={[styles.input, styles.editUrlInput]}
            />
            <Text style={styles.fieldLabel}>分类</Text>
            <View style={styles.categoryOptions}>
              {categoryOptions.map((item) => {
                const active = item === editCategory;
                return (
                  <Pressable key={item} style={[styles.categoryChip, active && styles.categoryChipActive]} onPress={() => setEditCategory(item)}>
                    <Text style={[styles.categoryText, active && styles.categoryTextActive]}>{item}</Text>
                  </Pressable>
                );
              })}
            </View>
            <View style={styles.modalActions}>
              <Pressable style={styles.modalButton} onPress={() => setEditingFeed(null)}>
                <Text style={styles.cancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={styles.modalButton}
                onPress={() => editingFeed && editUrl.trim() && updateMutation.mutate({ id: editingFeed.id, title: editTitle, url: editUrl, category: editCategory })}
              >
                <Text style={screenStyles.link}>{updateMutation.isPending ? 'Saving...' : 'Save'}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  edit: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '600',
  },
  addBox: {
    marginTop: 28,
  },
  input: {
    height: 42,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    fontSize: 14,
  },
  editUrlInput: {
    marginTop: 10,
  },
  fieldLabel: {
    marginTop: 16,
    marginBottom: 10,
    color: colors.secondary,
    fontSize: 13,
    fontWeight: '600',
  },
  categoryOptions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  categoryChip: {
    height: 34,
    paddingHorizontal: 12,
    borderRadius: 17,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
    marginBottom: 8,
  },
  categoryChipActive: {
    backgroundColor: colors.pill,
    borderColor: colors.blue,
  },
  categoryText: {
    color: colors.secondary,
    fontSize: 13,
    fontWeight: '600',
  },
  categoryTextActive: {
    color: colors.blue,
  },
  addButton: {
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalMask: {
    flex: 1,
    paddingHorizontal: 22,
    backgroundColor: 'rgba(0, 0, 0, 0.28)',
    justifyContent: 'center',
  },
  modal: {
    borderRadius: 12,
    backgroundColor: colors.card,
    padding: 18,
  },
  modalTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 16,
  },
  modalActions: {
    height: 48,
    marginTop: 12,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
  },
  modalButton: {
    minWidth: 72,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelText: {
    color: colors.secondary,
    fontSize: 15,
    fontWeight: '600',
  },
});
