import { useState } from 'react';
import { useConfirm } from '../hooks/useConfirm.js';

export default function BulkActionBar({ selectedIds, tasks, onDismissAll, onPlanAll, onChangeEffort, onClearSelection, models }) {
  const count = selectedIds.size;
  const [confirmingDismiss, armDismiss, resetDismiss] = useConfirm();
  const [bulkEffort, setBulkEffort] = useState('medium');
  const [bulkModel, setBulkModel] = useState(models?.[0]?.id || '');

  // Determine what actions are available based on selected tasks
  const selectedTasks = [...selectedIds].map((id) => tasks.find((t) => t.id === id)).filter(Boolean);
  const hasDismissable = selectedTasks.some((t) => ['proposed', 'planned', 'planning', 'queued'].includes(t.status));
  const hasPlannable = selectedTasks.some((t) => t.status === 'proposed');
  const hasEffortEditable = selectedTasks.some((t) => t.status === 'proposed' || t.status === 'planned');

  if (count === 0) return null;

  return (
    <div className="bulk-action-bar">
      <span className="bulk-count">{count} selected</span>
      <button className="bulk-clear" onClick={onClearSelection} title="Clear selection">&times;</button>

      <div className="bulk-divider" />

      {/* Dismiss All */}
      {hasDismissable && (
        <button
          className={`btn btn-dismiss${confirmingDismiss ? ' confirming' : ''}`}
          onClick={() => {
            if (confirmingDismiss) {
              resetDismiss();
              onDismissAll();
            } else {
              armDismiss();
            }
          }}
        >
          {confirmingDismiss ? 'Confirm dismiss?' : 'Dismiss All'}
        </button>
      )}

      {/* Plan All */}
      {hasPlannable && (
        <>
          {models.length > 1 && (
            <select
              className="filter-select"
              value={bulkModel}
              onChange={(e) => setBulkModel(e.target.value)}
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          )}
          <button
            className="btn btn-plan"
            onClick={() => onPlanAll(bulkModel || models[0]?.id)}
          >
            Plan All
          </button>
        </>
      )}

      {/* Set Effort */}
      {hasEffortEditable && (
        <>
          <div className="bulk-divider" />
          <select
            className="filter-select"
            value={bulkEffort}
            onChange={(e) => setBulkEffort(e.target.value)}
          >
            <option value="small">Small</option>
            <option value="medium">Medium</option>
            <option value="large">Large</option>
          </select>
          <button
            className="btn btn-edit"
            onClick={() => onChangeEffort(bulkEffort)}
          >
            Set Effort
          </button>
        </>
      )}
    </div>
  );
}
