import { useState, useCallback, useMemo } from 'react';
import { api } from '../api.js';

export function useProjects(showToast) {
  const [projects, setProjects] = useState([]);
  const [selectedProjectId, setSelectedProjectId] = useState(null);

  const selectedProject = useMemo(
    () => projects.find((p) => p.id === selectedProjectId),
    [projects, selectedProjectId]
  );

  const handleAddProject = useCallback(async ({ name, path }) => {
    try {
      await api.addProject({ name, path });
    } catch (err) {
      showToast(err.message, 'error');
    }
  }, [showToast]);

  const handleRemoveProject = useCallback(async (id) => {
    try {
      await api.removeProject(id);
    } catch (err) {
      showToast(err.message, 'error');
    }
  }, [showToast]);

  const handleUpdateProjectUrl = useCallback(async (id, url) => {
    try {
      await api.updateProject(id, { url });
    } catch (err) {
      showToast(err.message, 'error');
    }
  }, [showToast]);

  const handleReorderProjects = useCallback(async (orderedIds) => {
    setProjects((prev) => {
      const map = new Map(prev.map(p => [p.id, p]));
      return orderedIds.map(id => map.get(id)).filter(Boolean);
    });
    try {
      await api.reorderProjects(orderedIds);
    } catch (err) {
      api.getProjects().then(setProjects).catch(console.error);
      showToast(err.message, 'error');
    }
  }, [showToast]);

  const handleProjectWsEvent = useCallback((event, data) => {
    switch (event) {
      case 'project:created':
        setProjects((prev) => [...prev, data]);
        break;
      case 'project:updated':
        setProjects((prev) => prev.map((p) => (p.id === data.id ? data : p)));
        break;
      case 'project:removed':
        setProjects((prev) => prev.filter((p) => p.id !== data.id));
        break;
      case 'projects:reordered': {
        const { orderedIds } = data;
        setProjects((prev) => {
          const map = new Map(prev.map(p => [p.id, p]));
          const reordered = orderedIds.map(id => map.get(id)).filter(Boolean);
          const remaining = prev.filter(p => !orderedIds.includes(p.id));
          return [...reordered, ...remaining];
        });
        break;
      }
    }
  }, []);

  return {
    projects, setProjects,
    selectedProjectId, setSelectedProjectId,
    selectedProject,
    handleAddProject, handleRemoveProject,
    handleUpdateProjectUrl, handleReorderProjects,
    handleProjectWsEvent,
  };
}
