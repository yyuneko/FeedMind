import { ArticleListScreen } from '@/screens/ArticleListScreen';
import { FeedsScreen } from '@/screens/FeedsScreen';
import { useDesktopLayout } from '@/hooks/useDesktopLayout';

export default function ArticleCategoryRoute() {
  return useDesktopLayout() ? <FeedsScreen /> : <ArticleListScreen />;
}


