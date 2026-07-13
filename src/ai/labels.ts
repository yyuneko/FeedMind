import { getLocale } from '@/i18n';

const labels = {
  zh: { provider: 'AI 服务商', apiKey: 'API Key', endpoint: '接口地址', model: '模型', customModel: '输入自定义模型 ID', apiKeyRequired: (provider: string) => `请输入 ${provider} API Key` },
  en: { provider: 'AI Provider', apiKey: 'API Key', endpoint: 'API Endpoint', model: 'Model', customModel: 'Enter a custom model ID', apiKeyRequired: (provider: string) => `Enter your ${provider} API Key` },
  ja: { provider: 'AI プロバイダー', apiKey: 'API Key', endpoint: 'API エンドポイント', model: 'モデル', customModel: 'カスタムモデル ID を入力', apiKeyRequired: (provider: string) => `${provider} API Key を入力してください` },
};

export const getAiLabels = () => labels[getLocale()];
