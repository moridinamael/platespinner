import { useState, useEffect, useRef, useMemo, memo } from 'react';

const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
const modKey = isMac ? '\u2318' : 'Ctrl';

function CommandPalette({ projects, tasks, selectedProjectId, onSelectProject, onSelectTask, onPlan, onExecute, onDismiss, onClose }) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef(null);
  const resultsRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const commands = useMemo(() => {
    const cmds = [];
    // Projects
    cmds.push({ id: 'project:all', type: 'project', label: 'All Projects', description: 'Show all projects', action: () => { onSelectProject(null); onClose(); } });
    projects.forEach(p => {
      cmds.push({
        id: `project:${p.id}`, type: 'project', label: p.name,
        description: p.id === selectedProjectId ? 'Current project' : 'Switch to project',
        action: () => { onSelectProject(p.id); onClose(); },
      });
    });
    // Tasks
    tasks.forEach(t => {
      cmds.push({
        id: `task:${t.id}`, type: 'task', label: t.title,
        description: `${t.status} \u00b7 ${t.effort}`,
        action: () => { onSelectTask(t); onClose(); },
      });
      if (t.status === 'proposed') {
        cmds.push({
          id: `plan:${t.id}`, type: 'action', label: `Plan: ${t.title}`,
          description: 'Start planning', shortcut: 'P',
          action: () => { onPlan(t.id); onClose(); },
        });
      }
      if (t.status === 'planned') {
        cmds.push({
          id: `exec:${t.id}`, type: 'action', label: `Execute: ${t.title}`,
          description: 'Start execution', shortcut: 'E',
          action: () => { onExecute(t.id); onClose(); },
        });
      }
      if (['proposed', 'planned'].includes(t.status)) {
        cmds.push({
          id: `dismiss:${t.id}`, type: 'action', label: `Dismiss: ${t.title}`,
          description: 'Remove task', shortcut: 'D',
          action: () => { onDismiss(t.id); onClose(); },
        });
      }
    });
    return cmds;
  }, [projects, tasks, selectedProjectId, onSelectProject, onSelectTask, onPlan, onExecute, onDismiss, onClose]);

  const filtered = useMemo(() => {
    if (!query) return commands.slice(0, 20);
    const q = query.toLowerCase();
    return commands.filter(c =>
      c.label.toLowerCase().includes(q) || c.description.toLowerCase().includes(q)
    );
  }, [query, commands]);

  // Clamp selectedIndex when filtered changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // Scroll selected into view
  useEffect(() => {
    if (!resultsRef.current) return;
    const el = resultsRef.current.querySelector('.command-palette-item.selected');
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const handleKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(i => (i + 1) % Math.max(filtered.length, 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(i => (i - 1 + filtered.length) % Math.max(filtered.length, 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered[selectedIndex]) {
        filtered[selectedIndex].action();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="command-palette-overlay" onClick={onClose}>
      <div className="command-palette" onClick={e => e.stopPropagation()}>
        <div className="command-palette-input-wrapper">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            className="command-palette-input"
            placeholder="Type a command..."
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <kbd className="command-palette-shortcut">ESC</kbd>
        </div>
        <div className="command-palette-results" ref={resultsRef}>
          {filtered.map((cmd, i) => (
            <button
              key={cmd.id}
              className={`command-palette-item${i === selectedIndex ? ' selected' : ''}`}
              onClick={cmd.action}
              onMouseEnter={() => setSelectedIndex(i)}
            >
              <span className={`command-type-icon command-type-${cmd.type}`}>
                {cmd.type === 'project' ? 'P' : cmd.type === 'task' ? 'T' : 'A'}
              </span>
              <div className="command-item-text">
                <span className="command-item-label">{cmd.label}</span>
                <span className="command-item-description">{cmd.description}</span>
              </div>
              {cmd.shortcut && <kbd className="command-item-shortcut">{cmd.shortcut}</kbd>}
            </button>
          ))}
          {filtered.length === 0 && (
            <div className="command-palette-empty">No results found</div>
          )}
        </div>
        <div className="command-palette-footer">
          <span><kbd>&uarr;&darr;</kbd> navigate</span>
          <span><kbd>&crarr;</kbd> select</span>
          <span><kbd>esc</kbd> close</span>
          <span><kbd>{modKey}+K</kbd> toggle</span>
        </div>
      </div>
    </div>
  );
}

export default memo(CommandPalette);
