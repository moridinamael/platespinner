// Extract structured output from Claude CLI --output-format json
export function extractClaudeJsonOutput(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    return {
      text: parsed.result || '',
      costUsd: parsed.cost_usd || parsed.total_cost_usd || null,
      numTurns: parsed.num_turns || null,
      durationMs: parsed.duration_ms || null,
      durationApiMs: parsed.duration_api_ms || null,
      inputTokens: parsed.usage?.input_tokens || null,
      outputTokens: parsed.usage?.output_tokens || null,
      isError: parsed.is_error || false,
      sessionId: parsed.session_id || null,
    };
  } catch {
    return { text: stdout, costUsd: null, numTurns: null, durationMs: null,
             durationApiMs: null, inputTokens: null, outputTokens: null,
             isError: false, sessionId: null };
  }
}

// Rough token estimation for non-Claude providers (~1 token per 4 chars)
export function estimateTokensFromText(text) {
  return Math.ceil((text || '').length / 4);
}

// Multi-fallback parser for agent stdout

export function parseGenerationOutput(stdout) {
  // Strategy 1: Extract from <task-proposals> tags
  const tagMatch = stdout.match(/<task-proposals>([\s\S]*?)<\/task-proposals>/);
  if (tagMatch) {
    try {
      const parsed = JSON.parse(tagMatch[1].trim());
      if (Array.isArray(parsed)) return parsed;
    } catch { /* fall through */ }
  }

  // Strategy 2: Find JSON array with expected keys
  const arrayMatch = stdout.match(/\[[\s\S]*?\{[\s\S]*?"title"[\s\S]*?\}[\s\S]*?\]/);
  if (arrayMatch) {
    try {
      const parsed = JSON.parse(arrayMatch[0]);
      if (Array.isArray(parsed) && parsed[0]?.title) return parsed;
    } catch { /* fall through */ }
  }

  // Strategy 3: Find individual JSON objects with title key
  const objects = [];
  const objRegex = /\{[^{}]*"title"\s*:\s*"[^"]+?"[^{}]*\}/g;
  let match;
  while ((match = objRegex.exec(stdout)) !== null) {
    try {
      objects.push(JSON.parse(match[0]));
    } catch { /* skip */ }
  }
  if (objects.length > 0) return objects;

  // Strategy 4: No structured proposals found — return empty
  // (The agent produced conversational output without task-proposals tags)
  return [];
}

export function parseTestSetupOutput(stdout) {
  // Strategy 1: Extract from <test-setup-result> tags
  const tagMatch = stdout.match(/<test-setup-result>([\s\S]*?)<\/test-setup-result>/);
  if (tagMatch) {
    try {
      return JSON.parse(tagMatch[1].trim());
    } catch { /* fall through */ }
  }

  // Strategy 2: Look for JSON with testCommand key
  const objMatch = stdout.match(/\{[\s\S]*?"testCommand"[\s\S]*?\}/);
  if (objMatch) {
    try {
      return JSON.parse(objMatch[0]);
    } catch { /* fall through */ }
  }

  // Strategy 3: Heuristic — check for commit
  const commitMatch = stdout.match(/\b([0-9a-f]{7,40})\b/);
  const hasCommit = commitMatch && stdout.toLowerCase().includes('commit');

  return {
    success: hasCommit || false,
    testCommand: null,
    commitHash: hasCommit ? commitMatch[1] : null,
    summary: stdout.slice(0, 1000),
  };
}

export function parsePlanningOutput(stdout) {
  // Strategy 1: Extract from <implementation-plan> tags
  const tagMatch = stdout.match(/<implementation-plan>([\s\S]*?)<\/implementation-plan>/);
  if (tagMatch) {
    try {
      const parsed = JSON.parse(tagMatch[1].trim());
      if (parsed.plan) return parsed.plan;
    } catch { /* fall through */ }
    // If not valid JSON, return the raw content inside the tags
    return tagMatch[1].trim();
  }

  // Strategy 2: Find JSON with "plan" key
  const objMatch = stdout.match(/\{[\s\S]*?"plan"[\s\S]*?\}/);
  if (objMatch) {
    try {
      const parsed = JSON.parse(objMatch[0]);
      if (parsed.plan) return parsed.plan;
    } catch { /* fall through */ }
  }

  // Strategy 3: Fallback — return raw stdout as plan text
  return stdout.slice(0, 10000);
}

export function parseJudgmentOutput(stdout) {
  const match = stdout.match(/<autoclicker-decision>([\s\S]*?)<\/autoclicker-decision>/);
  if (!match) {
    return { action: 'skip', reasoning: 'No decision tags found in output' };
  }
  try {
    const decision = JSON.parse(match[1].trim());
    if (!['propose', 'plan', 'execute', 'skip'].includes(decision.action)) {
      return { action: 'skip', reasoning: `Invalid action: ${decision.action}` };
    }
    return {
      action: decision.action,
      targetTaskId: decision.targetTaskId || null,
      templateId: decision.templateId || null,
      reasoning: decision.reasoning || 'No reasoning provided',
    };
  } catch (err) {
    return { action: 'skip', reasoning: `Failed to parse decision JSON: ${err.message}` };
  }
}

export function parseExecutionOutput(stdout) {
  // Strategy 1: Extract from <execution-result> tags
  const tagMatch = stdout.match(/<execution-result>([\s\S]*?)<\/execution-result>/);
  if (tagMatch) {
    try {
      return JSON.parse(tagMatch[1].trim());
    } catch { /* fall through */ }
  }

  // Strategy 2: Find JSON object with expected keys
  const objMatch = stdout.match(/\{[\s\S]*?"success"[\s\S]*?"commitHash"[\s\S]*?\}/);
  if (objMatch) {
    try {
      return JSON.parse(objMatch[0]);
    } catch { /* fall through */ }
  }

  // Strategy 3: Check for commit hash in output
  const commitMatch = stdout.match(/\b([0-9a-f]{7,40})\b/);
  const hasCommit = commitMatch && stdout.toLowerCase().includes('commit');

  return {
    success: hasCommit || false,
    commitHash: hasCommit ? commitMatch[1] : null,
    commitMessage: null,
    summary: stdout.slice(0, 1000),
  };
}
