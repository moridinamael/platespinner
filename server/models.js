export const MODELS = [
  { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', provider: 'claude',
    pricing: { inputPer1M: 15.00, outputPer1M: 75.00 } },
  { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', provider: 'claude',
    pricing: { inputPer1M: 15.00, outputPer1M: 75.00 } },
  { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro', provider: 'gemini',
    pricing: { inputPer1M: 2.50, outputPer1M: 15.00 } },
  { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', provider: 'codex',
    pricing: { inputPer1M: 5.00, outputPer1M: 15.00 } },
];

export const DEFAULT_MODEL_ID = 'claude-opus-4-7';

export function getModel(id) {
  return MODELS.find((m) => m.id === id);
}

export function estimateCost(modelId, inputTokens, outputTokens) {
  const model = getModel(modelId);
  if (!model?.pricing) return null;
  return (inputTokens * model.pricing.inputPer1M / 1_000_000) +
         (outputTokens * model.pricing.outputPer1M / 1_000_000);
}
