import { randomUUID } from 'crypto';
import { broadcast } from './ws.js';

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
  const counts = { generating: 0, planning: 0, executing: 0, settingUpTests: 0, total: agents.length };
  for (const a of agents) {
    if (a.type === 'generating') counts.generating++;
    else if (a.type === 'planning') counts.planning++;
    else if (a.type === 'executing') counts.executing++;
    else if (a.type === 'settingUpTests') counts.settingUpTests++;
  }
  return { counts, agents };
}

function broadcastCensus() {
  broadcast('agents:census', getAgentCounts());
}
