import { router, useLocalSearchParams, usePathname } from 'expo-router';
import { useEffect } from 'react';
import { parseSelectionScope, type SelectionScope, useNavigationStore } from '@/store/navigationStore';

export function useRoutedArticleSelection(scope: SelectionScope) {
  const pathname = usePathname();
  const params = useLocalSearchParams<{ id?: string; origin?: string }>();
  const setStoredArticleId = useNavigationStore((state) => state.setArticleId);
  const routeArticleId = pathname.startsWith('/article/') && pathname !== '/article/category' ? params.id : undefined;
  const routeOrigin = parseSelectionScope(params.origin);
  const routeArticleOrigin = useNavigationStore((state) => routeArticleId ? routeOrigin ?? state.articleOrigins[routeArticleId] ?? state.articleOrigin : state.articleOrigin);
  const storedArticleId = useNavigationStore((state) => state.articleIds[scope]);
  const articleId = routeArticleOrigin === scope ? storedArticleId ?? routeArticleId : undefined;

  useEffect(() => {
    if (routeArticleId && routeArticleOrigin === scope) setStoredArticleId(scope, routeArticleId);
    else if (!routeArticleId) setStoredArticleId(scope, null);
  }, [routeArticleId, routeArticleOrigin, pathname, scope, setStoredArticleId]);

  const selectArticle = (id: string | null) => {
    if (id) {
      setStoredArticleId(scope, id);
      const target = { pathname: '/article/[id]' as const, params: { id, origin: scope } };
      if (pathname.startsWith('/article/') && pathname !== '/article/category') router.replace(target);
      else router.push(target);
      return;
    }
    if (router.canGoBack()) {
      router.back();
    } else {
      setStoredArticleId(scope, null);
      router.replace(scope === 'saved' ? '/saved' : scope === 'category' || scope === 'feeds' ? '/feeds' : '/');
    }
  };

  return { selectedArticleId: articleId ?? null, selectArticle };
}
