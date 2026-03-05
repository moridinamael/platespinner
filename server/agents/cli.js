// Build CLI commands for each agent type
// Model is now explicit per-invocation via modelId

import { getModel } from '../models.js';

export function buildGenerationCommand(modelId, prompt) {
  const model = getModel(modelId);
  if (!model) throw new Error(`Unknown model: ${modelId}`);

  switch (model.provider) {
    case 'claude':
      return {
        cmd: 'claude',
        args: ['-p', '--model', modelId, '--output-format', 'json', '--allowedTools', 'Read,Glob,Grep'],
        useStdin: true,
      };
    case 'codex':
      return {
        cmd: 'codex',
        args: ['exec', prompt, '--model', modelId, '--sandbox', 'read-only'],
        useStdin: false,
      };
    case 'gemini':
      return {
        cmd: 'gemini',
        args: ['--model', modelId, '-p', prompt],
        useStdin: false,
      };
    default:
      throw new Error(`Unknown provider: ${model.provider}`);
  }
}

export function buildTestSetupCommand(modelId, prompt) {
  // Same tools as execution — agent needs to read, write, and run tests
  return buildExecutionCommand(modelId, prompt);
}

export function buildExecutionCommand(modelId, prompt) {
  const model = getModel(modelId);
  if (!model) throw new Error(`Unknown model: ${modelId}`);

  switch (model.provider) {
    case 'claude':
      return {
        cmd: 'claude',
        args: ['-p', '--model', modelId, '--output-format', 'json', '--allowedTools', 'Read,Glob,Grep,Write,Edit,Bash'],
        useStdin: true,
      };
    case 'codex':
      return {
        cmd: 'codex',
        args: ['exec', prompt, '--model', modelId],
        useStdin: false,
      };
    case 'gemini':
      return {
        cmd: 'gemini',
        args: ['--model', modelId, '--yolo', '-p', prompt],
        useStdin: false,
      };
    default:
      throw new Error(`Unknown provider: ${model.provider}`);
  }
}
