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
  updateTask: (id, updates) => request('PATCH', `/tasks/${id}`, updates),
  getTemplates: () => request('GET', '/templates'),
  createTemplate: (data) => request('POST', '/templates', data),
  deleteTemplate: (id) => request('DELETE', `/templates/${id}`),
  getModels: () => request('GET', '/models'),
  generate: (projectId, templateId, modelId, promptContent) => request('POST', '/generate', { projectId, templateId, modelId, promptContent }),
  planTask: (id, modelId) => request('POST', `/tasks/${id}/plan`, { modelId }),
  executeTask: (id, modelId) => request('POST', `/tasks/${id}/execute`, { modelId }),
  dismissTask: (id) => request('POST', `/tasks/${id}/dismiss`),
  getQueues: () => request('GET', '/tasks/queue'),
  getQueue: (projectId) => request('GET', `/tasks/queue?projectId=${projectId}`),
  dequeueTask: (id) => request('POST', `/tasks/${id}/dequeue`),
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
  startAutoclicker: (config) => request('POST', '/autoclicker/start', config),
  stopAutoclicker: () => request('POST', '/autoclicker/stop'),
  getAutoclickerStatus: () => request('GET', '/autoclicker/status'),
};

// WebSocket manager — tracks connection lifecycle with backoff & cleanup
export class WebSocketManager {
  constructor(onMessage) {
    this._onMessage = onMessage;
    this._ws = null;
    this._reconnectTimer = null;
    this._attempt = 0;
    this._disposed = false;
    this._connect();
  }

  _getDelay() {
    const base = Math.min(2000 * Math.pow(2, this._attempt), 30000);
    const jitter = Math.random() * 1000;
    return base + jitter;
  }

  _connect() {
    if (this._disposed) return;

    // Close any existing connection before creating a new one
    if (this._ws) {
      this._ws.onclose = null;
      this._ws.onmessage = null;
      this._ws.close();
      this._ws = null;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      this._attempt = 0;
    };

    ws.onmessage = (evt) => {
      try {
        const { event, data } = JSON.parse(evt.data);
        this._onMessage(event, data);
      } catch { /* ignore malformed */ }
    };

    ws.onclose = () => {
      if (this._disposed) return;
      const delay = this._getDelay();
      this._attempt++;
      this._reconnectTimer = setTimeout(() => this._connect(), delay);
    };

    this._ws = ws;
  }

  disconnect() {
    this._disposed = true;
    clearTimeout(this._reconnectTimer);
    if (this._ws) {
      this._ws.onclose = null;
      this._ws.onmessage = null;
      this._ws.close();
      this._ws = null;
    }
  }
}
