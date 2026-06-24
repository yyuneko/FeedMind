const CATEGORY_SEPARATOR = '\n';
export const UNCATEGORIZED_CATEGORY = 'Uncategorized';

export const parseFeedCategories = (category?: string | null) => {
  const raw = category?.trim();
  if (!raw) return [UNCATEGORIZED_CATEGORY];
  const categories = raw
    .split(raw.includes(CATEGORY_SEPARATOR) ? CATEGORY_SEPARATOR : ',')
    .map((item) => item.trim())
    .filter((item) => item && item !== UNCATEGORIZED_CATEGORY);
  return [...new Set(categories.length ? categories : [UNCATEGORIZED_CATEGORY])];
};

export const serializeFeedCategories = (category: string | string[]) => {
  const categories = (Array.isArray(category) ? category : category.split(/[\n,]/))
    .map((item) => item.trim())
    .filter((item) => item && item !== UNCATEGORIZED_CATEGORY);
  return [...new Set(categories)].join(CATEGORY_SEPARATOR);
};

export const formatFeedCategories = (category: string) => parseFeedCategories(category).join(', ');

export const formatEditableFeedCategories = (category: string) => serializeFeedCategories(category).split(CATEGORY_SEPARATOR).join(', ');
