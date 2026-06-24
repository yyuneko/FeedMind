import { getLocale } from '@/i18n';

export const nowIso = () => new Date().toISOString();

const getIntlLocale = () => {
  const locale = getLocale();
  if (locale === 'zh') return 'zh-CN';
  if (locale === 'ja') return 'ja-JP';
  return 'en';
};

export const formatRelativeTime = (value: string | null) => {
  if (!value) return '';
  const diff = Date.now() - new Date(value).getTime();
  const minutes = Math.max(1, Math.floor(diff / 60000));
  const locale = getLocale();
  if (minutes < 60) {
    if (locale === 'zh') return `${minutes} 分钟前`;
    if (locale === 'ja') return `${minutes} 分前`;
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    if (locale === 'zh') return `${hours} 小时前`;
    if (locale === 'ja') return `${hours} 時間前`;
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  if (locale === 'zh') return `${days} 天前`;
  if (locale === 'ja') return `${days} 日前`;
  return `${days}d ago`;
};

export const formatArticleDate = (value: string | null) => {
  if (!value) return '';
  return new Intl.DateTimeFormat(getIntlLocale(), {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
};
