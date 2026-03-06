// Plugin Manager — Central registry for all plugin registrations
// Provides the PluginContext API passed to each plugin's activate() function

import { broadcast } from '../ws.js';
import * as state from '../state.js';

// --- State registries ---
const plugins = new Map();           // pluginName → { name, version, description, active }
const postExecutionHooks = [];       // { pluginName, name, priority, handler }
const preExecutionHooks = [];        // { pluginName, name, priority, handler }
const postPlanningHooks = [];        // { pluginName, name, priority, handler }
const customTools = new Map();       // toolName → { pluginName, description, allowedPhases, handler }
const customParsers = new Map();     // parserName → { pluginName, phase, priority, handler }
const taskValidators = [];           // { pluginName, name, priority, handler }
const eventListeners = new Map();    // eventName → [{ pluginName, handler }]

// --- Plugin registration ---

export function registerPlugin(name, info) {
  plugins.set(name, info);
}

// --- Context factory ---

export function createPluginContext(pluginName) {
  return {
    registerPostExecutionHook(name, handler, { priority = 100 } = {}) {
      postExecutionHooks.push({ pluginName, name, priority, handler });
      postExecutionHooks.sort((a, b) => a.priority - b.priority);
    },

    registerPreExecutionHook(name, handler, { priority = 100 } = {}) {
      preExecutionHooks.push({ pluginName, name, priority, handler });
      preExecutionHooks.sort((a, b) => a.priority - b.priority);
    },

    registerPostPlanningHook(name, handler, { priority = 100 } = {}) {
      postPlanningHooks.push({ pluginName, name, priority, handler });
      postPlanningHooks.sort((a, b) => a.priority - b.priority);
    },

    registerTool(name, { description = '', allowedPhases = ['execution'], handler } = {}) {
      customTools.set(name, { pluginName, description, allowedPhases, handler });
    },

    registerParser(name, { phase = 'execution', priority = 100, handler } = {}) {
      customParsers.set(name, { pluginName, phase, priority, handler });
    },

    registerTaskValidator(name, handler, { priority = 100 } = {}) {
      taskValidators.push({ pluginName, name, priority, handler });
      taskValidators.sort((a, b) => a.priority - b.priority);
    },

    on(eventName, handler) {
      if (!eventListeners.has(eventName)) {
        eventListeners.set(eventName, []);
      }
      eventListeners.get(eventName).push({ pluginName, handler });
    },

    getProject(id) {
      return state.getProject(id);
    },

    getTask(id) {
      return state.getTask(id);
    },

    broadcast(event, data) {
      broadcast(event, data);
    },

    log(message) {
      console.log(`[plugin:${pluginName}] ${message}`);
    },
  };
}

// --- Runner integration functions ---

export async function runPostExecutionHooks(task, result, project) {
  for (const hook of postExecutionHooks) {
    try {
      await hook.handler({ task, project, result });
    } catch (err) {
      console.error(`[plugin:${hook.pluginName}] Post-execution hook "${hook.name}" failed:`, err.message);
    }
  }
}

export async function runPreExecutionHooks(task, project) {
  for (const hook of preExecutionHooks) {
    try {
      await hook.handler({ task, project });
    } catch (err) {
      console.error(`[plugin:${hook.pluginName}] Pre-execution hook "${hook.name}" failed:`, err.message);
    }
  }
}

export async function runPostPlanningHooks(task, plan, project) {
  for (const hook of postPlanningHooks) {
    try {
      await hook.handler({ task, plan, project });
    } catch (err) {
      console.error(`[plugin:${hook.pluginName}] Post-planning hook "${hook.name}" failed:`, err.message);
    }
  }
}

export async function runTaskValidators(task, result, project) {
  for (const validator of taskValidators) {
    try {
      const outcome = await validator.handler({ task, project, result });
      if (outcome && !outcome.valid) {
        return { valid: false, validatorName: validator.name, message: outcome.message || 'Validation failed' };
      }
    } catch (err) {
      console.error(`[plugin:${validator.pluginName}] Task validator "${validator.name}" failed:`, err.message);
      // Validator errors don't block — treat as pass
    }
  }
  return { valid: true };
}

export function runCustomParsers(phase, stdout) {
  const parsers = [...customParsers.values()]
    .filter((p) => p.phase === phase)
    .sort((a, b) => a.priority - b.priority);

  for (const parser of parsers) {
    try {
      const result = parser.handler(stdout, phase);
      if (result) return result;
    } catch (err) {
      console.error(`[plugin:${parser.pluginName}] Custom parser failed:`, err.message);
    }
  }
  return null;
}

export function getCustomToolNames(phase) {
  const names = [];
  for (const [toolName, tool] of customTools) {
    if (tool.allowedPhases.includes(phase)) {
      names.push(toolName);
    }
  }
  return names;
}

export function emitPluginEvent(eventName, data) {
  const listeners = eventListeners.get(eventName);
  if (!listeners) return;
  for (const listener of listeners) {
    try {
      listener.handler(data);
    } catch (err) {
      console.error(`[plugin:${listener.pluginName}] Event handler for "${eventName}" failed:`, err.message);
    }
  }
}

// --- API query functions ---

export function getRegisteredPlugins() {
  return [...plugins.values()];
}

export function getPluginCapabilities() {
  return {
    postExecutionHooks: postExecutionHooks.map((h) => ({ pluginName: h.pluginName, name: h.name, priority: h.priority })),
    preExecutionHooks: preExecutionHooks.map((h) => ({ pluginName: h.pluginName, name: h.name, priority: h.priority })),
    postPlanningHooks: postPlanningHooks.map((h) => ({ pluginName: h.pluginName, name: h.name, priority: h.priority })),
    customTools: [...customTools.entries()].map(([name, t]) => ({ name, pluginName: t.pluginName, description: t.description, allowedPhases: t.allowedPhases })),
    customParsers: [...customParsers.entries()].map(([name, p]) => ({ name, pluginName: p.pluginName, phase: p.phase, priority: p.priority })),
    taskValidators: taskValidators.map((v) => ({ pluginName: v.pluginName, name: v.name, priority: v.priority })),
    eventListeners: [...eventListeners.entries()].map(([event, listeners]) => ({ event, count: listeners.length, plugins: listeners.map((l) => l.pluginName) })),
  };
}
