const CATEGORY_SEPARATOR = '\n';
export const UNCATEGORIZED_CATEGORY = 'Uncategorized';

export const parseFeedCategories = (category?: string | null) => {
  const raw = category?.trim();
  if (!raw) return [UNCATEGORIZED_CATEGORY];
  const categoryName = raw
    .split(raw.includes(CATEGORY_SEPARATOR) ? CATEGORY_SEPARATOR : ',')
    .map((item) => item.trim())
    .find((item) => item && item !== UNCATEGORIZED_CATEGORY);
  return [categoryName ?? UNCATEGORIZED_CATEGORY];
};

export const serializeFeedCategories = (category: string | string[]) => {
  const categoryName = (Array.isArray(category) ? category : category.split(/[\n,]/))
    .map((item) => item.trim())
    .find((item) => item && item !== UNCATEGORIZED_CATEGORY);
  return categoryName ?? '';
};

export const formatFeedCategories = (category: string) => parseFeedCategories(category)[0];

export const formatEditableFeedCategories = (category: string) => serializeFeedCategories(category);
