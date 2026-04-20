import { useState, useEffect, useRef, useCallback, memo } from 'react';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { defaultKeymap } from '@codemirror/commands';
import { oneDark } from '@codemirror/theme-one-dark';
import { marked } from 'marked';
import { api } from '../api.js';
import { useConfirm } from '../hooks/useConfirm.js';
import SkillLibraryCard from './SkillLibraryCard.jsx';

marked.setOptions({ breaks: true });

function SkillEditor({ skill, skills, project, onSave, onClose, onDelete, onImport }) {
  const [activeSkill, setActiveSkill] = useState(skill || skills[0] || null);
  const [content, setContent] = useState(skill?.content || skills[0]?.content || '');
  const [name, setName] = useState(skill?.name || skills[0]?.name || '');
  const [dirty, setDirty] = useState(false);
  const [activeTab, setActiveTab] = useState('editor');
  const [dryRunOutput, setDryRunOutput] = useState(null);
  const [dryRunLoading, setDryRunLoading] = useState(false);
  const [librarySkills, setLibrarySkills] = useState([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [previewHtml, setPreviewHtml] = useState('');
  const [statusMsg, setStatusMsg] = useState(null);
  const [confirmingDelete, armDelete, resetDelete] = useConfirm();

  const editorRef = useRef(null);
  const cmViewRef = useRef(null);
  const contentRef = useRef(content);
  const previewTimerRef = useRef(null);

  const isBuiltIn = activeSkill?.id?.startsWith('builtin:');

  // Keep contentRef in sync
  useEffect(() => { contentRef.current = content; }, [content]);

  // Debounced markdown preview
  useEffect(() => {
    clearTimeout(previewTimerRef.current);
    previewTimerRef.current = setTimeout(() => {
      setPreviewHtml(marked.parse(content || ''));
    }, 300);
    return () => clearTimeout(previewTimerRef.current);
  }, [content]);

  // Initialize / reinitialize CodeMirror when active skill changes
  useEffect(() => {
    if (!editorRef.current) return;

    // Destroy existing editor
    if (cmViewRef.current) {
      cmViewRef.current.destroy();
      cmViewRef.current = null;
    }

    const isDark = document.documentElement.getAttribute('data-theme') !== 'light';

    const extensions = [
      markdown(),
      lineNumbers(),
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          const newContent = update.state.doc.toString();
          setContent(newContent);
          setDirty(true);
        }
      }),
      keymap.of([
        ...defaultKeymap,
        {
          key: 'Mod-s',
          run: () => {
            handleSave();
            return true;
          },
        },
      ]),
    ];

    if (isDark) {
      extensions.push(oneDark);
    }

    const startState = EditorState.create({
      doc: content,
      extensions,
    });

    cmViewRef.current = new EditorView({
      state: startState,
      parent: editorRef.current,
    });

    return () => {
      if (cmViewRef.current) {
        cmViewRef.current.destroy();
        cmViewRef.current = null;
      }
    };
  }, [activeSkill?.id]);

  // Switch skill
  const handleSelectSkill = useCallback((sk) => {
    if (dirty && !window.confirm('You have unsaved changes. Discard them?')) {
      return;
    }
    setActiveSkill(sk);
    setContent(sk.content || '');
    setName(sk.name || '');
    setDirty(false);
    setDryRunOutput(null);
    resetDelete();
  }, [dirty, resetDelete]);

  // Save
  const handleSave = useCallback(async () => {
    const currentContent = contentRef.current;
    try {
      await onSave({
        id: isBuiltIn ? null : activeSkill?.id,
        name: name.trim(),
        content: currentContent,
      });
      setDirty(false);
      setStatusMsg('Saved');
      setTimeout(() => setStatusMsg(null), 2000);
    } catch (err) {
      setStatusMsg(`Error: ${err.message}`);
      setTimeout(() => setStatusMsg(null), 3000);
    }
  }, [activeSkill, name, isBuiltIn, onSave]);

  // Clone built-in
  const handleClone = useCallback(async () => {
    try {
      await onSave({
        id: null,
        name: `${name} (Copy)`,
        content,
      });
      setStatusMsg('Cloned as custom skill');
      setTimeout(() => setStatusMsg(null), 2000);
    } catch (err) {
      setStatusMsg(`Error: ${err.message}`);
      setTimeout(() => setStatusMsg(null), 3000);
    }
  }, [name, content, onSave]);

  // Delete
  const handleDelete = useCallback(async () => {
    if (!activeSkill || isBuiltIn) return;
    if (confirmingDelete) {
      await onDelete(activeSkill.id);
      resetDelete();
      // Select first available skill
      const remaining = skills.filter(s => s.id !== activeSkill.id);
      if (remaining.length > 0) {
        handleSelectSkill(remaining[0]);
      } else {
        setActiveSkill(null);
        setContent('');
        setName('');
      }
    } else {
      armDelete();
    }
  }, [activeSkill, isBuiltIn, confirmingDelete, onDelete, skills, handleSelectSkill, armDelete, resetDelete]);

  // New skill
  const handleNew = useCallback(() => {
    if (dirty && !window.confirm('You have unsaved changes. Discard them?')) {
      return;
    }
    setActiveSkill({ id: null, name: '', content: '' });
    setContent(`# New Skill\n\nWrite your instructions here.\n\n## Output Format\n\nYou MUST wrap your output in XML tags exactly like this:\n\n<task-proposals>\n[\n  {\n    "title": "Short imperative title",\n    "description": "Detailed description",\n    "rationale": "Why this matters",\n    "estimatedEffort": "small|medium|large"\n  }\n]\n</task-proposals>\n\nDo NOT make any code changes. Only propose tasks as structured JSON above.`);
    setName('New Skill');
    setDirty(true);
    resetDelete();
  }, [dirty, resetDelete]);

  // Dry run
  const handleDryRun = useCallback(async () => {
    setDryRunLoading(true);
    setActiveTab('dryrun');
    try {
      const result = await api.dryRunSkill({
        content: contentRef.current,
        phase: 'generation',
        projectId: project?.id || null,
      });
      setDryRunOutput(result);
    } catch (err) {
      setDryRunOutput({ prompt: `Error: ${err.message}`, charCount: 0, wordCount: 0, estimatedTokens: 0 });
    } finally {
      setDryRunLoading(false);
    }
  }, [project]);

  // Export
  const handleExport = useCallback(async () => {
    try {
      const ids = activeSkill?.id ? [activeSkill.id] : undefined;
      const bundle = await api.exportSkills(ids);
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `platespinner-skills-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setStatusMsg(`Export error: ${err.message}`);
      setTimeout(() => setStatusMsg(null), 3000);
    }
  }, [activeSkill]);

  // Import
  const handleImportClick = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        const skillsToImport = data.skills || data;
        if (!Array.isArray(skillsToImport)) {
          throw new Error('Invalid format: expected a skills array');
        }
        await onImport(skillsToImport);
        setStatusMsg(`Imported ${skillsToImport.length} skill(s)`);
        setTimeout(() => setStatusMsg(null), 3000);
      } catch (err) {
        setStatusMsg(`Import error: ${err.message}`);
        setTimeout(() => setStatusMsg(null), 3000);
      }
    };
    input.click();
  }, [onImport]);

  // Load library
  useEffect(() => {
    if (activeTab === 'library' && librarySkills.length === 0) {
      setLibraryLoading(true);
      api.getSkillLibrary()
        .then(setLibrarySkills)
        .catch(() => setLibrarySkills([]))
        .finally(() => setLibraryLoading(false));
    }
  }, [activeTab, librarySkills.length]);

  // Install community skill
  const handleInstallLibrarySkill = useCallback(async (libSkill) => {
    try {
      await onSave({ id: null, name: libSkill.name, content: libSkill.content });
      setStatusMsg(`Installed "${libSkill.name}"`);
      setTimeout(() => setStatusMsg(null), 2000);
    } catch (err) {
      setStatusMsg(`Error: ${err.message}`);
      setTimeout(() => setStatusMsg(null), 3000);
    }
  }, [onSave]);

  // Close with unsaved check
  const handleClose = useCallback(() => {
    if (dirty && !window.confirm('You have unsaved changes. Discard them?')) {
      return;
    }
    onClose();
  }, [dirty, onClose]);

  // Escape key to close
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') handleClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [handleClose]);

  // Check which library skills are already installed
  const installedNames = new Set(skills.map(s => s.name));

  return (
    <div className="skill-editor-overlay" onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}>
      <div className="skill-editor">
        {/* Header */}
        <div className="skill-editor-header">
          <h2>Skill Editor</h2>
          <div className="skill-editor-header-actions">
            {statusMsg && <span className="skill-editor-status">{statusMsg}</span>}
            <button className="btn btn-sm" onClick={handleClose} title="Close">&times;</button>
          </div>
        </div>

        <div className="skill-editor-body">
          {/* Sidebar */}
          <div className="skill-editor-sidebar">
            <div className="skill-list">
              {skills.map((sk) => (
                <div
                  key={sk.id}
                  className={`skill-list-item${activeSkill?.id === sk.id ? ' active' : ''}${sk.id?.startsWith('builtin:') ? ' builtin' : ''}`}
                  onClick={() => handleSelectSkill(sk)}
                  title={sk.name}
                >
                  <span className="skill-list-name">{sk.name}</span>
                  {sk.id?.startsWith('builtin:') && <span className="skill-badge">built-in</span>}
                </div>
              ))}
            </div>
            <div className="skill-sidebar-actions">
              <button className="btn btn-sm btn-primary" onClick={handleNew}>+ New</button>
              <button className="btn btn-sm" onClick={handleImportClick}>Import</button>
            </div>
          </div>

          {/* Main area */}
          <div className="skill-editor-main">
            {/* Tabs */}
            <div className="skill-editor-tabs">
              <button
                className={`skill-editor-tab${activeTab === 'editor' ? ' active' : ''}`}
                onClick={() => setActiveTab('editor')}
              >
                Editor
              </button>
              <button
                className={`skill-editor-tab${activeTab === 'preview' ? ' active' : ''}`}
                onClick={() => setActiveTab('preview')}
              >
                Preview
              </button>
              <button
                className={`skill-editor-tab${activeTab === 'dryrun' ? ' active' : ''}`}
                onClick={handleDryRun}
              >
                Dry Run
              </button>
              <button
                className={`skill-editor-tab${activeTab === 'library' ? ' active' : ''}`}
                onClick={() => setActiveTab('library')}
              >
                Library
              </button>
            </div>

            {/* Name input */}
            {activeTab !== 'library' && (
              <div className="skill-editor-name-row">
                <label>Name:</label>
                <input
                  className="input"
                  value={name}
                  onChange={(e) => { setName(e.target.value); setDirty(true); }}
                  disabled={isBuiltIn}
                  placeholder="Skill name"
                />
              </div>
            )}

            {/* Content area */}
            <div className="skill-editor-content">
              {activeTab === 'editor' && (
                <div className="skill-editor-split">
                  <div className="skill-editor-code" ref={editorRef} />
                  <div className="skill-editor-preview">
                    <div
                      className="skill-preview"
                      dangerouslySetInnerHTML={{ __html: previewHtml }}
                    />
                    {/* Context variables panel */}
                    <div className="skill-context-vars">
                      <h4>Context Variables</h4>
                      <div className="skill-var-list">
                        <div className="skill-var"><code>{'${projectPath}'}</code> <span>{project?.path || '/example/project'}</span></div>
                        <div className="skill-var"><code>{'${projectName}'}</code> <span>{project?.name || 'Example Project'}</span></div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {activeTab === 'preview' && (
                <div className="skill-editor-preview-full">
                  <div
                    className="skill-preview"
                    dangerouslySetInnerHTML={{ __html: previewHtml }}
                  />
                </div>
              )}

              {activeTab === 'dryrun' && (
                <div className="skill-dryrun-container">
                  {dryRunLoading ? (
                    <div className="skill-dryrun-loading">
                      <span className="spinner" /> Generating dry run...
                    </div>
                  ) : dryRunOutput ? (
                    <>
                      <div className="skill-dryrun-stats">
                        <span>{dryRunOutput.charCount?.toLocaleString()} chars</span>
                        <span>{dryRunOutput.wordCount?.toLocaleString()} words</span>
                        <span>~{dryRunOutput.estimatedTokens?.toLocaleString()} tokens</span>
                      </div>
                      <pre className="skill-dryrun-output">{dryRunOutput.prompt}</pre>
                    </>
                  ) : (
                    <div className="skill-dryrun-empty">
                      Click "Dry Run" to see the full assembled prompt{project ? ` for ${project.name}` : ''}.
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'library' && (
                <div className="skill-library-container">
                  {libraryLoading ? (
                    <div className="skill-dryrun-loading"><span className="spinner" /> Loading library...</div>
                  ) : librarySkills.length === 0 ? (
                    <div className="skill-dryrun-empty">No community skills available yet.</div>
                  ) : (
                    <div className="skill-library-grid">
                      {librarySkills.map((ls, i) => (
                        <SkillLibraryCard
                          key={i}
                          skill={ls}
                          onInstall={handleInstallLibrarySkill}
                          installed={installedNames.has(ls.name)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Action bar */}
            {activeTab !== 'library' && (
              <div className="skill-editor-actions">
                {isBuiltIn ? (
                  <button className="btn btn-primary btn-sm" onClick={handleClone}>Clone as Custom</button>
                ) : (
                  <button className="btn btn-primary btn-sm" onClick={handleSave} disabled={!dirty && activeSkill?.id}>
                    {activeSkill?.id ? 'Save' : 'Create'}
                  </button>
                )}
                <button className="btn btn-sm" onClick={handleExport}>Export</button>
                {!isBuiltIn && activeSkill?.id && (
                  <button
                    className={`btn btn-sm btn-danger${confirmingDelete ? ' confirming' : ''}`}
                    onClick={handleDelete}
                  >
                    {confirmingDelete ? 'Confirm Delete?' : 'Delete'}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default memo(SkillEditor);
