export function translationBatchTokenBudget(configuredBudget: number, maxOutputTokens: number | null): number {
  if (maxOutputTokens === null) return configuredBudget;
  const outputAwareBudget = Math.max(500, Math.floor(maxOutputTokens * 0.5));
  return Math.min(configuredBudget, outputAwareBudget);
}
