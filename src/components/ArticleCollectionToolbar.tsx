import { Ionicons } from '@expo/vector-icons';
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { IconButton } from '@/components/IconButton';
import { SearchField } from '@/components/SearchField';
import { LoadingIndicator } from '@/components/LoadingIndicator';
import { articleRepo } from '@/api/repositories';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { getLocale, t } from '@/i18n';
import type { ArticleListCriteria, ArticleTagOption } from '@/types';
import { motion, radius, spacing, useReducedMotion, useThemeColors } from '@/utils/theme';

type Props = {
  criteria: ArticleListCriteria;
  onCriteriaChange: (patch: Partial<Pick<ArticleListCriteria, 'unreadOnly' | 'tagKey'>>) => void;
  onQuerySubmit: (query: string) => void;
  onRefresh: () => void;
  refreshing: boolean;
  compact?: boolean;
};

export function ArticleCollectionToolbar({ criteria, onCriteriaChange, onQuerySubmit, onRefresh, refreshing, compact = false }: Props) {
  const colors = useThemeColors();
  const reducedMotion = useReducedMotion();
  const [searchOpen, setSearchOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const searchProgress = useRef(new Animated.Value(0)).current;
  const debouncedDraft = useDebouncedValue(draft, 300);
  const normalizedDraft = draft.trim();
  const tagQuery = debouncedDraft.trim();
  const tagResultsReady = Boolean(tagQuery) && tagQuery === normalizedDraft;
  const tags = useQuery({
    queryKey: ['article-tags', criteria.collection, criteria.unreadOnly, criteria.query, tagQuery, getLocale()],
    queryFn: () => articleRepo.tags(criteria, tagQuery, 1, 50),
    enabled: searchOpen && Boolean(tagQuery),
  });
  const selectedTag = useQuery({
    queryKey: ['article-tag', criteria.tagKey, getLocale()],
    queryFn: () => articleRepo.tag(criteria.tagKey!),
    enabled: Boolean(criteria.tagKey),
  });

  useEffect(() => {
    if (!searchOpen) {
      setDraft('');
      searchProgress.setValue(0);
      return;
    }
    Animated.timing(searchProgress, {
      toValue: 1,
      duration: reducedMotion ? 0 : motion.duration.fast,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [reducedMotion, searchOpen, searchProgress]);

  const closeSearch = () => {
    setDraft('');
    setSearchOpen(false);
  };
  const submitSearch = () => {
    if (!normalizedDraft) return;
    onQuerySubmit(normalizedDraft);
    closeSearch();
  };
  const chooseTag = (tag: ArticleTagOption) => {
    onCriteriaChange({ tagKey: tag.key });
    setDraft('');
  };

  return (
    <View style={[styles.toolbar, { borderBottomColor: colors.border, backgroundColor: colors.background }]}>
      <View style={[styles.topRow, compact && styles.compactTopRow]}>
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: criteria.unreadOnly }}
          style={[styles.unreadControl, { backgroundColor: criteria.unreadOnly ? colors.selected : colors.page }]}
          onPress={() => onCriteriaChange({ unreadOnly: !criteria.unreadOnly })}
        >
          <Ionicons name={criteria.unreadOnly ? 'checkmark-circle' : 'ellipse-outline'} size={17} color={criteria.unreadOnly ? colors.blue : colors.secondary} />
          <Text style={{ color: criteria.unreadOnly ? colors.blue : colors.text }}>{t('unread')}</Text>
        </Pressable>
        <View style={styles.searchArea}>
          {!searchOpen ? (
            <>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.activeFilters} contentContainerStyle={styles.activeFiltersContent}>
                {criteria.tagKey ? (
                  <FilterChip icon="pricetag-outline" label={t('activeTag', { name: selectedTag.data?.name ?? criteria.tagKey })} onClear={() => onCriteriaChange({ tagKey: undefined })} />
                ) : null}
                {criteria.query ? (
                  <FilterChip icon="search-outline" label={t('activeArticleSearch', { query: criteria.query })} onClear={() => onQuerySubmit('')} />
                ) : null}
              </ScrollView>
              <Pressable accessibilityRole="button" accessibilityLabel={t('search')} accessibilityState={{ expanded: false }} style={styles.searchButton} onPress={() => setSearchOpen(true)}>
                <Ionicons name="search-outline" size={19} color={colors.secondary} />
              </Pressable>
            </>
          ) : (
            <Animated.View style={[styles.inlineSearch, { backgroundColor: colors.background, width: searchProgress.interpolate({ inputRange: [0, 1], outputRange: ['24%', '100%'] }), opacity: searchProgress }]}>
              <SearchField autoFocus value={draft} onChangeText={setDraft} onSubmit={submitSearch} placeholder={t('searchArticlesAndTags')}
                onEscape={() => { if (draft) setDraft(''); else closeSearch(); }} style={styles.searchInput} />
              <Pressable accessibilityRole="button" accessibilityLabel={t('close')} style={styles.inlineSearchClose} onPress={closeSearch}>
                <Ionicons name="close" size={19} color={colors.secondary} />
              </Pressable>
            </Animated.View>
          )}
        </View>
        <IconButton name="refresh-outline" label={t('refresh')} loading={refreshing} onPress={onRefresh} />
      </View>
      {searchOpen && normalizedDraft ? (
        <View style={[styles.searchPanel, compact && styles.compactSearchPanel, { borderTopColor: colors.border }]}>
          {normalizedDraft && (!tagResultsReady || tags.isLoading) ? <View style={styles.loading}><LoadingIndicator compact label={t('tagsLoading')} /></View> : null}
          {tagResultsReady && tags.data?.items.length ? (
            <>
              <Text style={[styles.sectionLabel, { color: colors.secondary }]}>{t('matchingTags')}</Text>
              <ScrollView style={styles.tagResults} keyboardShouldPersistTaps="handled">
                {tags.data.items.map((tag: ArticleTagOption) => (
                  <Pressable key={tag.key} accessibilityRole="button" accessibilityLabel={t('filterByTag', { name: tag.name })}
                    style={({ pressed }) => [styles.tagResult, { borderBottomColor: colors.border }, pressed && styles.pressed]}
                    onPress={() => chooseTag(tag)}>
                    <View style={styles.tagResultName}>
                      <Ionicons name={tag.key === criteria.tagKey ? 'checkmark-circle' : 'pricetag-outline'} size={17} color={tag.key === criteria.tagKey ? colors.blue : colors.secondary} />
                      <Text numberOfLines={1} style={{ flex: 1, color: tag.key === criteria.tagKey ? colors.blue : colors.text }}>{tag.name}</Text>
                    </View>
                    <Text style={{ color: colors.secondary }}>{tag.count}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            </>
          ) : null}
          {normalizedDraft ? (
            <Pressable accessibilityRole="button" style={({ pressed }) => [styles.articleSearchAction, { backgroundColor: colors.selected }, pressed && styles.pressed]} onPress={submitSearch}>
              <Ionicons name="search-outline" size={18} color={colors.blue} />
              <Text numberOfLines={2} style={[styles.articleSearchText, { color: colors.blue }]}>{t('searchArticlesContaining', { query: normalizedDraft })}</Text>
              <Ionicons name="return-down-back-outline" size={17} color={colors.blue} />
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function FilterChip({ icon, label, onClear }: { icon: keyof typeof Ionicons.glyphMap; label: string; onClear: () => void }) {
  const colors = useThemeColors();
  return (
    <View style={[styles.filterChip, { backgroundColor: colors.selected }]}>
      <Ionicons name={icon} size={15} color={colors.blue} />
      <Text numberOfLines={1} style={[styles.filterChipText, { color: colors.blue }]}>{label}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={t('clearFilter', { label })} hitSlop={6} onPress={onClear}>
        <Ionicons name="close" size={15} color={colors.blue} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  toolbar: { borderBottomWidth: StyleSheet.hairlineWidth, zIndex: 2 },
  topRow: { height: 64, paddingHorizontal: spacing.xl, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  compactTopRow: { height: 52, paddingHorizontal: spacing.lg },
  unreadControl: { flexShrink: 0, height: 34, borderRadius: radius.control, paddingHorizontal: spacing.md, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  searchArea: { flex: 1, minWidth: 0, height: 40, position: 'relative', justifyContent: 'center' },
  activeFilters: { flex: 1, minWidth: 0 },
  activeFiltersContent: { alignItems: 'center', gap: spacing.sm, paddingRight: 38 },
  searchButton: { position: 'absolute', right: 0, width: 34, height: 40, alignItems: 'center', justifyContent: 'center' },
  inlineSearch: { position: 'absolute', top: 0, right: 0, bottom: 0, zIndex: 1, flexDirection: 'row', alignItems: 'center' },
  searchInput: { height: 40 },
  inlineSearchClose: { width: 34, height: 40, alignItems: 'center', justifyContent: 'center' },
  filterChip: { height: 30, maxWidth: Platform.OS === 'web' ? 240 : 180, borderRadius: radius.round, paddingHorizontal: spacing.sm, flexDirection: 'row', alignItems: 'center', gap: 5 },
  filterChipText: { flexShrink: 1, fontSize: 12, fontWeight: '600' },
  searchPanel: { paddingHorizontal: spacing.xl, paddingTop: spacing.lg, paddingBottom: spacing.xl, borderTopWidth: StyleSheet.hairlineWidth },
  compactSearchPanel: { paddingHorizontal: spacing.lg },
  sectionLabel: { marginTop: spacing.lg, marginBottom: spacing.sm, fontSize: 12, fontWeight: '700' },
  loading: { paddingVertical: spacing.xl },
  tagResults: { maxHeight: Platform.OS === 'web' ? 220 : 180 },
  tagResult: { minHeight: 42, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.lg },
  tagResultName: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  articleSearchAction: { minHeight: 44, marginTop: spacing.md, borderRadius: radius.control, paddingHorizontal: spacing.md, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  articleSearchText: { flex: 1, fontWeight: '700' },
  pressed: { opacity: 0.6 },
});
