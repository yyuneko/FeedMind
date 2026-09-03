import { Redirect, useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { libraryRepo } from '@/api/repositories';
import { QueryState } from '@/components/QueryState';
import type { LibraryCategory } from '@/types';
import { t } from '@/i18n';

export default function ArticleCategoryCompatibilityRoute() {
  const { category } = useLocalSearchParams<{ category?: string }>();
  const tree = useQuery({ queryKey: ['library-tree'], queryFn: libraryRepo.tree, staleTime: Infinity });
  if (tree.isLoading) return <QueryState title={t('articlesLoading')} loading />;
  const match = tree.data?.categories.find((item: LibraryCategory) => item.name.toLocaleLowerCase() === (category ?? '').trim().toLocaleLowerCase());
  return <Redirect href={match ? `/category/${match.id}` as never : '/all'} />;
}
