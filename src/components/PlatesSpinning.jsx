import { useMemo } from 'react';

export default function PlatesSpinning({ tasks, generatingMap, setupMap, models }) {
  const counts = useMemo(() => {
    const byType = { generating: 0, planning: 0, executing: 0, setup: 0 };
    const byProvider = { claude: 0, gemini: 0, codex: 0 };

    // Generating: count entries in generatingMap
    byType.generating = Object.keys(generatingMap).length;
    byProvider.claude += byType.generating;

    // Planning and executing tasks
    for (const t of tasks) {
      if (t.status === 'planning') {
        byType.planning++;
        const provider = models.find(m => m.id === t.plannedBy)?.provider || 'claude';
        byProvider[provider] = (byProvider[provider] || 0) + 1;
      }
      if (t.status === 'executing') {
        byType.executing++;
        const provider = models.find(m => m.id === t.executedBy)?.provider || 'claude';
        byProvider[provider] = (byProvider[provider] || 0) + 1;
      }
    }

    // Setup: count entries in setupMap
    byType.setup = Object.keys(setupMap).length;
    byProvider.claude += byType.setup;

    const total = byType.generating + byType.planning + byType.executing + byType.setup;

    return { total, byType, byProvider };
  }, [tasks, generatingMap, setupMap, models]);

  return (
    <div className={`plates-spinning ${counts.total > 0 ? 'plates-active' : 'plates-idle'}`}>
      <div className="plates-icon">🍽️</div>
      {counts.total > 0 && (
        <span className="plates-badge">{counts.total}</span>
      )}
      <div className="plates-tooltip">
        <div className="plates-tooltip-section">
          <div className="plates-tooltip-heading">By Provider</div>
          {counts.byProvider.claude > 0 && (
            <div className="plates-tooltip-row">
              <span className="plates-tooltip-label">Claude</span>
              <span className="plates-tooltip-value">{counts.byProvider.claude}</span>
            </div>
          )}
          {counts.byProvider.gemini > 0 && (
            <div className="plates-tooltip-row">
              <span className="plates-tooltip-label">Gemini</span>
              <span className="plates-tooltip-value">{counts.byProvider.gemini}</span>
            </div>
          )}
          {counts.byProvider.codex > 0 && (
            <div className="plates-tooltip-row">
              <span className="plates-tooltip-label">GPT/Codex</span>
              <span className="plates-tooltip-value">{counts.byProvider.codex}</span>
            </div>
          )}
        </div>
        <div className="plates-tooltip-section">
          <div className="plates-tooltip-heading">By Activity</div>
          {counts.byType.generating > 0 && (
            <div className="plates-tooltip-row">
              <span className="plates-tooltip-label">Generating</span>
              <span className="plates-tooltip-value">{counts.byType.generating}</span>
            </div>
          )}
          {counts.byType.planning > 0 && (
            <div className="plates-tooltip-row">
              <span className="plates-tooltip-label">Planning</span>
              <span className="plates-tooltip-value">{counts.byType.planning}</span>
            </div>
          )}
          {counts.byType.executing > 0 && (
            <div className="plates-tooltip-row">
              <span className="plates-tooltip-label">Executing</span>
              <span className="plates-tooltip-value">{counts.byType.executing}</span>
            </div>
          )}
          {counts.byType.setup > 0 && (
            <div className="plates-tooltip-row">
              <span className="plates-tooltip-label">Setup</span>
              <span className="plates-tooltip-value">{counts.byType.setup}</span>
            </div>
          )}
        </div>
        {counts.total === 0 && (
          <div className="plates-tooltip-row">
            <span className="plates-tooltip-label" style={{ color: 'var(--text-dim)' }}>All idle</span>
          </div>
        )}
      </div>
    </div>
  );
}
