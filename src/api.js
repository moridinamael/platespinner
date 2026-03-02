// REST helpers
const BASE = '/api';

async function request(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  if (res.status === 204) return null;
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

export const api = {
  getProjects: () => request('GET', '/projects'),
  addProject: (data) => request('POST', '/projects', data),
  updateProject: (id, data) => request('PATCH', `/projects/${id}`, data),
  removeProject: (id) => request('DELETE', `/projects/${id}`),
  getTasks: (projectId) => request('GET', projectId ? `/tasks?projectId=${projectId}` : '/tasks'),
  getTemplates: () => request('GET', '/templates'),
  createTemplate: (data) => request('POST', '/templates', data),
  deleteTemplate: (id) => request('DELETE', `/templates/${id}`),
  getModels: () => request('GET', '/models'),
  generate: (projectId, templateId, modelId, promptContent) => request('POST', '/generate', { projectId, templateId, modelId, promptContent }),
  planTask: (id, modelId) => request('POST', `/tasks/${id}/plan`, { modelId }),
  executeTask: (id, modelId) => request('POST', `/tasks/${id}/execute`, { modelId }),
  dismissTask: (id) => request('POST', `/tasks/${id}/dismiss`),
  abortTask: (id) => request('POST', `/tasks/${id}/abort`),
  pushProject: (id) => request('POST', `/projects/${id}/push`),
  getGitStatus: (id) => request('GET', `/projects/${id}/git-status`),
  getTestInfo: (id) => request('GET', `/projects/${id}/test-info`),
  getLastTestResult: (id) => request('GET', `/projects/${id}/last-test-result`),
  runTests: (id) => request('POST', `/projects/${id}/test`),
  setupTests: (id) => request('POST', `/projects/${id}/setup-tests`),
  createFixTask: (projectId, data) => request('POST', `/projects/${projectId}/fix-tests`, data),
  checkRailway: (id) => request('POST', `/projects/${id}/check-railway`),
  getAgentStatus: () => request('GET', '/agents/status'),
};

// WebSocket hook
export function connectWebSocket(onMessage) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;
  const ws = new WebSocket(wsUrl);

  ws.onmessage = (evt) => {
    try {
      const { event, data } = JSON.parse(evt.data);
      onMessage(event, data);
    } catch { /* ignore malformed */ }
  };

  ws.onclose = () => {
    // Reconnect after 2s
    setTimeout(() => connectWebSocket(onMessage), 2000);
  };

  return ws;
}
