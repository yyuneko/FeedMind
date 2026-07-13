import { t as baseT, type MessageKey } from '@/i18n';
import { getAiLabels } from './labels';

export const aiComponentText = (key: MessageKey | 'customModel') =>
  key === 'customModel' ? getAiLabels().customModel : baseT(key);
