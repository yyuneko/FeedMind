import type { ArticleCollection } from '@/types';

export function collectionFromPath(pathname: string): ArticleCollection | null {
  if (pathname === '/' || pathname === '/all') return { kind: 'all' };
  if (pathname === '/recent') return { kind: 'recent' };
  if (pathname === '/saved') return { kind: 'saved' };
  const category = pathname.match(/^\/category\/([^/]+)$/);
  if (category) return { kind: 'category', categoryId: decodeURIComponent(category[1]) };
  const feed = pathname.match(/^\/feed\/([^/]+)$/);
  if (feed) return { kind: 'feed', sourceId: decodeURIComponent(feed[1]) };
  return null;
}

export function collectionPath(collection: ArticleCollection): string {
  if (collection.kind === 'all') return '/all';
  if (collection.kind === 'recent') return '/recent';
  if (collection.kind === 'saved') return '/saved';
  if (collection.kind === 'category') return `/category/${encodeURIComponent(collection.categoryId)}`;
  return `/feed/${encodeURIComponent(collection.sourceId)}`;
}
