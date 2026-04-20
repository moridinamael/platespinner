import { useCallback, useEffect, useRef } from 'react';
import { startTransition } from 'react';
import { WebSocketManager, api } from '../api.js';

/**
 * Manages the WebSocket connection and dispatches app-level events
 * (test status, railway status, agent census, notifications, autoclicker)
 * while delegating task/project events to their respective handlers.
 */
export function useWebSocket({
  handleProjectWsEvent,
  handleTaskWsEvent,
  handleActivityWsEvent,
  setTestStatusMap,
  setRailwayStatusMap,
  setAgentCensus,
  setAutoclickerStatus,
  setNotificationSettings,
  showToast,
}) {
  // Keep dispatchers in a ref so the callback stays stable across renders
  const dispatchersRef = useRef({
    handleProjectWsEvent,
    handleTaskWsEvent,
    handleActivityWsEvent,
    setTestStatusMap,
    setRailwayStatusMap,
    setAgentCensus,
    setAutoclickerStatus,
    setNotificationSettings,
    showToast,
  });
  useEffect(() => {
    dispatchersRef.current = {
      handleProjectWsEvent,
      handleTaskWsEvent,
      handleActivityWsEvent,
      setTestStatusMap,
      setRailwayStatusMap,
      setAgentCensus,
      setAutoclickerStatus,
      setNotificationSettings,
      showToast,
    };
  });

  const handleWsMessage = useCallback((event, data) => {
    const d = dispatchersRef.current;
    d.handleProjectWsEvent(event, data);
    d.handleTaskWsEvent(event, data);
    d.handleActivityWsEvent(event, data);

    switch (event) {
      case 'project:removed':
        d.setTestStatusMap((prev) => { const next = { ...prev }; delete next[data.id]; return next; });
        d.setRailwayStatusMap((prev) => { const next = { ...prev }; delete next[data.id]; return next; });
        break;
      case 'project:test-started':
        startTransition(() => {
          d.setTestStatusMap((prev) => ({
            ...prev,
            [data.projectId]: { running: true },
          }));
        });
        break;
      case 'project:test-completed':
        startTransition(() => {
          d.setTestStatusMap((prev) => ({
            ...prev,
            [data.projectId]: {
              running: false,
              result: { passed: data.passed, summary: data.summary, output: data.output, checkedAt: Date.now() },
            },
          }));
        });
        break;
      case 'project:railway-checking':
        startTransition(() => {
          d.setRailwayStatusMap((prev) => ({
            ...prev,
            [data.projectId]: { ...prev[data.projectId], status: 'checking' },
          }));
        });
        break;
      case 'project:railway-status':
        startTransition(() => {
          d.setRailwayStatusMap((prev) => ({
            ...prev,
            [data.projectId]: {
              status: data.healthy ? 'healthy' : 'failed',
              message: data.message,
              checkedAt: data.timestamp || Date.now(),
            },
          }));
        });
        break;
      case 'agents:census':
        startTransition(() => {
          d.setAgentCensus(data);
        });
        break;
      case 'notification': {
        if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
          const titleMap = {
            'task:completed': 'Task Completed',
            'task:failed': 'Task Failed',
            'all-tasks:done': 'All Tasks Done!',
            'test:failure': 'Tests Failed',
            'budget:exceeded': 'Budget Exceeded',
            'cost:threshold-exceeded': 'Cost Threshold Exceeded',
            'test:notification': 'Test Notification',
          };
          const title = titleMap[data.type] || 'PlateSpinner Notification';
          const body = data.taskTitle || data.summary || data.message || '';
          new Notification(title, {
            body: `${data.projectName}: ${body}`,
            tag: `kanban-${data.type}-${data.taskId || data.projectId}`,
            requireInteraction: data.type === 'all-tasks:done',
          });
        }
        break;
      }
      case 'notification-settings:updated':
        if (!data.projectId || data.projectId === 'global') {
          d.setNotificationSettings(data.settings);
        }
        break;
      case 'autoclicker:started':
      case 'autoclicker:stopped':
      case 'autoclicker:decision':
      case 'autoclicker:phase':
      case 'autoclicker:cycle-complete':
      case 'autoclicker:error':
      case 'autoclicker:project-paused':
      case 'autoclicker:project-disabled':
      case 'autoclicker:merge-conflict':
      case 'autoclicker:merge-complete':
        api.getAutoclickerStatus().then(d.setAutoclickerStatus).catch(err => console.warn('Failed to refresh autoclicker status:', err));
        break;
    }
  }, []);

  useEffect(() => {
    const manager = new WebSocketManager(handleWsMessage);
    return () => manager.disconnect();
  }, [handleWsMessage]);
}
