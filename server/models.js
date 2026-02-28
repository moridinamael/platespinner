export const MODELS = [
  { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', provider: 'claude' },
  { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro', provider: 'gemini' },
  { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', provider: 'codex' },
];

export const DEFAULT_MODEL_ID = 'claude-opus-4-6';

export function getModel(id) {
  return MODELS.find((m) => m.id === id);
}
