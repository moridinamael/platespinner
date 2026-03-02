import { useState, useEffect, useRef } from 'react';
import { useConfirm } from '../hooks/useConfirm.js';
import { formatBytes } from '../utils.js';

function formatElapsed(ms) {
  const seconds = Math.floor(ms / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export default function GenerateBar({
  generatingMap,
  onGenerate,
  statusMessage,
  selectedProjectId,
  projects,
  templates,
  selectedTemplateId,
  onSelectTemplate,
  onCreateTemplate,
  onDeleteTemplate,
  models,
}) {
  const [now, setNow] = useState(Date.now());
  const [showForm, setShowForm] = useState(false);
  const [formName, setFormName] = useState('');
  const [selectedModelId, setSelectedModelId] = useState('claude-opus-4-6');

  const defaultContent = `# Custom Prompt

Write your instructions here. The agent will analyze the project and propose improvements.

## Output Format

You MUST wrap your output in XML tags exactly like this:

<task-proposals>
[
  {
    "title": "Short imperative title",
    "description": "Detailed description of what to change and how",
    "rationale": "Why this matters — impact on quality/performance/security",
    "estimatedEffort": "small|medium|large"
  }
]
</task-proposals>

Do NOT make any code changes. Only propose tasks as structured JSON above.`;

  const [formContent, setFormContent] = useState(defaultContent);
  const [oneOffContent, setOneOffContent] = useState(defaultContent);
  const [showOneOff, setShowOneOff] = useState(false);
  const [confirmingDelete, armDelete, resetDelete] = useConfirm();
  const formRef = useRef(null);
  const oneOffRef = useRef(null);
  const generatingIds = Object.keys(generatingMap);
  const isGenerating = generatingIds.length > 0;

  // Tick every second while anything is generating
  useEffect(() => {
    if (!isGenerating) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [isGenerating]);

  // Close form on outside click
  useEffect(() => {
    if (!showForm && !showOneOff) return;
    function handleClick(e) {
      if (showForm && formRef.current && !formRef.current.contains(e.target)) {
        setShowForm(false);
      }
      if (showOneOff && oneOffRef.current && !oneOffRef.current.contains(e.target)) {
        setShowOneOff(false);
        onSelectTemplate(selectedTemplateId === '__oneoff__' ? 'builtin:pareto-simple' : selectedTemplateId);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showForm, showOneOff]);

  useEffect(() => { resetDelete(); }, [selectedTemplateId]);

  // Is the currently-selected project (or any if "All") already generating?
  const currentlyGenerating = selectedProjectId
    ? !!generatingMap[selectedProjectId]
    : isGenerating;

  const selectedProject = projects.find((p) => p.id === selectedProjectId);
  const label = selectedProject
    ? `Generate for ${selectedProject.name}`
    : 'Generate for All Projects';

  const handleSaveTemplate = () => {
    if (!formName.trim() || !formContent.trim()) return;
    onCreateTemplate({ name: formName.trim(), content: formContent.trim() });
    setFormName('');
    setFormContent(defaultContent);
    setShowForm(false);
  };

  const handleSelectTemplate = (value) => {
    if (value === '__oneoff__') {
      setShowOneOff(true);
      setOneOffContent(defaultContent);
    } else {
      setShowOneOff(false);
    }
    onSelectTemplate(value);
  };

  const handleOneOffGenerate = () => {
    if (!oneOffContent.trim()) return;
    onGenerate(selectedModelId, oneOffContent.trim());
    setShowOneOff(false);
    setOneOffContent(defaultContent);
    onSelectTemplate('builtin:pareto-simple');
  };

  return (
    <div className="generate-bar">
      <div className="generate-controls">
        <select
          className="select template-select"
          value={selectedTemplateId}
          onChange={(e) => handleSelectTemplate(e.target.value)}
        >
          <option value="__oneoff__">One-off Prompt...</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>

        <div className="template-actions">
          <button
            className="btn btn-add-template"
            onClick={() => setShowForm(!showForm)}
            title="Create custom template"
          >
            +
          </button>
          {selectedTemplateId && !selectedTemplateId.startsWith('builtin:') && (
            <button
              className={`btn btn-delete-template${confirmingDelete ? ' confirming' : ''}`}
              onClick={() => {
                if (confirmingDelete) {
                  resetDelete();
                  onDeleteTemplate(selectedTemplateId);
                } else {
                  armDelete();
                }
              }}
              title={confirmingDelete ? 'Click again to confirm' : 'Delete selected template'}
            >
              {confirmingDelete ? 'Sure?' : '\u00d7'}
            </button>
          )}
        </div>

        <select
          className="select model-select"
          value={selectedModelId}
          onChange={(e) => setSelectedModelId(e.target.value)}
        >
          {(models || []).map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>

        <button
          className="btn btn-generate"
          onClick={() => onGenerate(selectedModelId, null)}
          disabled={currentlyGenerating || projects.length === 0 || showOneOff}
        >
          {currentlyGenerating ? (
            <>
              <span className="spinner" />
              Generating...
            </>
          ) : (
            label
          )}
        </button>
      </div>

      {showForm && (
        <div className="template-form" ref={formRef}>
          <input
            className="input"
            placeholder="Template name"
            value={formName}
            onChange={(e) => setFormName(e.target.value)}
            autoFocus
          />
          <textarea
            className="input template-textarea"
            placeholder="Prompt content..."
            value={formContent}
            onChange={(e) => setFormContent(e.target.value)}
            rows={6}
          />
          <div className="template-form-actions">
            <button className="btn btn-primary btn-sm" onClick={handleSaveTemplate}>Save</button>
            <button className="btn btn-sm" onClick={() => setShowForm(false)}>Cancel</button>
          </div>
        </div>
      )}

      {showOneOff && (
        <div className="template-form" ref={oneOffRef}>
          <textarea
            className="input template-textarea"
            placeholder="Enter your one-off prompt..."
            value={oneOffContent}
            onChange={(e) => setOneOffContent(e.target.value)}
            rows={8}
            autoFocus
          />
          <div className="template-form-actions">
            <button
              className="btn btn-generate btn-sm"
              onClick={handleOneOffGenerate}
              disabled={currentlyGenerating || projects.length === 0}
            >
              {label}
            </button>
            <button className="btn btn-sm" onClick={() => {
              setShowOneOff(false);
              onSelectTemplate('builtin:pareto-simple');
            }}>Cancel</button>
          </div>
        </div>
      )}

      {isGenerating && (
        <div className="gen-status-list">
          {generatingIds.map((pid) => {
            const p = projects.find((pr) => pr.id === pid);
            const info = generatingMap[pid];
            const elapsed = formatElapsed(now - info.startedAt);
            return (
              <span key={pid} className="gen-status-item">
                <span className="spinner spinner-sm" />
                <span className="progress-info">
                  {p?.name || 'Unknown'}: {elapsed}
                  {info.bytesReceived > 0 && ` · ${formatBytes(info.bytesReceived)}`}
                </span>
              </span>
            );
          })}
        </div>
      )}

      {statusMessage && <span className="status-message">{statusMessage}</span>}
    </div>
  );
}
