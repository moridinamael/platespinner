import { randomUUID } from 'crypto';
import { broadcast } from './ws.js';
import { getModel } from './models.js';

const activeAgents = new Map(); // agentId → { id, type, projectId, taskId, modelId, startedAt }

export function registerAgent({ type, projectId, taskId, modelId }) {
  const id = randomUUID();
  const entry = { id, type, projectId, taskId: taskId || null, modelId: modelId || null, startedAt: Date.now() };
  activeAgents.set(id, entry);
  broadcastCensus();
  return id;
}

export function unregisterAgent(agentId) {
  activeAgents.delete(agentId);
  broadcastCensus();
}

export function getAgentCounts() {
  const agents = [...activeAgents.values()];
  const byType = { generating: 0, planning: 0, executing: 0, settingUpTests: 0, ranking: 0 };
  const byProvider = { claude: 0, gemini: 0, codex: 0 };
  for (const a of agents) {
    if (a.type in byType) byType[a.type]++;
    const model = a.modelId ? getModel(a.modelId) : null;
    const provider = model ? model.provider : null;
    if (provider && provider in byProvider) byProvider[provider]++;
  }
  return { total: agents.length, byType, byProvider, agents };
}

let censusTimer = null;
let censusPending = false;

function broadcastCensus() {
  if (censusTimer) {
    censusPending = true;
    return;
  }
  broadcast('agents:census', getAgentCounts());
  censusTimer = setTimeout(() => {
    censusTimer = null;
    if (censusPending) {
      censusPending = false;
      broadcastCensus();
    }
  }, 1000);
}
