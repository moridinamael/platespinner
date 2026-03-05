import { execFile } from 'child_process';
import { broadcast } from '../ws.js';
import { toWSLPath } from '../paths.js';
import { DEFAULT_MODEL_ID } from '../models.js';
import { buildGenerationCommand } from './cli.js';
import { buildJudgmentPrompt, getBuiltInTemplates } from './prompts.js';
import { parseJudgmentOutput, extractClaudeJsonOutput } from './parser.js';
import { runGeneration, runPlanning, runExecution, spawnAgent } from './runner.js';
import * as state from '../state.js';

let orchestratorRunning = false;
let activeProcessCount = 0;
const projectCycleStatus = new Map(); // projectId → status string
const MAX_CYCLES_PER_PROJECT = 50;
const MAX_CONSECUTIVE_FAILURES = 3;

function _sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function _getGitLog(projectPath) {
  return new Promise((resolve) => {
    execFile('git', ['log', '--oneline', '-10'], { cwd: toWSLPath(projectPath), timeout: 10_000 }, (err, stdout) => {
      resolve(err ? '' : stdout.trim());
    });
  });
}

async function _runJudgmentAgent(project, tasks, templates, gitLog, testResult) {
  const prompt = buildJudgmentPrompt(project, tasks, templates, gitLog, testResult);
  const { cmd, args, useStdin } = buildGenerationCommand(DEFAULT_MODEL_ID, prompt);

  const { promise } = spawnAgent(
    cmd, args, project.path,
    useStdin ? prompt : null,
    null
  );

  try {
    const stdout = await promise;
    const extracted = extractClaudeJsonOutput(stdout);
    const decision = parseJudgmentOutput(extracted.text);
    decision.costData = {
      costUsd: extracted.costUsd,
      inputTokens: extracted.inputTokens,
      outputTokens: extracted.outputTokens,
      durationMs: extracted.durationMs,
      numTurns: extracted.numTurns,
    };
    return decision;
  } catch (err) {
    return { action: 'skip', reasoning: `Judgment agent failed: ${err.message}`, costData: null };
  }
}

async function _runProjectCycle(project) {
  activeProcessCount++;
  try {
    const tasks = state.getTasks(project.id);
    const templates = [...getBuiltInTemplates(), ...state.getPromptTemplates()];
    const gitLog = await _getGitLog(project.path);
    const testResult = project.lastTestResult;

    // PHASE 1: Judgment
    projectCycleStatus.set(project.id, 'judging');
    broadcast('autoclicker:phase', { projectId: project.id, phase: 'judging' });

    const decision = await _runJudgmentAgent(project, tasks, templates, gitLog, testResult);
    const judgmentCost = decision.costData || null;

    state.addAuditEntry({
      projectId: project.id,
      action: decision.action,
      targetTaskId: decision.targetTaskId || null,
      templateId: decision.templateId || null,
      reasoning: decision.reasoning,
      costUsd: judgmentCost?.costUsd || null,
      inputTokens: judgmentCost?.inputTokens || null,
      outputTokens: judgmentCost?.outputTokens || null,
      durationMs: judgmentCost?.durationMs || null,
    });
    broadcast('autoclicker:decision', { projectId: project.id, decision, costUsd: judgmentCost?.costUsd || null });

    // Attribute judgment cost to target task when applicable
    if (judgmentCost?.costUsd && decision.targetTaskId) {
      const targetTask = state.getTask(decision.targetTaskId);
      if (targetTask) {
        const existingCost = targetTask.costUsd || 0;
        state.updateTask(decision.targetTaskId, {
          tokenUsage: {
            ...(targetTask.tokenUsage || {}),
            judgment: {
              input: judgmentCost.inputTokens,
              output: judgmentCost.outputTokens,
            },
          },
          costUsd: existingCost + judgmentCost.costUsd,
        });
      }
    }

    if (decision.action === 'skip') {
      projectCycleStatus.set(project.id, 'idle');
      state.incrementCycleCount(project.id);
      return;
    }

    // PHASE 2: Execute the decision
    if (decision.action === 'propose') {
      projectCycleStatus.set(project.id, 'proposing');
      broadcast('autoclicker:phase', { projectId: project.id, phase: 'proposing' });
      await runGeneration(project, decision.templateId, DEFAULT_MODEL_ID);
    } else if (decision.action === 'plan') {
      const task = state.getTask(decision.targetTaskId);
      if (task && task.status === 'proposed') {
        projectCycleStatus.set(project.id, 'planning');
        broadcast('autoclicker:phase', { projectId: project.id, phase: 'planning' });
        await runPlanning(task, DEFAULT_MODEL_ID);
      }
    } else if (decision.action === 'execute') {
      const task = state.getTask(decision.targetTaskId);
      if (task && (task.status === 'proposed' || task.status === 'planned')) {
        if (state.isProjectLocked(project.id)) {
          // Project already has an execution running — queue instead
          state.updateTask(task.id, { status: 'queued', executedBy: DEFAULT_MODEL_ID });
          const position = state.enqueueTask(project.id, task.id);
          broadcast('execution:queued', { taskId: task.id, position, projectId: project.id });
          broadcast('autoclicker:phase', { projectId: project.id, phase: 'queued' });
        } else {
          projectCycleStatus.set(project.id, 'executing');
          broadcast('autoclicker:phase', { projectId: project.id, phase: 'executing' });
          await runExecution(task, DEFAULT_MODEL_ID);
        }
      }
    }

    state.resetConsecutiveFailures(project.id);
    state.incrementCycleCount(project.id);
    projectCycleStatus.set(project.id, 'idle');
    broadcast('autoclicker:cycle-complete', { projectId: project.id });
  } catch (err) {
    projectCycleStatus.set(project.id, 'idle');
    throw err;
  } finally {
    activeProcessCount--;
  }
}

async function _runLoop() {
  while (orchestratorRunning) {
    const config = state.getAutoclickerConfig();
    const enabledProjects = config.enabledProjects
      .map(id => state.getProject(id))
      .filter(Boolean);

    if (enabledProjects.length === 0) {
      await _sleep(2000);
      continue;
    }

    for (const project of enabledProjects) {
      if (!orchestratorRunning) break;

      // Re-read config each iteration in case it changed
      const currentConfig = state.getAutoclickerConfig();

      // Check cycle cap
      if (state.getAutoclickerCycleCount(project.id) >= MAX_CYCLES_PER_PROJECT) {
        const updated = currentConfig.enabledProjects.filter(id => id !== project.id);
        state.setAutoclickerConfig({ enabledProjects: updated });
        broadcast('autoclicker:project-paused', { projectId: project.id, reason: 'Cycle cap reached' });
        continue;
      }

      // Check consecutive failure cap
      if (state.getConsecutiveFailures(project.id) >= MAX_CONSECUTIVE_FAILURES) {
        const updated = currentConfig.enabledProjects.filter(id => id !== project.id);
        state.setAutoclickerConfig({ enabledProjects: updated });
        broadcast('autoclicker:project-disabled', { projectId: project.id, reason: '3 consecutive failures' });
        continue;
      }

      // Wait for a process slot
      while (activeProcessCount >= currentConfig.maxParallel && orchestratorRunning) {
        await _sleep(1000);
      }
      if (!orchestratorRunning) break;

      // Standoff timer
      if (currentConfig.standoffSeconds > 0) {
        await _sleep(currentConfig.standoffSeconds * 1000);
      }
      if (!orchestratorRunning) break;

      // Fire off project cycle (don't await — allows parallelism)
      _runProjectCycle(project).catch(err => {
        console.error(`Autoclicker cycle failed for ${project.name}:`, err.message);
        state.incrementConsecutiveFailures(project.id);
        broadcast('autoclicker:error', { projectId: project.id, error: err.message });
      });
    }

    // Brief pause before next round
    await _sleep(2000);
  }
}

export function startOrchestrator(config) {
  if (orchestratorRunning) {
    throw new Error('Autoclicker is already running');
  }

  state.setAutoclickerConfig({
    enabled: true,
    running: true,
    enabledProjects: config.enabledProjectIds,
    maxParallel: config.maxParallel,
    standoffSeconds: config.standoffSeconds,
  });

  // Reset counters for enabled projects
  for (const id of config.enabledProjectIds) {
    state.resetCycleCount(id);
    state.resetConsecutiveFailures(id);
    projectCycleStatus.set(id, 'idle');
  }

  orchestratorRunning = true;
  broadcast('autoclicker:started', { enabledProjects: config.enabledProjectIds });

  // Start the loop (fire and forget)
  _runLoop().catch(err => {
    console.error('Autoclicker loop crashed:', err.message);
    orchestratorRunning = false;
    state.setAutoclickerConfig({ running: false });
    broadcast('autoclicker:error', { error: `Orchestrator loop crashed: ${err.message}` });
  });

  return { success: true };
}

export function stopOrchestrator() {
  orchestratorRunning = false;
  state.setAutoclickerConfig({ running: false });
  broadcast('autoclicker:stopped', {});
}

export function getOrchestratorStatus() {
  const config = state.getAutoclickerConfig();
  const projectStatuses = {};
  for (const [pid, status] of projectCycleStatus) {
    projectStatuses[pid] = status;
  }

  return {
    running: orchestratorRunning,
    activeProcessCount,
    maxParallel: config.maxParallel,
    standoffSeconds: config.standoffSeconds,
    enabledProjects: config.enabledProjects,
    projectStatuses,
    auditLog: state.getAuditLog(20),
  };
}
